import { TFile, type App, type DataAdapter } from "obsidian";
import type { FileStat, LocalFs } from "./localfs";
import type { StateStore, SyncState } from "./state";

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
    return this.adapter.readBinary(path);
  }

  // Deliberately the adapter, not vault.getAbstractFileByPath: the engine's case-collision check needs
  // stat("note.md") to find "Note.md" on case-insensitive disks (APFS/NTFS); the vault index is case-sensitive.
  async stat(path: string): Promise<FileStat | null> {
    const st = await this.adapter.stat(path);
    return st && st.type === "file" ? { path, mtime: st.mtime, size: st.size } : null;
  }

  async write(path: string, data: ArrayBuffer): Promise<FileStat> {
    const existing = this.file(path);
    if (existing) await this.app.vault.modifyBinary(existing, data);
    else {
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
    if (f) return this.app.vault.trash(f, true);
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
  constructor(private adapter: DataAdapter, private dir: string) {}
  private get file() { return `${this.dir}/state.json`; }

  async load(): Promise<SyncState | null> {
    try {
      if (!(await this.adapter.exists(this.file))) return null;
      const s = JSON.parse(await this.adapter.read(this.file)) as SyncState;
      return s?.version === 1 ? s : null;
    } catch {
      return null; // corrupt state => treated as first sync
    }
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
