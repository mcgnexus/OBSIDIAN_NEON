import { Operation, NoteState, Revision } from './types';

export interface VaultIO {
  listMarkdown(): Promise<string[]>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  trash(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  hash(content: string): Promise<string>;
}

export interface StateStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface RemoteStoreLike {
  apply(op: Operation, expected?: Revision): Promise<{ revision: Revision }>;
  readChanges(cursor: Revision, limit?: number): Promise<NoteState[]>;
  getManifest(): Promise<{ protocol: number; vault: string; revision: Revision; notes: Array<{ path: string; hash: string | null; deleted: boolean; revision: Revision }> }>;
  getNote(path: string): Promise<NoteState | null>;
  listHistory(path: string, before?: Revision): Promise<Array<{ path: string; hash: string | null; deleted: boolean; revision: Revision }>>;
  getRevision(path: string, revision: Revision): Promise<NoteState | null>;
  cleanup(): Promise<void>;
}

export interface SyncEngineOptions {
  vault: VaultIO;
  state: StateStore;
  remote: RemoteStoreLike;
  deviceId: string;
  onStatus?: (status: string) => void;
  onConflict?: (paths: string[]) => void;
}

export class SyncEngine {
  private running = false;
  private paused = false;
  constructor(private readonly options: SyncEngineOptions) {}

  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }
  isPaused(): boolean { return this.paused; }

  async syncOnce(): Promise<void> {
    if (this.running || this.paused) return;
    this.running = true;
    try {
      const cursorBefore = (await this.options.state.get<Revision>('cursor')) ?? '0';
      const pending = (await this.options.state.get<Operation[]>('queue')) ?? [];
      const baseHashes = (await this.options.state.get<Record<string, string>>('baseHashes')) ?? {};
      const dirty = new Set(pending.map(o => o.path).concat(pending.filter(o => o.destination).map(o => o.destination!)));

      const bootstrapped = (await this.options.state.get<boolean>('bootstrapped')) ?? false;
      if (!bootstrapped) {
        await this.bootstrap(cursorBefore, baseHashes);
        await this.options.state.set('bootstrapped', true);
        this.options.onStatus?.('Sincronizacion inicial completada');
        this.running = false;
        return;
      }

      const pushedIds = new Set<string>();
      for (const op of pending) {
        try {
          if (op.kind === 'put') {
            if (!(await this.options.vault.exists(op.path))) {
              op.kind = 'delete';
              delete op.content;
            } else {
              op.content = await this.options.vault.read(op.path);
            }
          } else if (op.kind === 'rename' && op.destination) {
            if (await this.options.vault.exists(op.destination)) op.content = await this.options.vault.read(op.destination);
          }
          await this.options.remote.apply(op);
          pushedIds.add(op.id);
        } catch {
          break;
        }
      }
      const currentQueue = (await this.options.state.get<Operation[]>('queue')) ?? [];
      await this.options.state.set('queue', currentQueue.filter(o => !pushedIds.has(o.id)));

      let cursor = cursorBefore;
      const changes = await this.options.remote.readChanges(cursor, 100);
      const conflicts: string[] = [];
      for (const change of changes) {
        if (dirty.has(change.path)) {
          conflicts.push(change.path);
          break;
        }
        if (change.deleted) {
          if (await this.options.vault.exists(change.path)) await this.options.vault.trash(change.path);
          delete baseHashes[change.path];
        } else if (change.content !== null) {
          const localExists = await this.options.vault.exists(change.path);
          const local = localExists ? await this.options.vault.read(change.path) : null;
          const localHash = local === null ? null : await this.options.vault.hash(local);
          if (localExists && baseHashes[change.path] && baseHashes[change.path] !== localHash) {
            conflicts.push(change.path);
            break;
          }
          if (local === null || localHash !== change.hash) {
            await this.options.vault.write(change.path, change.content);
          }
          baseHashes[change.path] = change.hash ?? '';
        }
        cursor = change.revision;
      }
      if (conflicts.length) this.options.onConflict?.(conflicts);
      await this.options.state.set('cursor', cursor);
      await this.options.state.set('baseHashes', baseHashes);
      await this.options.remote.cleanup().catch(() => undefined);
      this.options.onStatus?.('Sincronizado');
    } catch (error) {
      this.options.onStatus?.(error instanceof Error ? error.message : 'Error de sincronizacion');
      throw error;
    } finally {
      this.running = false;
    }
  }

  private async bootstrap(cursorBefore: Revision, baseHashes: Record<string, string>): Promise<void> {
    const manifest = await this.options.remote.getManifest();
    const remotePaths = new Set(manifest.notes.map(n => n.path));
    const localPaths = await this.options.vault.listMarkdown();
    const localSet = new Set(localPaths);
    const conflicts: string[] = [];

    for (const p of localPaths) {
      if (!remotePaths.has(p)) {
        const content = await this.options.vault.read(p);
        this.enqueue({ id: crypto.randomUUID(), device: this.options.deviceId, kind: 'put', path: p, content });
      }
    }
    for (const n of manifest.notes) {
      if (!localSet.has(n.path) && !n.deleted) {
        const note = await this.options.remote.getNote(n.path);
        if (note && note.content !== null) {
          await this.options.vault.write(n.path, note.content);
          baseHashes[n.path] = note.hash ?? '';
        }
      }
    }
    for (const n of manifest.notes) {
      if (localSet.has(n.path) && !n.deleted) {
        const local = await this.options.vault.read(n.path);
        const localHash = await this.options.vault.hash(local);
        if (n.hash !== null && n.hash !== localHash) conflicts.push(n.path);
      }
    }
    if (conflicts.length) this.options.onConflict?.(conflicts);
    await this.options.state.set('cursor', manifest.revision);
    await this.options.state.set('baseHashes', baseHashes);
    const queued = (await this.options.state.get<Operation[]>('queue')) ?? [];
    const pushedIds = new Set<string>();
    for (const op of queued) {
      try {
        if (op.kind === 'put' && (await this.options.vault.exists(op.path))) {
          op.content = await this.options.vault.read(op.path);
        }
        await this.options.remote.apply(op);
        pushedIds.add(op.id);
      } catch {
        break;
      }
    }
    const currentQueue = (await this.options.state.get<Operation[]>('queue')) ?? [];
    await this.options.state.set('queue', currentQueue.filter(o => !pushedIds.has(o.id)));
  }

  async enqueue(operation: Operation): Promise<void> {
    const queue = (await this.options.state.get<Operation[]>('queue')) ?? [];
    queue.push(operation);
    await this.options.state.set('queue', queue);
  }
}
