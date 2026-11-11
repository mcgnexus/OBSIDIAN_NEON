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
  get<T>(key: string): T | null;
  set<T>(key: string, value: T): void;
  remove(key: string): void;
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
      const cursor = this.options.state.get<Revision>('cursor') ?? '0';
      const pending = this.options.state.get<Operation[]>('queue') ?? [];
      // Push local changes first, in order.
      const newQueue: Operation[] = [];
      for (const op of pending) {
        try {
          const receipt = await this.options.remote.apply(op);
          this.options.state.set('cursor', receipt.revision);
        } catch (error) {
          newQueue.push(op);
          throw error;
        }
      }
      this.options.state.set('queue', newQueue);
      // Pull remote changes.
      let currentCursor = this.options.state.get<Revision>('cursor') ?? '0';
      const changes = await this.options.remote.readChanges(currentCursor, 100);
      for (const change of changes) {
        if (change.deleted) {
          if (await this.options.vault.exists(change.path)) await this.options.vault.trash(change.path);
        } else if (change.content !== null) {
          const local = await this.options.vault.exists(change.path) ? await this.options.vault.read(change.path) : null;
          if (local === null || await this.options.vault.hash(local) !== (await this.options.vault.hash(change.content))) {
            await this.options.vault.write(change.path, change.content);
          }
        }
        currentCursor = change.revision;
      }
      this.options.state.set('cursor', currentCursor);
      await this.options.remote.cleanup().catch(() => undefined);
      this.options.onStatus?.('Sincronizado');
    } catch (error) {
      this.options.onStatus?.(error instanceof Error ? error.message : 'Error de sincronizacion');
      throw error;
    } finally {
      this.running = false;
    }
  }

  enqueue(operation: Operation): void {
    const queue = this.options.state.get<Operation[]>('queue') ?? [];
    queue.push(operation);
    this.options.state.set('queue', queue);
  }
}
