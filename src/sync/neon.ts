import { neon } from '@neondatabase/serverless';
import { Manifest, ManifestNote, NoteState, Operation, Receipt, RemoteStore, SyncError, PROTOCOL } from './types';

export type Query = (text: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

export function connectionUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.username || !url.password ||
      !/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(url.hostname) ||
      (url.port && url.port !== '5432') || url.pathname.length < 2) throw new Error();
    return url.toString();
  } catch { throw new SyncError('Conexion no valida. Usa la URL PostgreSQL de un rol restringido de Neon.'); }
}

// Never surface server messages: they may contain credentials, SQL parameters or note bodies.
export function safeError(error: unknown): SyncError {
  if (error instanceof SyncError) return error;
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  if (code.startsWith('28') || code === '42501') return new SyncError('Acceso denegado. Revisa el rol y sus permisos.');
  if (code === 'P0002') return new SyncError('La comparacion ha cambiado. Vuelve a comparar antes de confirmar.');
  if (code === '22023' || code === '23505' || code === 'P0001') return new SyncError('Operacion rechazada: revisa rutas, limites y version del esquema.');
  if (code === '42883' || code === '42P01') return new SyncError('Esquema ausente o incompatible. Aplica la migracion fuera del plugin.');
  return new SyncError('No se pudo conectar con Neon. Los cambios pendientes se conservan.', true);
}

export function createNeonStore(url: string): NeonStore {
  // Prefer Obsidian's requestUrl when available: it bypasses WebView CORS and
  // uses the native HTTP stack, which is required on mobile.
  const obsidianFetch = (typeof (globalThis as any).requestUrl === 'function')
    ? async (input: any, init?: any) => {
        const r = await (globalThis as any).requestUrl({
          url: typeof input === 'string' ? input : input.url,
          method: init?.method ?? 'GET',
          headers: init?.headers,
          body: init?.body,
          throw: false,
        });
        return new Response(r.arrayBuffer, { status: r.status, headers: r.headers });
      }
    : undefined;
  if (obsidianFetch) {
    const cfg = (globalThis as any).neonConfig || {};
    cfg.fetchFunction = obsidianFetch;
    (globalThis as any).neonConfig = cfg;
  }
  const sql = neon(connectionUrl(url), { disableWarningInBrowsers: true });
  return new NeonStore(async (text, params) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      return await sql.query(text, params, { fetchOptions: { signal: controller.signal } }) as Record<string, unknown>[];
    } finally { clearTimeout(timeout); }
  });
}

export class NeonStore implements RemoteStore {
  constructor(private readonly query: Query) {}
  private async call<T>(sql: string, params: unknown[]): Promise<T> {
    const maxAttempts = 5;
    let attempt = 0;
    let lastError: unknown;
    while (attempt < maxAttempts) {
      try {
        const rows = await this.query(sql, params);
        if (!rows[0] || !('result' in rows[0])) throw new SyncError('Respuesta de protocolo no valida.');
        return rows[0].result as T;
      } catch (error) {
        const classified = safeError(error);
        lastError = classified;
        if (!classified.retryable || attempt === maxAttempts - 1) throw classified;
        const delay = Math.min(60_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
        await new Promise(r => setTimeout(r, delay));
        attempt++;
      }
    }
    throw safeError(lastError);
  }
  async getManifest(): Promise<Manifest> {
    const manifest = await this.call<Manifest>('select neon_sync.manifest() as result', []);
    if (manifest.protocol !== PROTOCOL) throw new SyncError('Version de protocolo incompatible. Sincronizacion detenida.');
    return manifest;
  }
  apply(operation: Operation, expectedRevision?: string): Promise<Receipt> {
    return this.call('select neon_sync.apply($1::jsonb, $2::bigint) as result', [JSON.stringify(operation), expectedRevision ?? null]);
  }
  readChanges(cursor: string, limit = 100): Promise<NoteState[]> {
    return this.call('select neon_sync.changes($1::bigint, $2::integer) as result', [cursor, limit]);
  }
  getNote(path: string): Promise<NoteState | null> {
    return this.call('select neon_sync.note($1::text) as result', [path]);
  }
  listHistory(path: string, before?: string): Promise<ManifestNote[]> {
    return this.call('select neon_sync.history($1::text, $2::bigint) as result', [path, before ?? null]);
  }
  getRevision(path: string, revision: string): Promise<NoteState | null> {
    return this.call('select neon_sync.revision($1::text, $2::bigint) as result', [path, revision]);
  }
  async cleanup(): Promise<void> { await this.call('select neon_sync.cleanup() as result', []); }
}
