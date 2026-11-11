export const PROTOCOL = 1;
export const MAX_NOTE_BYTES = 1024 * 1024;
export type Revision = string;
export interface NoteState {
  path: string; content: string | null; hash: string | null; deleted: boolean;
  revision: Revision; device: string; updatedAt: string;
}
export type ManifestNote = Omit<NoteState, 'content'>;
export interface Manifest { protocol: number; vault: string; revision: Revision; notes: ManifestNote[] }
export interface Operation {
  id: string; device: string; kind: 'put' | 'delete' | 'rename'; path: string;
  content?: string; destination?: string;
}
export interface Receipt { revision: Revision }
export interface RemoteStore {
  apply(operation: Operation, expectedRevision?: Revision): Promise<Receipt>;
  readChanges(cursor: Revision, limit?: number): Promise<NoteState[]>;
  getManifest(): Promise<Manifest>;
  getNote(path: string): Promise<NoteState | null>;
  listHistory(path: string, before?: Revision): Promise<ManifestNote[]>;
  getRevision(path: string, revision: Revision): Promise<NoteState | null>;
  cleanup(): Promise<void>;
}
export class SyncError extends Error {
  constructor(message: string, public readonly retryable = false) { super(message); }
}
export async function hash(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
