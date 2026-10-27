import { AuthError, type Http, type HttpResponse, HttpError, RateLimitError, ShaConflictError } from "./http";
import { gunzip, parseTar } from "./tar";
import { b64encode } from "./util";

export type Head = { notModified: true } | { notModified: false; sha: string | null; etag: string }; // sha null = empty repo

export interface BatchChange { path: string; text: string | null | (() => Promise<string>) }
/** Characters of file content per POST /git/trees; bigger batches chain several trees into one commit. */
export const BATCH_CHUNK_CHARS = 20 * 1024 * 1024;

export interface GitHubApi {
  getHead(etag: string | null): Promise<Head>;
  getTree(commitSha: string): Promise<Map<string, string>>; // repo path -> blob sha, blobs only
  getBlobText(blobSha: string): Promise<string>;
  putFile(path: string, text: string, prevBlobSha: string | null, message: string): Promise<{ blobSha: string; commitSha: string }>;
  deleteFile(path: string, prevBlobSha: string, message: string): Promise<{ commitSha: string }>;
  /** text null = delete; a function is called when its chunk is sent, so the whole batch is never in memory at once. */
  commitBatch(baseCommit: string, changes: BatchChange[], message: string): Promise<{ commitSha: string }>;
  getTarball(commitSha: string): Promise<Map<string, string>>; // repo path -> text
  fileHistoryBlobShas(path: string, limit: number): Promise<string[]>;
  repoSizeKb(): Promise<number>;
}

const hdr = (r: HttpResponse, name: string): string | undefined => {
  for (const k in r.headers) if (k.toLowerCase() === name) return r.headers[k];
};
const enc = (path: string): string => path.split("/").map(encodeURIComponent).join("/");

export class RestGitHub implements GitHubApi {
  private base: string;
  constructor(private http: Http, owner: string, repo: string, private token: () => string, private chunkChars = BATCH_CHUNK_CHARS) {
    this.base = `https://api.github.com/repos/${owner}/${repo}`;
  }

  /** Throws mapped errors for status >= 400 unless the status is in `allow`; `conflict` statuses -> ShaConflictError. */
  private async req(method: string, path: string, o: { body?: unknown; headers?: Record<string, string>; allow?: number[]; conflict?: number[]; conflictPath?: string } = {}): Promise<HttpResponse> {
    const r = await this.http({
      url: this.base + path,
      method,
      headers: {
        Authorization: `Bearer ${this.token()}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(o.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...o.headers,
      },
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    });
    if (r.status < 400 || o.allow?.includes(r.status)) return r;
    if (o.conflict?.includes(r.status)) throw new ShaConflictError(o.conflictPath);
    if (r.status === 401) throw new AuthError();
    if (r.status === 403 || r.status === 429) {
      const ra = hdr(r, "retry-after");
      const reset = Number(hdr(r, "x-ratelimit-reset")) * 1000;
      if (hdr(r, "x-ratelimit-remaining") === "0") {
        throw new RateLimitError(Number.isFinite(reset) ? reset : Date.now() + (ra !== undefined && Number.isFinite(Number(ra)) ? Number(ra) * 1000 : 60_000));
      }
      if (ra !== undefined) throw new RateLimitError(Date.now() + Number(ra) * 1000);
      // secondary rate limit: no headers to go by, so back off a minute instead of hammering every few seconds
      if (/rate limit|abuse/i.test(r.text)) throw new RateLimitError(Date.now() + 60_000);
    }
    throw new HttpError(r.status);
  }

  async getHead(etag: string | null): Promise<Head> {
    const r = await this.req("GET", "/git/ref/heads/main", { headers: etag ? { "If-None-Match": etag } : {}, allow: [304, 404, 409] });
    if (r.status === 304) return { notModified: true };
    if (r.status === 404 || r.status === 409) return { notModified: false, sha: null, etag: "" };
    return { notModified: false, sha: JSON.parse(r.text).object.sha, etag: hdr(r, "etag") ?? "" };
  }

  async getTree(commitSha: string): Promise<Map<string, string>> {
    const j = JSON.parse((await this.req("GET", `/git/trees/${commitSha}?recursive=1`)).text);
    if (j.truncated) throw new Error("tree truncated");
    return new Map(j.tree.filter((e: { type: string }) => e.type === "blob").map((e: { path: string; sha: string }) => [e.path, e.sha]));
  }

  async getBlobText(blobSha: string): Promise<string> {
    return (await this.req("GET", `/git/blobs/${blobSha}`, { headers: { Accept: "application/vnd.github.raw+json" } })).text;
  }

  async putFile(path: string, text: string, prevBlobSha: string | null, message: string) {
    const body = { message, content: b64encode(new TextEncoder().encode(text)), branch: "main", ...(prevBlobSha ? { sha: prevBlobSha } : {}) };
    const j = JSON.parse((await this.req("PUT", `/contents/${enc(path)}`, { body, conflict: [409, 422], conflictPath: path })).text);
    return { blobSha: j.content.sha as string, commitSha: j.commit.sha as string };
  }

  async deleteFile(path: string, prevBlobSha: string, message: string) {
    const body = { message, sha: prevBlobSha, branch: "main" };
    const j = JSON.parse((await this.req("DELETE", `/contents/${enc(path)}`, { body, conflict: [409, 422], conflictPath: path })).text);
    return { commitSha: j.commit.sha as string };
  }

  async commitBatch(baseCommit: string, changes: BatchChange[], message: string) {
    const post = async (p: string, body: unknown) => JSON.parse((await this.req("POST", p, { body })).text);
    let treeSha = JSON.parse((await this.req("GET", `/git/commits/${baseCommit}`)).text).tree.sha as string;
    let tree: object[] = [], size = 0;
    const flush = async () => { treeSha = (await post("/git/trees", { base_tree: treeSha, tree })).sha; tree = []; size = 0; };
    for (const ch of changes) {
      const text = typeof ch.text === "function" ? await ch.text() : ch.text;
      if (tree.length && text !== null && size + text.length > this.chunkChars) await flush();
      tree.push({ path: ch.path, mode: "100644", type: "blob", ...(text === null ? { sha: null } : { content: text }) });
      size += text?.length ?? 0;
    }
    await flush();
    const c = await post("/git/commits", { message, tree: treeSha, parents: [baseCommit] });
    await this.req("PATCH", "/git/refs/heads/main", { body: { sha: c.sha, force: false }, conflict: [422] });
    return { commitSha: c.sha as string };
  }

  async getTarball(commitSha: string): Promise<Map<string, string>> {
    const r = await this.req("GET", `/tarball/${commitSha}`);
    const dec = new TextDecoder();
    const out = new Map<string, string>();
    for (const [name, bytes] of parseTar(await gunzip(r.arrayBuffer))) out.set(name.slice(name.indexOf("/") + 1), dec.decode(bytes));
    return out;
  }

  async fileHistoryBlobShas(path: string, limit: number): Promise<string[]> {
    const commits = JSON.parse((await this.req("GET", `/commits?path=${encodeURIComponent(path)}&per_page=${limit}`)).text);
    const out: string[] = [];
    for (const c of commits) {
      const r = await this.req("GET", `/contents/${enc(path)}?ref=${c.sha}`, { allow: [404] });
      if (r.status !== 404) out.push(JSON.parse(r.text).sha);
    }
    return out;
  }

  async repoSizeKb(): Promise<number> {
    return JSON.parse((await this.req("GET", "")).text).size;
  }
}
