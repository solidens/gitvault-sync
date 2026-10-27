import { describe, expect, it } from "vitest";
import { FakeFs, MemoryStateStore } from "./fake-fs";
import { text } from "./helpers";
import { emptyState } from "../src/state";

const NFC = "café.md";
const NFD = "café.md";
const buf = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

describe("FakeFs", () => {
  it("write -> stat/read, trash removes, mtime monotonic", async () => {
    const fs = new FakeFs();
    const a = await fs.write("a/b.md", buf("hi"));
    expect(await text(fs, "a/b.md")).toBe("hi");
    expect((await fs.stat("a/b.md"))?.size).toBe(2);
    const b = await fs.write("a/b.md", buf("hey"));
    expect(b.mtime).toBeGreaterThan(a.mtime);
    await fs.trash("a/b.md");
    expect(await fs.stat("a/b.md")).toBeNull();
  });
  it("nfd lists NFD paths but accepts both forms", async () => {
    const fs = new FakeFs({ nfd: true });
    await fs.write(NFC, buf("x"));
    expect((await fs.list(false))[0].path).toBe(NFD);
    expect(await text(fs, NFC)).toBe("x");
    expect(await text(fs, NFD)).toBe("x");
  });
  it("list hides .obsidian unless includeConfig; onBeforeWrite runs first", async () => {
    const fs = new FakeFs();
    fs.set(".obsidian/app.json", "{}");
    fs.set("n.md", "n");
    expect((await fs.list(false)).map((f) => f.path)).toEqual(["n.md"]);
    expect(await fs.list(true)).toHaveLength(2);
    fs.onBeforeWrite = () => fs.set("n.md", "typed");
    await fs.write("n.md", buf("sync"));
    expect(await text(fs, "n.md")).toBe("sync");
  });
});

describe("MemoryStateStore", () => {
  it("deep-copies and failNextSave fails once without persisting", async () => {
    const s = new MemoryStateStore();
    const st = emptyState();
    await s.save(st);
    st.headSha = "x";
    expect((await s.load())!.headSha).toBeNull();
    s.failNextSave(new Error("boom"));
    await expect(s.save(st)).rejects.toThrow("boom");
    expect(s.saved!.headSha).toBeNull();
    await s.save(st);
    expect(s.saved!.headSha).toBe("x");
  });
});
