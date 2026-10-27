import { expect, test, vi } from "vitest";
import { TokenBucket } from "../src/bucket";
import { AuthError, RateLimitError, ShaConflictError } from "../src/http";
import { createVault } from "../src/crypto";
import { FakeGitHub } from "./fake-github";
import { makeDevice, setupRepo, text } from "./helpers";

const fTree = (fake: FakeGitHub) => [...(fake.commits.at(-1)?.tree.keys() ?? [])].filter((p) => p.startsWith("f/"));

test("first device uploads, second downloads", async () => {
  const { fake, keys } = await setupRepo();
  const A = makeDevice(fake, keys, "A"), B = makeDevice(fake, keys, "B");
  const png = new Uint8Array([137, 80, 78, 71, 0, 255, 1, 2]).buffer;
  A.fs.set("a.md", "hello");
  A.fs.set("img.png", png);
  expect((await A.engine.sync()).pushed.sort()).toEqual(["a.md", "img.png"]);
  expect(fTree(fake)).toHaveLength(2);
  expect((await B.engine.sync()).pulled.sort()).toEqual(["a.md", "img.png"]);
  expect(B.fs.paths()).toEqual(["a.md", "img.png"]);
  expect(await text(B.fs, "a.md")).toBe("hello");
  expect(new Uint8Array(await B.fs.read("img.png"))).toEqual(new Uint8Array(png));
  for (const c of fake.commits.slice(1)) expect(c.message).toBe("gvs: A 1 file(s)");
});

test("edit propagates", async () => {
  const { fake, keys } = await setupRepo();
  const A = makeDevice(fake, keys, "A"), B = makeDevice(fake, keys, "B");
  A.fs.set("n.md", "v1");
  await A.engine.sync();
  await B.engine.sync();
  A.fs.set("n.md", "v2");
  await A.engine.sync();
  expect((await B.engine.sync()).pulled).toEqual(["n.md"]);
  expect(await text(B.fs, "n.md")).toBe("v2");
});

test("delete propagates to trash", async () => {
  const { fake, keys } = await setupRepo();
  const A = makeDevice(fake, keys, "A"), B = makeDevice(fake, keys, "B");
  A.fs.set("n.md", "v1");
  A.fs.set("keep.md", "k");
  await A.engine.sync();
  await B.engine.sync();
  A.fs.remove("n.md");
  expect((await A.engine.sync()).deleted).toEqual(["n.md"]);
  expect(fTree(fake)).toHaveLength(1);
  expect((await B.engine.sync()).deleted).toEqual(["n.md"]);
  expect(B.fs.paths()).toEqual(["keep.md"]);
  expect(B.store.saved!.files["n.md"]).toBeUndefined();
});

test("idle sync costs zero writes and no tree fetch", async () => {
  const { fake, keys } = await setupRepo();
  const A = makeDevice(fake, keys, "A"), B = makeDevice(fake, keys, "B");
  A.fs.set("a.md", "x");
  await A.engine.sync();
  await B.engine.sync();
  await A.engine.sync(); // sees its own push once
  await B.engine.sync();
  const reads = fake.totalReads, writes = fake.totalWrites;
  for (const d of [A, B, A, B]) expect(await d.engine.sync()).toMatchObject({ pulled: [], pushed: [], deleted: [] });
  expect(fake.totalWrites).toBe(writes);
  expect(fake.totalReads).toBe(reads + 4); // getHead only
});

test("own push does not look like remote change", async () => {
  const { fake, keys } = await setupRepo();
  const A = makeDevice(fake, keys, "A");
  A.fs.set("a.md", "x");
  await A.engine.sync();
  A.fs.set("a.md", "y");
  await A.engine.sync();
  const reads = A.api.reads;
  expect((await A.engine.sync()).pulled).toEqual([]);
  expect(A.api.reads).toBe(reads + 2); // getHead + getTree, no blob downloads
});

test("foreign commit between our PUTs is not lost", async () => {
  const { fake, keys } = await setupRepo();
  const A = makeDevice(fake, keys, "A"), B = makeDevice(fake, keys, "B");
  A.fs.set("a1.md", "1");
  A.fs.set("a2.md", "2");
  B.fs.set("b.md", "b");
  fake.onBeforeWrite = async () => {
    fake.onBeforeWrite = undefined;
    await B.engine.sync();
  };
  await A.engine.sync();
  expect(fTree(fake)).toHaveLength(3);
  await B.engine.sync();
  await A.engine.sync();
  expect(A.fs.paths()).toEqual(["a1.md", "a2.md", "b.md"]);
  expect(B.fs.paths()).toEqual(["a1.md", "a2.md", "b.md"]);
});

test("crash after PUT before state save converges without conflict copy", async () => {
  const { fake, keys } = await setupRepo();
  const A = makeDevice(fake, keys, "A"), B = makeDevice(fake, keys, "B");
  A.fs.set("n.md", "v1");
  A.fs.set("new.md", "fresh");
  await A.engine.sync();
  A.fs.set("n.md", "v2");
  A.fs.set("new2.md", "fresh2");
  fake.onBeforeWrite = () => {
    fake.onBeforeWrite = undefined;
    A.store.failNextSave(new Error("disk full"));
  };
  await expect(A.engine.sync()).rejects.toThrow("disk full");
  const r = await A.engine.sync();
  expect(r.conflicts).toEqual([]);
  expect(r.pushed).toEqual(["new2.md"]); // n.md (PUT before the crash) is not re-pushed
  await B.engine.sync();
  for (const d of [A, B]) expect(d.fs.paths()).toEqual(["n.md", "new.md", "new2.md"]);
  expect(await text(B.fs, "n.md")).toBe("v2");
  expect(fTree(fake)).toHaveLength(3);
});

test("NFD path on mac and NFC on iPhone are one file", async () => {
  const { fake, keys } = await setupRepo();
  const A = makeDevice(fake, keys, "A", { nfd: true }), B = makeDevice(fake, keys, "B");
  A.fs.set("é.md", "mac");
  await A.engine.sync();
  await B.engine.sync();
  expect(B.fs.paths()).toEqual(["é.md".normalize("NFC")]);
  B.fs.set("é.md", "phone");
  await B.engine.sync();
  expect((await A.engine.sync()).pulled).toEqual(["é.md".normalize("NFC")]);
  expect(A.fs.paths()).toHaveLength(1);
  expect(await text(A.fs, "é.md")).toBe("phone");
  expect(fTree(fake)).toHaveLength(1);
  expect((await A.engine.sync()).pushed).toEqual([]);
});

test("ignored and large files are not pushed", async () => {
  const { fake, keys } = await setupRepo();
  const A = makeDevice(fake, keys, "A", { settings: { syncConfig: true, ignore: ["private/**"] } });
  A.fs.set(".obsidian/plugins/gitvault-sync/data.json", "{}");
  A.fs.set(".obsidian/workspace.json", "{}");
  A.fs.set("private/x.md", "x");
  A.fs.set("big.bin", new ArrayBuffer(60 * 1024 * 1024));
  A.fs.set("ok.md", "ok");
  const r = await A.engine.sync();
  expect(r.pushed).toEqual(["ok.md"]);
  expect(r.skippedLarge).toEqual(["big.bin"]);
  expect(fTree(fake)).toHaveLength(1);
});

test("file that grows past the limit is left alone, not deleted remotely", async () => {
  const { fake, keys } = await setupRepo();
  const A = makeDevice(fake, keys, "A", { settings: { maxFileBytes: 10 } });
  A.fs.set("f.md", "small");
  await A.engine.sync();
  A.fs.set("f.md", "now it is too big");
  const r = await A.engine.sync();
  expect(r).toMatchObject({ skippedLarge: ["f.md"], deleted: [], pushed: [] });
  expect(fTree(fake)).toHaveLength(1);
});

test("syncConfig=false skips .obsidian, true includes app.json", async () => {
  const { fake, keys } = await setupRepo();
  const A = makeDevice(fake, keys, "A", { settings: { syncConfig: true } });
  const B = makeDevice(fake, keys, "B");
  const C = makeDevice(fake, keys, "C", { settings: { syncConfig: true } });
  A.fs.set(".obsidian/app.json", '{"a":1}');
  A.fs.set("n.md", "n");
  expect((await A.engine.sync()).pushed.sort()).toEqual([".obsidian/app.json", "n.md"]);
  B.fs.set(".obsidian/app.json", '{"b":2}');
  await B.engine.sync();
  expect(B.fs.paths()).toEqual([".obsidian/app.json", "n.md"]);
  expect(await text(B.fs, ".obsidian/app.json")).toBe('{"b":2}');
  const reads = B.api.reads;
  A.fs.set("m.md", "m");
  await A.engine.sync();
  await B.engine.sync();
  expect(B.api.reads).toBe(reads + 3); // getHead, getTree, m.md only: skipped app.json is not re-downloaded
  await C.engine.sync();
  expect(await text(C.fs, ".obsidian/app.json")).toBe('{"a":1}');
});

test("batch path used above threshold", async () => {
  const { fake, keys } = await setupRepo();
  const A = makeDevice(fake, keys, "A"), B = makeDevice(fake, keys, "B");
  for (let i = 0; i < 6; i++) A.fs.set(`n${i}.md`, `c${i}`);
  expect((await A.engine.sync()).pushed).toHaveLength(6);
  expect(A.api.writes).toBe(3);
  expect(fake.commits.at(-1)!.message).toBe("gvs: A 6 file(s)");
  expect((await A.engine.sync()).pulled).toEqual([]); // batch blob shas recorded correctly
  await B.engine.sync();
  expect(await text(B.fs, "n5.md")).toBe("c5");
  // batch deletes too
  for (let i = 0; i < 6; i++) B.fs.remove(`n${i}.md`);
  expect((await B.engine.sync()).deleted).toHaveLength(6);
  expect(fTree(fake)).toEqual([]);
  await A.engine.sync();
  expect(A.fs.paths()).toEqual([]);
});

test("empty repo without gitvault.json: pushes via putFile only", async () => {
  const fake = new FakeGitHub();
  const { keys } = await createVault("pw", 1000);
  const A = makeDevice(fake, keys, "A"), B = makeDevice(fake, keys, "B");
  for (let i = 0; i < 6; i++) A.fs.set(`n${i}.md`, `c${i}`);
  expect((await A.engine.sync()).pushed).toHaveLength(6);
  expect(fake.commits).toHaveLength(6);
  await B.engine.sync();
  expect(B.fs.paths()).toHaveLength(6);
});

test("bucket exhausted defers pushes", async () => {
  const { fake, keys } = await setupRepo();
  let t = 1_000_000;
  const now = () => t;
  const A = makeDevice(fake, keys, "A", { now, bucket: new TokenBucket(2, 4, now) });
  for (let i = 0; i < 5; i++) A.fs.set(`n${i}.md`, `c${i}`);
  const r1 = await A.engine.sync();
  expect(r1.pushed).toHaveLength(2);
  expect(r1.rateLimitedUntil).toBe(t + 15_000);
  t += 60_000;
  const r2 = await A.engine.sync();
  expect(r2.pushed).toHaveLength(2);
  t += 60_000;
  const r3 = await A.engine.sync();
  expect(r3.pushed).toHaveLength(1);
  expect(r3.rateLimitedUntil).toBeUndefined();
  expect(fTree(fake)).toHaveLength(5);
});

async function toggleSetup(bContent: string) {
  const { fake, keys } = await setupRepo();
  const A = makeDevice(fake, keys, "A", { settings: { syncConfig: true } });
  const B = makeDevice(fake, keys, "B");
  for (let i = 0; i < 6; i++) A.fs.set(`.obsidian/c${i}.json`, '{"x":"A","a":1}');
  await A.engine.sync();
  for (let i = 0; i < 6; i++) B.fs.set(`.obsidian/c${i}.json`, bContent);
  B.fs.set("n.md", "n");
  await B.engine.sync();
  await A.engine.sync();
  await B.engine.sync();
  B.settings.syncConfig = true;
  return { fake, keys, B };
}

test("turning syncConfig on merges config key-wise, remote wins on dispute", async () => {
  const { fake, keys, B } = await toggleSetup('{"x":"B","b":2}');
  expect((await B.engine.sync()).conflicts).toEqual([]);
  const C = makeDevice(fake, keys, "C", { settings: { syncConfig: true } });
  await C.engine.sync();
  for (const d of [B, C]) {
    for (let i = 0; i < 6; i++) expect(JSON.parse(await text(d.fs, `.obsidian/c${i}.json`))).toEqual({ x: "A", a: 1, b: 2 });
  }
});

test("turning syncConfig on with identical config only records state", async () => {
  const { fake, B } = await toggleSetup('{"x":"A","a":1}');
  const writes = fake.totalWrites;
  expect(await B.engine.sync()).toMatchObject({ pushed: [], pulled: [] });
  expect(fake.totalWrites).toBe(writes);
  expect(Object.keys(B.store.saved!.files)).toHaveLength(7);
  expect(B.store.saved!.skipped).toEqual({});
});

test("removing an ignore pattern never overwrites the remote file", async () => {
  const { fake, keys } = await setupRepo();
  const A = makeDevice(fake, keys, "A");
  const B = makeDevice(fake, keys, "B", { settings: { ignore: ["private/**"] } });
  A.fs.set("private/x.md", "A");
  await A.engine.sync();
  B.fs.set("private/x.md", "B");
  await B.engine.sync();
  await B.engine.sync();
  B.settings.ignore = [];
  const [copy] = (await B.engine.sync()).conflicts;
  expect(copy).toMatch(/^private\/x \(conflict B \d{4}-\d\d-\d\d \d{4}\)\.md$/);
  const C = makeDevice(fake, keys, "C");
  await C.engine.sync();
  expect(await text(C.fs, "private/x.md")).toBe("A");
  expect(await text(C.fs, copy)).toBe("B");
});

test("restart does not re-download skipped remote files", async () => {
  const { fake, keys } = await setupRepo();
  const A = makeDevice(fake, keys, "A", { settings: { syncConfig: true } });
  const B = makeDevice(fake, keys, "B");
  A.fs.set(".obsidian/app.json", "{}");
  await A.engine.sync();
  await B.engine.sync();
  const B2 = B.restart();
  A.fs.set("m.md", "m");
  await A.engine.sync();
  const reads = B.api.reads;
  await B2.sync();
  expect(B.api.reads).toBe(reads + 3); // getHead, getTree, m.md
  expect(B.fs.paths()).toEqual(["m.md"]);
});

// ---- Task 9: merge, conflict copies, deletions, safety guards ----

const T = new Date(2026, 9, 27, 14, 5).getTime();
const at = { now: () => T };

async function pair(content: Record<string, string | ArrayBuffer>, opts: Parameters<typeof makeDevice>[3] = {}) {
  const { fake, keys } = await setupRepo();
  const A = makeDevice(fake, keys, "A", { ...at, ...opts }), B = makeDevice(fake, keys, "B", { ...at, ...opts });
  for (const [p, c] of Object.entries(content)) A.fs.set(p, c);
  await A.engine.sync();
  await B.engine.sync();
  return { fake, keys, A, B };
}

test("non-overlapping concurrent edits merge silently", async () => {
  const { A, B } = await pair({ "n.md": "a\nb\nc" });
  A.fs.set("n.md", "A\nb\nc");
  B.fs.set("n.md", "a\nb\nC");
  await A.engine.sync();
  const r = await B.engine.sync();
  expect(r.conflicts).toEqual([]);
  await A.engine.sync();
  for (const d of [A, B]) {
    expect(d.fs.paths()).toEqual(["n.md"]);
    expect(await text(d.fs, "n.md")).toBe("A\nb\nC");
  }
});

test("overlapping edits → conflict copy, remote keeps path", async () => {
  const { A, B } = await pair({ "note.md": "x" });
  A.fs.set("note.md", "y");
  await A.engine.sync();
  B.fs.set("note.md", "z");
  const r = await B.engine.sync();
  const copy = "note (conflict B 2026-10-27 1405).md";
  expect(r.conflicts).toEqual([copy]);
  expect(r.pushed).toContain(copy);
  await A.engine.sync();
  for (const d of [A, B]) {
    expect(d.fs.paths()).toEqual([copy, "note.md"]);
    expect(await text(d.fs, "note.md")).toBe("y");
    expect(await text(d.fs, copy)).toBe("z");
  }
});

test("conflict copy never overwrites an existing file", async () => {
  const { A, B } = await pair({ "note.md": "x" });
  B.fs.set("note (conflict B 2026-10-27 1405).md", "older copy");
  await B.engine.sync();
  A.fs.set("note.md", "y");
  await A.engine.sync();
  B.fs.set("note.md", "z");
  expect((await B.engine.sync()).conflicts).toEqual(["note (conflict B 2026-10-27 1405) 2.md"]);
  expect(await text(B.fs, "note (conflict B 2026-10-27 1405).md")).toBe("older copy");
});

test("binary edited on both → conflict copy", async () => {
  const bin = (...b: number[]) => new Uint8Array(b).buffer as ArrayBuffer;
  const { A, B } = await pair({ "img.png": bin(1, 2, 3) });
  A.fs.set("img.png", bin(1, 2, 4));
  await A.engine.sync();
  B.fs.set("img.png", bin(9, 9));
  expect((await B.engine.sync()).conflicts).toEqual(["img (conflict B 2026-10-27 1405).png"]);
  expect(new Uint8Array(await B.fs.read("img.png"))).toEqual(new Uint8Array([1, 2, 4]));
  expect(new Uint8Array(await B.fs.read("img (conflict B 2026-10-27 1405).png"))).toEqual(new Uint8Array([9, 9]));
});

test("merge without a fetchable base → conflict copy", async () => {
  const { fake, A, B } = await pair({ "n.md": "a\nb\nc" });
  A.fs.set("n.md", "A\nb\nc");
  await A.engine.sync();
  B.fs.set("n.md", "a\nb\nC");
  const baseSha = B.store.saved!.files["n.md"].blobSha;
  const orig = fake.getBlobText.bind(fake);
  B.api.getBlobText = async (sha: string) => { if (sha === baseSha) throw new Error("gone"); return orig(sha); };
  expect((await B.engine.sync()).conflicts).toEqual(["n (conflict B 2026-10-27 1405).md"]);
  expect(await text(B.fs, "n.md")).toBe("A\nb\nc");
});

test("created on both without base, identical → no conflict", async () => {
  const { fake, A, B } = await pair({});
  A.fs.set("n.md", "same");
  B.fs.set("n.md", "same");
  await A.engine.sync();
  const writes = fake.totalWrites;
  expect(await B.engine.sync()).toMatchObject({ conflicts: [], pushed: [] });
  expect(fake.totalWrites).toBe(writes);
});

test("created on both without base, different → conflict copy", async () => {
  const { A, B } = await pair({});
  A.fs.set("n.md", "from A");
  B.fs.set("n.md", "from B");
  await A.engine.sync();
  expect((await B.engine.sync()).conflicts).toEqual(["n (conflict B 2026-10-27 1405).md"]);
  await A.engine.sync();
  for (const d of [A, B]) {
    expect(await text(d.fs, "n.md")).toBe("from A");
    expect(await text(d.fs, "n (conflict B 2026-10-27 1405).md")).toBe("from B");
  }
});

test("delete vs edit → edit wins, file restored everywhere", async () => {
  // local delete, remote edit
  const { A, B } = await pair({ "n.md": "v1", "m.md": "m1" });
  A.fs.set("n.md", "v2");
  await A.engine.sync();
  B.fs.remove("n.md");
  await B.engine.sync();
  expect(await text(B.fs, "n.md")).toBe("v2");
  // local edit, remote delete
  A.fs.remove("m.md");
  await A.engine.sync();
  B.fs.set("m.md", "m2");
  await B.engine.sync();
  await A.engine.sync();
  for (const d of [A, B]) {
    expect(d.fs.paths()).toEqual(["m.md", "n.md"]);
    expect(await text(d.fs, "m.md")).toBe("m2");
  }
});

test("typing during pull write → deferred, local edit preserved", async () => {
  const { A, B } = await pair({ "x.md": "one\ntwo", "y.md": "one\ntwo" });
  A.fs.set("x.md", "ONE\ntwo");
  A.fs.set("y.md", "ONE\ntwo");
  await A.engine.sync();
  let typed = "";
  B.fs.onBeforeWrite = (p) => {
    B.fs.onBeforeWrite = undefined;
    typed = p === "x.md" ? "y.md" : "x.md";
    B.fs.set(typed, "one\ntwo typed");
  };
  const r = await B.engine.sync();
  expect(r.deferred).toEqual([typed]);
  expect(await text(B.fs, typed)).toBe("one\ntwo typed");
  expect((await B.engine.sync()).conflicts).toEqual([]);
  expect(await text(B.fs, typed)).toBe("ONE\ntwo typed");
  await A.engine.sync();
  expect(await text(A.fs, typed)).toBe("ONE\ntwo typed");
});

test("remote deletion of a file being edited is deferred, not trashed", async () => {
  const { A, B } = await pair({ "x.md": "x", "y.md": "y" });
  A.fs.remove("x.md");
  A.fs.set("y.md", "y2");
  await A.engine.sync();
  B.fs.onBeforeWrite = () => { B.fs.onBeforeWrite = undefined; B.fs.set("x.md", "typed"); };
  expect((await B.engine.sync()).deferred).toEqual(["x.md"]);
  await B.engine.sync();
  await A.engine.sync();
  expect(await text(A.fs, "x.md")).toBe("typed");
});

test("mass delete asks and can be refused", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 30; i++) files[`n${i}.md`] = `c${i}`;
  const asked: [number, number][] = [];
  const { fake, keys } = await setupRepo();
  const A = makeDevice(fake, keys, "A", { confirmMassDelete: async (n, t) => (asked.push([n, t]), true) });
  const B = makeDevice(fake, keys, "B", { confirmMassDelete: async (n, t) => (asked.push([n, t]), false) });
  for (const [p, c] of Object.entries(files)) A.fs.set(p, c);
  await A.engine.sync();
  await B.engine.sync();
  for (let i = 0; i < 11; i++) A.fs.remove(`n${i}.md`);
  A.fs.set("n29.md", "edited");
  await A.engine.sync();
  expect(asked).toEqual([[11, 30]]);
  const before = structuredClone(B.store.saved!.files);
  const r = await B.engine.sync();
  expect(asked).toEqual([[11, 30], [11, 30]]);
  expect(r.deleted).toEqual([]);
  expect(r.pulled).toEqual(["n29.md"]); // everything else syncs
  expect(B.fs.paths()).toHaveLength(30);
  for (let i = 0; i < 11; i++) expect(B.store.saved!.files[`n${i}.md`]).toEqual(before[`n${i}.md`]);
  await B.engine.sync(); // asks again
  expect(asked).toHaveLength(3);
  expect(B.fs.paths()).toHaveLength(30);
});

test("refused local mass delete keeps files on GitHub", async () => {
  const { fake, keys } = await setupRepo();
  const A = makeDevice(fake, keys, "A", { confirmMassDelete: async () => false });
  for (let i = 0; i < 20; i++) A.fs.set(`n${i}.md`, `c${i}`);
  await A.engine.sync();
  for (let i = 0; i < 15; i++) A.fs.remove(`n${i}.md`);
  expect((await A.engine.sync()).deleted).toEqual([]);
  expect(fTree(fake)).toHaveLength(20);
});

test("folder rename of 50 files is not mass delete", async () => {
  const confirm = async () => { throw new Error("must not ask"); };
  const files: Record<string, string> = {};
  for (let i = 0; i < 50; i++) files[`old/n${i}.md`] = `c${i}`;
  const { A, B } = await pair(files, { confirmMassDelete: confirm });
  for (let i = 0; i < 50; i++) {
    A.fs.remove(`old/n${i}.md`);
    A.fs.set(`new/n${i}.md`, `c${i}`);
  }
  await A.engine.sync();
  await B.engine.sync();
  expect(B.fs.paths()).toEqual(Array.from({ length: 50 }, (_, i) => `new/n${i}.md`).sort());
});

test("empty local vault vs full remote downloads, never deletes", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 30; i++) files[`n${i}.md`] = `c${i}`;
  const confirm = async () => { throw new Error("must not ask"); };
  const { fake, B } = await pair(files, { confirmMassDelete: confirm });
  for (const p of B.fs.paths()) B.fs.remove(p);
  const r = await B.engine.sync();
  expect(r.deleted).toEqual([]);
  expect(B.fs.paths()).toHaveLength(30);
  expect(fTree(fake)).toHaveLength(30);
});

test("repo emptied (head → null) never trashes local files", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 30; i++) files[`n${i}.md`] = `c${i}`;
  const confirm = async () => { throw new Error("must not ask"); };
  const now = () => T;
  const { fake, A } = await pair(files, { confirmMassDelete: confirm, bucket: new TokenBucket(100, 4, now) });
  fake.commits.length = 0;
  const r = await A.engine.sync();
  expect(r.deleted).toEqual([]);
  expect(A.fs.paths()).toHaveLength(30);
  expect(fTree(fake)).toHaveLength(30); // treated as first upload
});

test("remote path differing only by case → conflict copy on a case-insensitive disk", async () => {
  const { A, B } = await pair({}, { caseInsensitive: true });
  B.fs.set("Note.md", "mine");
  A.fs.set("note.md", "theirs");
  await A.engine.sync();
  const r = await B.engine.sync();
  expect(r.conflicts).toEqual(["note (conflict B 2026-10-27 1405).md"]);
  expect(B.fs.paths()).toEqual(["Note.md", "note (conflict B 2026-10-27 1405).md"]);
  expect(await text(B.fs, "note (conflict B 2026-10-27 1405).md")).toBe("theirs");
  const again = await B.engine.sync();
  expect(again).toMatchObject({ conflicts: [], deleted: [], pulled: [] });
});

test(".obsidian json merged key-wise when syncConfig", async () => {
  const cfg = { settings: { syncConfig: true } };
  const { A, B } = await pair({ ".obsidian/app.json": '{\n  "a": 1,\n  "b": 1,\n  "c": 1\n}' }, cfg);
  A.fs.set(".obsidian/app.json", '{\n  "a": 2,\n  "b": 1,\n  "c": 3\n}');
  await A.engine.sync();
  B.fs.set(".obsidian/app.json", '{\n  "a": 1,\n  "b": 5,\n  "c": 4\n}');
  expect((await B.engine.sync()).conflicts).toEqual([]);
  await A.engine.sync();
  for (const d of [A, B]) expect(JSON.parse(await text(d.fs, ".obsidian/app.json"))).toEqual({ a: 2, b: 5, c: 3 });
});

test("two remote case variants on a fresh case-insensitive device → original + copy, remote untouched", async () => {
  const { fake, keys } = await setupRepo();
  const A = makeDevice(fake, keys, "A", at), C = makeDevice(fake, keys, "C", { ...at, caseInsensitive: true });
  A.fs.set("Note.md", "upper");
  A.fs.set("note.md", "lower");
  await A.engine.sync();
  const r = await C.engine.sync();
  expect(r.conflicts).toHaveLength(1);
  const copy = r.conflicts[0];
  expect(C.fs.paths()).toHaveLength(2);
  const [orig] = C.fs.paths().filter((p) => p !== copy);
  expect(await text(C.fs, copy)).toBe(orig === "Note.md" ? "lower" : "upper");
  for (const d of [C, A, C, A]) expect((await d.engine.sync()).deleted).toEqual([]);
  expect(await text(A.fs, "Note.md")).toBe("upper");
  expect(await text(A.fs, "note.md")).toBe("lower");
  const D = makeDevice(fake, keys, "D"); // case-sensitive disk: both variants, no extra copy
  expect((await D.engine.sync()).conflicts).toEqual([]);
  expect(await text(D.fs, "Note.md")).toBe("upper");
  expect(await text(D.fs, "note.md")).toBe("lower");
});

for (const caseInsensitive of [false, true]) {
  test(`case-only rename is applied without a conflict copy (caseInsensitive=${caseInsensitive})`, async () => {
    const { fake, keys, A, B } = await pair({ "note.md": "n", "other.md": "o" }, { caseInsensitive });
    A.fs.remove("note.md");
    A.fs.set("Note.md", "n");
    await A.engine.sync();
    expect((await B.engine.sync()).conflicts).toEqual([]);
    await B.engine.sync();
    expect(B.fs.paths()).toEqual(["Note.md", "other.md"]);
    for (const d of [A, B]) expect((await d.engine.sync()).deleted).toEqual([]);
    const D = makeDevice(fake, keys, "D");
    await D.engine.sync();
    expect(D.fs.paths()).toEqual(["Note.md", "other.md"]);
  });
}

test("remote path colliding by case with an ignored local file → conflict copy, not deferred forever", async () => {
  const { fake, keys } = await setupRepo();
  const A = makeDevice(fake, keys, "A", at);
  const C = makeDevice(fake, keys, "C", { ...at, caseInsensitive: true, settings: { ignore: ["Private/**"] } });
  C.fs.set("Private/x.md", "local secret");
  A.fs.set("private/x.md", "remote");
  await A.engine.sync();
  const r = await C.engine.sync();
  expect(r.deferred).toEqual([]);
  expect(r.conflicts).toEqual(["private/x (conflict C 2026-10-27 1405).md"]);
  expect(await text(C.fs, "Private/x.md")).toBe("local secret");
  expect(await C.engine.sync()).toMatchObject({ deferred: [], conflicts: [] });
});

test("one creation offsets only one deletion of identical files", async () => {
  const asked: number[] = [];
  const { fake, keys } = await setupRepo();
  const A = makeDevice(fake, keys, "A", { confirmMassDelete: async (n) => (asked.push(n), false) });
  for (let i = 0; i < 20; i++) A.fs.set(`n${i}.md`, "same");
  await A.engine.sync();
  for (let i = 0; i < 15; i++) A.fs.remove(`n${i}.md`);
  A.fs.set("moved.md", "same");
  await A.engine.sync();
  expect(asked).toEqual([14]);
  expect(fTree(fake)).toHaveLength(21);
});

// ---- Task 10: tarball, rebind, API errors ----

test("fresh device with >300 remote changes uses tarball", async () => {
  const { fake, keys } = await setupRepo();
  const A = makeDevice(fake, keys, "A"), B = makeDevice(fake, keys, "B");
  for (let i = 0; i < 301; i++) A.fs.set(`n${i}.md`, `c${i}`);
  await A.engine.sync();
  const blobs = vi.spyOn(B.api, "getBlobText"), tars = vi.spyOn(B.api, "getTarball");
  expect((await B.engine.sync()).pulled).toHaveLength(301);
  expect(tars).toHaveBeenCalledTimes(1);
  expect(blobs).not.toHaveBeenCalled();
  expect(B.api.reads).toBe(3); // getHead, getTree, getTarball
  expect(await text(B.fs, "n300.md")).toBe("c300");
  // known device, >300 remote edits: tarball again
  for (let i = 0; i < 301; i++) A.fs.set(`n${i}.md`, `d${i}`);
  await A.engine.sync();
  expect((await B.engine.sync()).pulled).toHaveLength(301);
  expect(tars).toHaveBeenCalledTimes(2);
  expect(blobs).not.toHaveBeenCalled();
  expect(await text(B.fs, "n0.md")).toBe("d0");
});

test("fresh device tarball still records skipped remote files", async () => {
  const { fake, keys } = await setupRepo();
  const A = makeDevice(fake, keys, "A", { settings: { syncConfig: true } }), B = makeDevice(fake, keys, "B");
  A.fs.set(".obsidian/app.json", "{}");
  A.fs.set("n.md", "n");
  await A.engine.sync();
  const blobs = vi.spyOn(B.api, "getBlobText");
  await B.engine.sync();
  expect(blobs).not.toHaveBeenCalled();
  expect(B.fs.paths()).toEqual(["n.md"]);
  expect(Object.values(B.store.saved!.skipped!).map((e) => e.path)).toEqual([".obsidian/app.json"]);
});

async function rebindSetup() {
  const { fake, keys } = await setupRepo();
  const A = makeDevice(fake, keys, "A", at), B = makeDevice(fake, keys, "B", at);
  A.fs.set("n.md", "v1");
  A.fs.set("same.md", "s");
  await A.engine.sync();
  await B.engine.sync();
  return { fake, A, B };
}

test("rebind: lost state, identical files → no transfers, no conflicts", async () => {
  const { fake, B } = await rebindSetup();
  B.store.saved = null;
  const writes = fake.totalWrites;
  expect(await B.engine.sync()).toMatchObject({ pulled: [], pushed: [], conflicts: [] });
  expect(fake.totalWrites).toBe(writes);
  expect(Object.keys(B.store.saved!.files).sort()).toEqual(["n.md", "same.md"]);
});

test("rebind: local file is an older version → takes remote, no conflict", async () => {
  const { fake, A, B } = await rebindSetup();
  A.fs.set("n.md", "v2");
  await A.engine.sync();
  A.fs.set("n.md", "v3");
  await A.engine.sync();
  B.store.saved = null;
  const writes = fake.totalWrites;
  expect(await B.engine.sync()).toMatchObject({ pulled: ["n.md"], pushed: [], conflicts: [] });
  expect(await text(B.fs, "n.md")).toBe("v3");
  expect(B.fs.paths()).toEqual(["n.md", "same.md"]);
  expect(fake.totalWrites).toBe(writes);
});

test("rebind: local file diverged → conflict copy", async () => {
  const { fake, A, B } = await rebindSetup();
  A.fs.set("n.md", "v2");
  await A.engine.sync();
  B.store.saved = null;
  B.fs.set("n.md", "mine");
  const r = await B.engine.sync();
  expect(r.conflicts).toEqual(["n (conflict B 2026-10-27 1405).md"]);
  expect(await text(B.fs, "n.md")).toBe("v2");
  expect(await text(B.fs, "n (conflict B 2026-10-27 1405).md")).toBe("mine");
  expect(fTree(fake)).toHaveLength(3);
});

test("persistent sha conflict gives up after 3 retries without data loss", async () => {
  const { A, B } = await pair({ "n.md": "a\nb\nc" });
  B.fs.set("n.md", "a\nb\nC");
  for (let i = 0; i < 4; i++) B.api.failNext("putFile", new ShaConflictError("x"));
  const put = vi.spyOn(B.api, "putFile");
  const r = await B.engine.sync();
  expect(put).toHaveBeenCalledTimes(4);
  expect(r.pushed).toEqual([]);
  expect(await text(B.fs, "n.md")).toBe("a\nb\nC");
  expect((await B.engine.sync()).pushed).toEqual(["n.md"]);
  await A.engine.sync();
  expect(await text(A.fs, "n.md")).toBe("a\nb\nC");
});

test("sha conflict on push re-pulls, merges and retries in the same cycle", async () => {
  const { A, B } = await pair({ "n.md": "a\nb\nc" });
  B.fs.set("n.md", "a\nb\nC");
  B.api.onBeforeWrite = async () => { // A commits right before B's PUT lands
    B.api.onBeforeWrite = undefined;
    A.fs.set("n.md", "A\nb\nc");
    await A.engine.sync();
  };
  const r = await B.engine.sync();
  expect(r.conflicts).toEqual([]);
  expect(r.pushed).toEqual(["n.md"]);
  await A.engine.sync();
  for (const d of [A, B]) expect(await text(d.fs, "n.md")).toBe("A\nb\nC");
});

test("RateLimitError mid-cycle saves progress and reports resetAt", async () => {
  const { A, B } = await pair({ "n1.md": "1", "n2.md": "2" });
  A.fs.set("n1.md", "1b");
  A.fs.set("n2.md", "2b");
  await A.engine.sync();
  const orig = B.api.getBlobText.bind(B.api);
  let calls = 0;
  B.api.getBlobText = async (sha) => {
    if (++calls === 2) throw new RateLimitError(T + 60_000);
    return orig(sha);
  };
  const r = await B.engine.sync();
  expect(r.rateLimitedUntil).toBe(T + 60_000);
  expect(r.pulled).toEqual(["n1.md"]);
  expect(await text(B.fs, "n1.md")).toBe("1b");
  expect(await text(B.fs, "n2.md")).toBe("2");
  const reads = B.api.reads;
  expect((await B.engine.sync()).pulled).toEqual(["n2.md"]);
  expect(B.api.reads).toBe(reads + 3); // getHead, getTree, n2 only: n1 progress was saved
  expect(await text(B.fs, "n2.md")).toBe("2b");
});

test("AuthError mid-cycle leaves files and state intact and rethrows", async () => {
  const { fake, A, B } = await pair({ "n.md": "v1" });
  B.fs.set("n.md", "v2");
  B.fs.set("new.md", "x");
  const saved = structuredClone(B.store.saved);
  B.api.failNext("putFile", new AuthError());
  await expect(B.engine.sync()).rejects.toBeInstanceOf(AuthError);
  expect(await text(B.fs, "n.md")).toBe("v2");
  expect(B.fs.paths()).toEqual(["n.md", "new.md"]);
  expect(B.store.saved!.files).toEqual(saved!.files);
  expect((await B.engine.sync()).pushed.sort()).toEqual(["n.md", "new.md"]);
  await A.engine.sync();
  expect(await text(A.fs, "n.md")).toBe("v2");
  expect(fTree(fake)).toHaveLength(2);
});
