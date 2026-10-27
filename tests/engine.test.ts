import { expect, test } from "vitest";
import { TokenBucket } from "../src/bucket";
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

test("genuinely different edits on both sides throw until Task 9", async () => {
  const { fake, keys } = await setupRepo();
  const A = makeDevice(fake, keys, "A"), B = makeDevice(fake, keys, "B");
  A.fs.set("n.md", "v1");
  await A.engine.sync();
  await B.engine.sync();
  A.fs.set("n.md", "a");
  B.fs.set("n.md", "b");
  await A.engine.sync();
  await expect(B.engine.sync()).rejects.toThrow("conflict: Task 9");
  expect(await text(B.fs, "n.md")).toBe("b");
});
