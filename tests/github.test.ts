import { describe, expect, test } from "vitest";
import { FakeGitHub } from "./fake-github";
import { ShaConflictError } from "../src/http";
import { gitBlobSha } from "../src/util";

describe("FakeGitHub", () => {
  test("putFile CAS", async () => {
    const gh = new FakeGitHub().client();
    const a = await gh.putFile("x", "1", null, "m");
    await expect(gh.putFile("x", "2", null, "m")).rejects.toBeInstanceOf(ShaConflictError);
    await gh.putFile("x", "2", a.blobSha, "m");
    await expect(gh.putFile("x", "3", a.blobSha, "m")).rejects.toBeInstanceOf(ShaConflictError);
  });
  test("putFile on other file succeeds after foreign commit", async () => {
    const fake = new FakeGitHub();
    const a = fake.client(), b = fake.client();
    await a.putFile("x", "1", null, "m");
    await b.putFile("y", "2", null, "m");
    const tree = await a.getTree(fake.head!);
    expect([...tree.keys()].sort()).toEqual(["x", "y"]);
  });
  test("deleteFile CAS and removal", async () => {
    const gh = new FakeGitHub().client();
    const a = await gh.putFile("x", "1", null, "m");
    await expect(gh.deleteFile("x", "bad", "m")).rejects.toBeInstanceOf(ShaConflictError);
    const { commitSha } = await gh.deleteFile("x", a.blobSha, "m");
    expect((await gh.getTree(commitSha)).size).toBe(0);
  });
  test("commitBatch requires fast-forward", async () => {
    const fake = new FakeGitHub();
    const gh = fake.client();
    const first = await gh.putFile("x", "1", null, "m");
    await gh.putFile("y", "1", null, "m");
    await expect(gh.commitBatch(first.commitSha, [{ path: "z", text: "1" }], "m")).rejects.toBeInstanceOf(ShaConflictError);
    const r = await gh.commitBatch(fake.head!, [{ path: "z", text: "1" }, { path: "x", text: null }], "m");
    expect([...(await gh.getTree(r.commitSha)).keys()].sort()).toEqual(["y", "z"]);
  });
  test("commitBatch on empty repo needs null-equivalent base", async () => {
    const gh = new FakeGitHub().client();
    await expect(gh.commitBatch("abc", [], "m")).rejects.toBeInstanceOf(ShaConflictError);
  });
  test("getHead etag", async () => {
    const gh = new FakeGitHub().client();
    expect(await gh.getHead(null)).toEqual({ notModified: false, sha: null, etag: "" });
    await gh.putFile("x", "1", null, "m");
    const h = await gh.getHead(null);
    if (h.notModified || h.sha === null) throw new Error("unexpected");
    expect(await gh.getHead(h.etag)).toEqual({ notModified: true });
    await gh.putFile("y", "1", null, "m");
    expect((await gh.getHead(h.etag)).notModified).toBe(false);
  });
  test("getTree returns blob shas equal to gitBlobSha(text); blob/tarball readable", async () => {
    const fake = new FakeGitHub();
    const gh = fake.client();
    await gh.putFile("x", "héllo", null, "m");
    const tree = await gh.getTree(fake.head!);
    expect(tree.get("x")).toBe(await gitBlobSha("héllo"));
    expect(await gh.getBlobText(tree.get("x")!)).toBe("héllo");
    expect((await gh.getTarball(fake.head!)).get("x")).toBe("héllo");
  });
  test("fileHistoryBlobShas newest first, only touching commits", async () => {
    const gh = new FakeGitHub().client();
    const a = await gh.putFile("x", "1", null, "m");
    await gh.putFile("y", "1", null, "m");
    const b = await gh.putFile("x", "2", a.blobSha, "m");
    expect(await gh.fileHistoryBlobShas("x", 10)).toEqual([b.blobSha, a.blobSha]);
    expect(await gh.fileHistoryBlobShas("x", 1)).toEqual([b.blobSha]);
  });
  test("counters: per client and total; batch counts 3", async () => {
    const fake = new FakeGitHub();
    const a = fake.client(), b = fake.client();
    await a.putFile("x", "1", null, "m");
    await b.getHead(null);
    await b.commitBatch(fake.head!, [{ path: "y", text: "1" }], "m");
    expect([a.writes, a.reads, b.writes, b.reads]).toEqual([1, 0, 3, 1]);
    expect([fake.totalWrites, fake.totalReads]).toEqual([4, 1]);
  });
  test("failNext throws once on any client; onBeforeWrite can inject foreign commit", async () => {
    const fake = new FakeGitHub();
    const a = fake.client(), b = fake.client();
    fake.failNext("getHead", new Error("boom"));
    await expect(a.getHead(null)).rejects.toThrow("boom");
    await a.getHead(null);
    const base = await a.putFile("x", "1", null, "m");
    fake.onBeforeWrite = async () => { fake.onBeforeWrite = undefined; await b.putFile("z", "1", null, "m"); };
    await expect(a.commitBatch(base.commitSha, [{ path: "y", text: "1" }], "m")).rejects.toBeInstanceOf(ShaConflictError);
  });
});
