import { TFile, type App, type DataAdapter } from "obsidian";
import { type FileStat, LocalChangedError, type LocalFs } from "./localfs";
import type { StateStore, SyncState } from "./state";

/** Text that vault.process can hand back byte for byte: valid UTF-8 without a BOM (which a text read may drop). */
function exactText(b: ArrayBuffer): string | null {
  try {
    const s = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(b);
    return s.startsWith("\uFEFF") ? null : s;
  } catch {
    return null;
  }
}
/** Editor buffers and text reads may turn CRLF into LF or drop a BOM: not a user edit. */
const norm = (s: string) => s.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");

function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  const x = new Uint8Array(a), y = new Uint8Array(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

export class ObsidianFs implements LocalFs {
  constructor(private app: App) {}

  private get adapter(): DataAdapter { return this.app.vault.adapter; }
  private isConfig(path: string): boolean {
    const c = this.app.vault.configDir;
    return path === c || path.startsWith(c + "/");
  }
  private file(path: string): TFile | null {
    const f = this.app.vault.getAbstractFileByPath(path);
    return f instanceof TFile ? f : null;
  }

  async list(includeConfig: boolean): Promise<FileStat[]> {
    const out: FileStat[] = this.app.vault.getFiles().map((f) => ({ path: f.path, mtime: f.stat.mtime, size: f.stat.size }));
    if (!includeConfig) return out;
    const walk = async (dir: string): Promise<void> => {
      const l = await this.adapter.list(dir);
      for (const p of l.files) {
        const st = await this.adapter.stat(p);
        if (st) out.push({ path: p, mtime: st.mtime, size: st.size });
      }
      for (const d of l.folders) await walk(d);
    };
    await walk(this.app.vault.configDir);
    return out;
  }

  read(path: string): Promise<ArrayBuffer> {
    const f = this.file(path); // the vault API where it can (cached, serialised); config files aren't indexed
    return f ? this.app.vault.readBinary(f) : this.adapter.readBinary(path);
  }

  // Deliberately the adapter, not vault.getAbstractFileByPath: the engine's case-collision check needs
  // stat("note.md") to find "Note.md" on case-insensitive disks (APFS/NTFS); the vault index is case-sensitive.
  async stat(path: string): Promise<FileStat | null> {
    const st = await this.adapter.stat(path);
    return st && st.type === "file" ? { path, mtime: st.mtime, size: st.size } : null;
  }

  async write(path: string, data: ArrayBuffer, expected?: ArrayBuffer | null): Promise<FileStat> {
    const existing = this.file(path);
    if (expected === null && (existing || await this.adapter.exists(path))) throw new LocalChangedError(path);
    const text = existing && expected ? exactText(data) : null, want = text !== null && expected ? exactText(expected) : null;
    if (existing && text !== null && want !== null) {
      // atomic against the editor: an open note's unsaved typing makes `cur` differ and the write is refused
      await this.app.vault.process(existing, (cur) => { if (norm(cur) !== norm(want)) throw new LocalChangedError(path); return text; });
    } else if (existing) {
      // shortcut: binary files have no atomic compare-and-swap; this check leaves a tiny window
      if (expected && !sameBytes(await this.adapter.readBinary(path), expected)) throw new LocalChangedError(path);
      await this.app.vault.modifyBinary(existing, data);
    } else {
      // not in the vault index (config files): plain compare before the write
      if (expected && !((await this.adapter.exists(path)) && sameBytes(await this.adapter.readBinary(path), expected))) throw new LocalChangedError(path);
      await this.mkdirs(path);
      if (this.isConfig(path)) await this.adapter.writeBinary(path, data); // not indexed by the vault
      else await this.app.vault.createBinary(path, data);
    }
    const st = await this.adapter.stat(path);
    if (!st) throw new Error(`write failed: ${path}`);
    return { path, mtime: st.mtime, size: st.size };
  }

  async trash(path: string): Promise<void> {
    const f = this.file(path);
    if (f) return this.app.fileManager.trashFile(f); // honours the user's "deleted files" preference
    if (!(await this.adapter.trashSystem(path))) await this.adapter.trashLocal(path);
  }

  private async mkdirs(path: string): Promise<void> {
    const parts = path.split("/").slice(0, -1);
    let cur = "";
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      if (await this.adapter.exists(cur)) continue;
      try { await this.adapter.mkdir(cur); } catch (e) { if (!(await this.adapter.exists(cur))) throw e; }
    }
  }
}

/** Atomic-ish: write state.json.tmp, then rename over state.json. */
export class AdapterStateStore implements StateStore {
  constructor(private adapter: DataAdapter, private dir: string, private name = "state.json") {}
  private get file() { return `${this.dir}/${this.name}`; }

  /** Falls back to state.json.tmp: save() may have died between removing state.json and the rename. */
  async load(): Promise<SyncState | null> {
    for (const f of [this.file, `${this.file}.tmp`]) {
      try {
        if (!(await this.adapter.exists(f))) continue;
        const s = JSON.parse(await this.adapter.read(f)) as SyncState;
        if (s?.version === 1) return s;
      } catch { /* corrupt: try the next one */ }
    }
    return null; // treated as first sync
  }

  async save(s: SyncState): Promise<void> {
    const tmp = `${this.file}.tmp`;
    await this.adapter.write(tmp, JSON.stringify(s));
    try {
      await this.adapter.rename(tmp, this.file);
    } catch {
      // rename may refuse to overwrite on some platforms
      await this.adapter.remove(this.file);
      await this.adapter.rename(tmp, this.file);
    }
  }
}
