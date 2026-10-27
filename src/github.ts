export type Head = { notModified: true } | { notModified: false; sha: string | null; etag: string }; // sha null = empty repo

export interface GitHubApi {
  getHead(etag: string | null): Promise<Head>;
  getTree(commitSha: string): Promise<Map<string, string>>; // repo path -> blob sha, blobs only
  getBlobText(blobSha: string): Promise<string>;
  putFile(path: string, text: string, prevBlobSha: string | null, message: string): Promise<{ blobSha: string; commitSha: string }>;
  deleteFile(path: string, prevBlobSha: string, message: string): Promise<{ commitSha: string }>;
  commitBatch(baseCommit: string, changes: { path: string; text: string | null }[], message: string): Promise<{ commitSha: string }>;
  getTarball(commitSha: string): Promise<Map<string, string>>; // repo path -> text
  fileHistoryBlobShas(path: string, limit: number): Promise<string[]>;
  repoSizeKb(): Promise<number>;
}
