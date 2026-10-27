import type { FileStat, LocalFs } from "../src/localfs";
import type { StateStore, SyncState } from "../src/state";

const nfc = (p: string) => p.normalize("NFC");
const enc = (d: string | ArrayBuffer): ArrayBuffer =>
  typeof d === "string" ? (new TextEncoder().encode(d).buffer as ArrayBuffer) : d;

/** caseInsensitive: like APFS/NTFS — lookups ignore case, a file keeps the case it was created with. */
export class FakeFs implements LocalFs {
  nfd = false;
  caseInsensitive = false;
  onBeforeWrite?: (path: string) => void | Promise<void>;
  private files = new Map<string, { path: string; data: ArrayBuffer; mtime: number }>();
  private clock = 0;

  constructor(opts: { nfd?: boolean; caseInsensitive?: boolean } = {}) {
    this.nfd = opts.nfd ?? false;
    this.caseInsensitive = opts.caseInsensitive ?? false;
  }

  private key(path: string): string {
    return this.caseInsensitive ? nfc(path).toLowerCase() : nfc(path);
  }
  private st(k: string): FileStat {
    const f = this.files.get(k)!;
    return { path: this.nfd ? f.path.normalize("NFD") : f.path, mtime: f.mtime, size: f.data.byteLength };
  }
  private put(path: string, data: ArrayBuffer): void {
    const k = this.key(path);
    this.files.set(k, { path: this.files.get(k)?.path ?? nfc(path), data: data.slice(0), mtime: ++this.clock });
  }

  async list(includeConfig: boolean): Promise<FileStat[]> {
    return [...this.files.keys()]
      .filter((k) => includeConfig || !this.files.get(k)!.path.startsWith(".obsidian/"))
      .map((k) => this.st(k));
  }
  async read(path: string): Promise<ArrayBuffer> {
    const f = this.files.get(this.key(path));
    if (!f) throw new Error(`ENOENT: ${path}`);
    return f.data.slice(0);
  }
  async stat(path: string): Promise<FileStat | null> {
    return this.files.has(this.key(path)) ? this.st(this.key(path)) : null;
  }
  async write(path: string, data: ArrayBuffer): Promise<FileStat> {
    await this.onBeforeWrite?.(nfc(path));
    this.put(path, data);
    return this.st(this.key(path));
  }
  async trash(path: string): Promise<void> {
    this.files.delete(this.key(path));
  }

  // sync test helpers; set() counts as a user edit
  set(path: string, data: string | ArrayBuffer): void {
    this.put(path, enc(data));
  }
  remove(path: string): void {
    this.files.delete(this.key(path));
  }
  has(path: string): boolean {
    return this.files.has(this.key(path));
  }
  paths(): string[] {
    return [...this.files.values()].map((f) => f.path).sort();
  }
}

export class MemoryStateStore implements StateStore {
  saved: SyncState | null = null;
  private fail: Error | null = null;
  failNextSave(err: Error): void {
    this.fail = err;
  }
  async load(): Promise<SyncState | null> {
    return this.saved ? structuredClone(this.saved) : null;
  }
  async save(s: SyncState): Promise<void> {
    if (this.fail) {
      const e = this.fail;
      this.fail = null;
      throw e;
    }
    this.saved = structuredClone(s);
  }
}
