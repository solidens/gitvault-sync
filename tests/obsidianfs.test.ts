import { TFile, type App, type DataAdapter } from "obsidian";
import { expect, test } from "vitest";
import { LocalChangedError } from "../src/localfs";
import { AdapterStateStore, ObsidianFs } from "../src/obsidianfs";
import { emptyState } from "../src/state";

const te = new TextEncoder(), td = new TextDecoder();
const buf = (s: string) => te.encode(s).buffer as ArrayBuffer;

/** Disk + vault index; `editor` = unsaved editor content of an open note, which vault.process sees. */
function rig() {
  const disk = new Map<string, ArrayBuffer>();
  const editor = new Map<string, string>();
  const calls: string[] = [];
  const adapter = {
    exists: async (p: string) => disk.has(p),
    stat: async (p: string) => (disk.has(p) ? { type: "file", mtime: 1, size: disk.get(p)!.byteLength } : null),
    readBinary: async (p: string) => disk.get(p)!,
    read: async (p: string) => td.decode(disk.get(p)!),
    write: async (p: string, s: string) => void disk.set(p, buf(s)),
    writeBinary: async (p: string, d: ArrayBuffer) => void disk.set(p, d),
    mkdir: async () => {},
    remove: async (p: string) => void disk.delete(p),
    rename: async (a: string, b: string) => { if (disk.has(b)) throw new Error("exists"); disk.set(b, disk.get(a)!); disk.delete(a); },
  };
  const vault = {
    adapter, configDir: ".obsidian",
    getAbstractFileByPath: (p: string) => (disk.has(p) && !p.startsWith(".obsidian/") ? new TFile(p) : null),
    process: async (f: TFile, fn: (s: string) => string) => {
      calls.push(`process ${f.path}`);
      const out = fn(editor.get(f.path) ?? td.decode(disk.get(f.path)!));
      editor.delete(f.path);
      disk.set(f.path, buf(out));
      return out;
    },
    modifyBinary: async (f: TFile, d: ArrayBuffer) => { calls.push(`modifyBinary ${f.path}`); disk.set(f.path, d); },
    createBinary: async (p: string, d: ArrayBuffer) => { calls.push(`createBinary ${p}`); disk.set(p, d); },
  };
  return { fs: new ObsidianFs({ vault } as unknown as App), disk, editor, calls, adapter: adapter as unknown as DataAdapter };
}

test("text write is a compare-and-swap against the editor via vault.process", async () => {
  const { fs, disk, editor, calls } = rig();
  disk.set("n.md", buf("old"));
  await fs.write("n.md", buf("new"), buf("old"));
  expect(td.decode(disk.get("n.md")!)).toBe("new");
  editor.set("n.md", "new typed");
  await expect(fs.write("n.md", buf("remote"), buf("new"))).rejects.toBeInstanceOf(LocalChangedError);
  expect(editor.get("n.md") ?? td.decode(disk.get("n.md")!)).toBe("new typed");
  expect(calls).toEqual(["process n.md", "process n.md"]);
});

test("expected null refuses an existing file; binary and BOM files use modifyBinary with a byte check", async () => {
  const { fs, disk, calls } = rig();
  disk.set("n.md", buf("x"));
  await expect(fs.write("n.md", buf("y"), null)).rejects.toBeInstanceOf(LocalChangedError);
  await fs.write("new.md", buf("y"), null);
  const png = new Uint8Array([0xff, 0, 1]).buffer, bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x61]).buffer;
  disk.set("i.png", png);
  disk.set("b.md", bom);
  await expect(fs.write("i.png", buf("z"), new Uint8Array([0xff, 1]).buffer)).rejects.toBeInstanceOf(LocalChangedError);
  await fs.write("i.png", buf("z"), png);
  await fs.write("b.md", buf("c"), bom);
  expect(calls).toEqual(["createBinary new.md", "modifyBinary i.png", "modifyBinary b.md"]);
});

test("state load falls back to the .tmp file left by an interrupted save", async () => {
  const { disk, adapter } = rig();
  const store = new AdapterStateStore(adapter, "dir");
  const s = { ...emptyState(), headSha: "abc" };
  await store.save(s);
  await store.save({ ...s, headSha: "def" }); // rename refused -> remove + rename fallback
  expect((await store.load())?.headSha).toBe("def");
  disk.set("dir/state.json.tmp", disk.get("dir/state.json")!); // died after remove, before rename
  disk.delete("dir/state.json");
  expect((await store.load())?.headSha).toBe("def");
  disk.set("dir/state.json", buf("{corrupt"));
  expect((await store.load())?.headSha).toBe("def");
});
