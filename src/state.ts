export interface FileRecord { token: string; blobSha: string; localHash: string; mtime: number; size: number }
export interface SyncState {
  version: 1; headSha: string | null; refEtag: string | null;
  files: Record<string, FileRecord>; // key: NFC path
  // Optional so older v1 states still load; missing filter just forces one full tree fetch.
  filter?: string; // fingerprint of the settings that decide what is skipped
  rebinding?: boolean; // rebuilding state without one: local files may be old remote versions
  configSha?: string; // blob sha of gitvault.json at first sync: a new one means the vault was re-created
  skipped?: Record<string, { blobSha: string; path: string }>; // token -> remote file this device does not sync
}
export interface StateStore { load(): Promise<SyncState | null>; save(s: SyncState): Promise<void> }
export const emptyState = (): SyncState => ({ version: 1, headSha: null, refEtag: null, files: {} });
