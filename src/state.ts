export interface FileRecord { token: string; blobSha: string; localHash: string; mtime: number; size: number }
export interface SyncState { version: 1; headSha: string | null; refEtag: string | null; files: Record<string, FileRecord> } // key: NFC path
export interface StateStore { load(): Promise<SyncState | null>; save(s: SyncState): Promise<void> }
export const emptyState = (): SyncState => ({ version: 1, headSha: null, refEtag: null, files: {} });
