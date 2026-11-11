import { describe, it, expect } from 'vitest';
import { connectionUrl, safeError, NeonStore } from '../src/sync/neon';

describe('Neon HTTPS boundary', () => {
  it('only accepts Neon Postgres endpoints and masks raw server errors', () => {
    expect(() => connectionUrl('postgres://user:secret@evil.test/db')).toThrow();
    expect(connectionUrl('postgresql://u:p@ep-demo.eu-central-1.aws.neon.tech/db')).toContain('neon.tech');
    const error = safeError(new Error('password=secret note=private postgresql://u:p@host/db'));
    expect(error.message).not.toMatch(/secret|private|postgresql/);
  });
  it('uses parameters, never interpolates a path into SQL', async () => {
    const calls: { text: string; params: unknown[] }[] = [];
    const store = new NeonStore(async (text, params) => {
      calls.push({ text, params });
      return [{ result: [] }];
    });
    await store.listHistory("x'; DROP TABLE notes;--.md");
    expect(calls[0]?.text).not.toContain('DROP');
    expect(calls[0]?.params).toContain("x'; DROP TABLE notes;--.md");
  });
  it('classifies authentication failures as non-retryable without exposing detail', () => {
    const error = safeError({ code: '28P01', message: 'password is secret' });
    expect(error.retryable).toBe(false);
    expect(error.message).not.toContain('secret');
  });
});
