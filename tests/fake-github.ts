import type { GitHubApi, Head } from "../src/github";
import { ShaConflictError } from "../src/http";
import { gitBlobSha } from "../src/util";

export interface FakeCommit { sha: string; parent: string | null; message: string; tree: Map<string, string> }

interface Store {
  commits: FakeCommit[];
  blobs: Map<string, string>;
  failures: Map<string, Error[]>;
  onBeforeWrite?: () => void | Promise<void>;
  writes: number;
  reads: number;
}

/** In-memory GitHub: linear history on main. client() = per-device view over the same store. */
export class FakeGitHub implements GitHubApi {
  writes = 0;
  reads = 0;
  private s: Store;

  constructor(store?: Store) {
    this.s = store ?? { commits: [], blobs: new Map(), failures: new Map(), writes: 0, reads: 0 };
  }

  client(): FakeGitHub { return new FakeGitHub(this.s); }

  get commits(): FakeCommit[] { return this.s.commits; }
  get head(): string | null { return this.s.commits.at(-1)?.sha ?? null; }
  get totalWrites(): number { return this.s.writes; }
  get totalReads(): number { return this.s.reads; }
  get onBeforeWrite() { return this.s.onBeforeWrite; }
  set onBeforeWrite(f: (() => void | Promise<void>) | undefined) { this.s.onBeforeWrite = f; }

  failNext(method: keyof GitHubApi, err: Error): void {
    const q = this.s.failures.get(method) ?? [];
    q.push(err);
    this.s.failures.set(method, q);
  }

  private enter(method: keyof GitHubApi): void {
    const err = this.s.failures.get(method)?.shift();
    if (err) throw err;
  }
  private read(method: keyof GitHubApi): void {
    this.enter(method);
    this.reads++; this.s.reads++;
  }
  private async write(method: keyof GitHubApi, n: number): Promise<void> {
    this.enter(method);
    this.writes += n; this.s.writes += n;
    await this.s.onBeforeWrite?.();
  }
  private headTree(): Map<string, string> { return new Map(this.s.commits.at(-1)?.tree ?? []); }
  private commit(tree: Map<string, string>, message: string): string {
    const sha = (this.s.commits.length + 1).toString(16).padStart(40, "0");
    this.s.commits.push({ sha, parent: this.head, message, tree });
    return sha;
  }
  private find(sha: string): FakeCommit {
    const c = this.s.commits.find((x) => x.sha === sha);
    if (!c) throw new Error(`unknown commit ${sha}`);
    return c;
  }

  async getHead(etag: string | null): Promise<Head> {
    this.read("getHead");
    const sha = this.head;
    if (sha === null) return { notModified: false, sha: null, etag: "" };
    return etag === sha ? { notModified: true } : { notModified: false, sha, etag: sha };
  }
  async getTree(commitSha: string) { this.read("getTree"); return new Map(this.find(commitSha).tree); }
  async getBlobText(blobSha: string) {
    this.read("getBlobText");
    const t = this.s.blobs.get(blobSha);
    if (t === undefined) throw new Error(`unknown blob ${blobSha}`);
    return t;
  }
  async putFile(path: string, text: string, prevBlobSha: string | null, message: string) {
    await this.write("putFile", 1);
    const tree = this.headTree();
    if ((tree.get(path) ?? null) !== prevBlobSha) throw new ShaConflictError(path);
    const blobSha = await gitBlobSha(text);
    this.s.blobs.set(blobSha, text);
    tree.set(path, blobSha);
    return { blobSha, commitSha: this.commit(tree, message) };
  }
  async deleteFile(path: string, prevBlobSha: string, message: string) {
    await this.write("deleteFile", 1);
    const tree = this.headTree();
    if (tree.get(path) !== prevBlobSha) throw new ShaConflictError(path);
    tree.delete(path);
    return { commitSha: this.commit(tree, message) };
  }
  async commitBatch(baseCommit: string, changes: { path: string; text: string | null }[], message: string) {
    await this.write("commitBatch", 3);
    if (this.head !== baseCommit) throw new ShaConflictError();
    const tree = this.headTree();
    for (const c of changes) {
      if (c.text === null) tree.delete(c.path);
      else {
        const sha = await gitBlobSha(c.text);
        this.s.blobs.set(sha, c.text);
        tree.set(c.path, sha);
      }
    }
    return { commitSha: this.commit(tree, message) };
  }
  async getTarball(commitSha: string) {
    this.read("getTarball");
    return new Map([...this.find(commitSha).tree].map(([p, b]) => [p, this.s.blobs.get(b)!]));
  }
  async fileHistoryBlobShas(path: string, limit: number) {
    this.read("fileHistoryBlobShas");
    const out: string[] = [];
    const cs = this.s.commits;
    for (let i = cs.length - 1; i >= 0 && out.length < limit; i--) {
      const cur = cs[i].tree.get(path);
      if (cur !== undefined && cur !== (i ? cs[i - 1].tree.get(path) : undefined)) out.push(cur);
    }
    return out;
  }
  async repoSizeKb() {
    this.read("repoSizeKb");
    let n = 0;
    for (const t of this.s.blobs.values()) n += t.length;
    return Math.ceil(n / 1024);
  }
}
