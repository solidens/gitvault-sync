import type { FileStat, LocalFs } from "../src/localfs";
import type { StateStore, SyncState } from "../src/state";

const nfc = (p: string) => p.normalize("NFC");
const enc = (d: string | ArrayBuffer): ArrayBuffer =>
  typeof d === "string" ? (new TextEncoder().encode(d).buffer as ArrayBuffer) : d;

export class FakeFs implements LocalFs {
  nfd = false;
  onBeforeWrite?: (path: string) => void | Promise<void>;
  private files = new Map<string, { data: ArrayBuffer; mtime: number }>();
  private clock = 0;

  constructor(opts: { nfd?: boolean } = {}) {
    this.nfd = opts.nfd ?? false;
  }

  private st(p: string): FileStat {
    const f = this.files.get(p)!;
    return { path: this.nfd ? p.normalize("NFD") : p, mtime: f.mtime, size: f.data.byteLength };
  }

  async list(includeConfig: boolean): Promise<FileStat[]> {
    return [...this.files.keys()]
      .filter((p) => includeConfig || !p.startsWith(".obsidian/"))
      .map((p) => this.st(p));
  }
  async read(path: string): Promise<ArrayBuffer> {
    const f = this.files.get(nfc(path));
    if (!f) throw new Error(`ENOENT: ${path}`);
    return f.data.slice(0);
  }
  async stat(path: string): Promise<FileStat | null> {
    return this.files.has(nfc(path)) ? this.st(nfc(path)) : null;
  }
  async write(path: string, data: ArrayBuffer): Promise<FileStat> {
    const p = nfc(path);
    await this.onBeforeWrite?.(p);
    this.files.set(p, { data: data.slice(0), mtime: ++this.clock });
    return this.st(p);
  }
  async trash(path: string): Promise<void> {
    this.files.delete(nfc(path));
  }

  // sync test helpers; set() counts as a user edit
  set(path: string, data: string | ArrayBuffer): void {
    this.files.set(nfc(path), { data: enc(data).slice(0), mtime: ++this.clock });
  }
  remove(path: string): void {
    this.files.delete(nfc(path));
  }
  has(path: string): boolean {
    return this.files.has(nfc(path));
  }
  paths(): string[] {
    return [...this.files.keys()].sort();
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
