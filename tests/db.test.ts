import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { NeonStore } from '../src/sync/neon';
import { Operation } from '../src/sync/types';

let db: PGlite;
let store: NeonStore;
const vault = '11111111-1111-4111-8111-111111111111';
const device = '22222222-2222-4222-8222-222222222222';
const op = (path: string, content: string, id = crypto.randomUUID()): Operation => ({ id, device, kind: 'put', path, content });
beforeAll(async () => {
  db = new PGlite();
  await db.exec(await readFile('migrations/001_sync.sql', 'utf8'));
  // Tests run as the default superuser 'postgres', which is mapped to the vault.
  // This avoids PGlite's inability to switch sessions back to a superuser.
  await db.exec(`insert into neon_sync.vaults(id) values ('${vault}');
    insert into neon_sync.device_access(role_name, vault_id) values ('postgres', '${vault}');`);
  store = new NeonStore(async (text, params) => (await db.query<Record<string, unknown>>(text, params)).rows);
}, 30_000);
afterAll(async () => { await db?.close(); });

it('authorizes connection identity and returns a versioned manifest', async () => {
  const m = await store.getManifest();
  expect(m.vault).toBe(vault);
  expect(m.protocol).toBe(1);
});
it('accepts last-arrival writes and retries without reapplying an old operation', async () => {
  const first = op('a.md', 'first');
  const r = await store.apply(first);
  await store.apply(op('a.md', 'second'));
  expect(await store.apply(first)).toEqual(r);
  expect((await store.getNote('a.md'))?.content).toBe('second');
  await expect(store.apply({ ...first, content: 'tampered' })).rejects.toThrow();
});
it('renames atomically, preserving overwritten destination and source history', async () => {
  await store.apply(op('old.md', 'old'));
  await store.apply(op('dest.md', 'destination'));
  await store.apply({ id: crypto.randomUUID(), device, kind: 'rename', path: 'old.md', destination: 'dest.md', content: 'old' });
  expect((await store.getNote('old.md'))?.deleted).toBe(true);
  expect((await store.getNote('dest.md'))?.content).toBe('old');
  const h = await store.listHistory('dest.md');
  expect(h.length).toBe(2);
  expect((await store.getRevision('dest.md', h[1]!.revision))?.content).toBe('destination');
});
it('validates bootstrap preconditions under the write lock and rejects unsafe paths', async () => {
  const m = await store.getManifest();
  const a = op('precondition.md', 'yes');
  const r = await store.apply(a, m.revision);
  expect(await store.apply(a, m.revision)).toEqual(r);
  await expect(store.apply(op('stale.md', 'no'), m.revision)).rejects.toThrow(/comparacion/);
  for (const path of ['../a.md', '.obsidian/x.md', 'CON.md', 'a\\b.md', 'C:/x.md', 'x.txt', 'a./x.md']) {
    await expect(store.apply(op(path, 'no'))).rejects.toThrow();
  }
  expect(await store.getNote('stale.md')).toBe(null);
});
it('keeps bigint cursors exact and paginates ordered changes', async () => {
  const r = await store.apply(op('big.md', 'big'));
  const rows = await store.readChanges(r.revision, 1);
  expect(rows).toHaveLength(0);
  const r2 = await store.apply(op('big2.md', 'big2'));
  const rows2 = await store.readChanges(r.revision, 10);
  expect(rows2).toHaveLength(1);
  expect(rows2[0]?.revision).toBe(r2.revision);
});
it('retains previous content after deleting a note', async () => {
  const r = await store.apply(op('ancient.md', 'recover me'));
  await store.apply({ id: crypto.randomUUID(), device, kind: 'delete', path: 'ancient.md' });
  await store.cleanup();
  expect((await store.getRevision('ancient.md', r.revision))?.content).toBe('recover me');
  expect((await store.getNote('ancient.md'))?.deleted).toBe(true);
});
it('denies access when no vault mapping exists', async () => {
  await db.exec("delete from neon_sync.device_access where role_name='postgres';");
  await expect(store.getManifest()).rejects.toThrow(/Acceso denegado/);
  await db.exec("insert into neon_sync.device_access(role_name, vault_id) values ('postgres', '" + vault + "');");
});
