import { describe, expect, test, vi } from "vitest";
import { RestGitHub } from "../src/github";
import { AuthError, RateLimitError, ShaConflictError, type Http, type HttpRequest, type HttpResponse } from "../src/http";
import { FakeGitHub } from "./fake-github";
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
  test("concurrent puts of different files both land", async () => {
    const fake = new FakeGitHub();
    await Promise.all([fake.client().putFile("x", "1", null, "m"), fake.client().putFile("y", "2", null, "m")]);
    expect([...(await fake.getTree(fake.head!)).keys()].sort()).toEqual(["x", "y"]);
  });
  test("concurrent batch vs put: batch fails if head moved", async () => {
    const fake = new FakeGitHub();
    const a = fake.client(), b = fake.client();
    const base = await a.putFile("x", "1", null, "m");
    const [r1, r2] = await Promise.allSettled([
      b.putFile("y", "2", null, "m"),
      a.commitBatch(base.commitSha, [{ path: "z", text: "3" }], "m"),
    ]);
    expect(r1.status).toBe("fulfilled");
    expect(r2.status).toBe("rejected");
    expect([...(await fake.getTree(fake.head!)).keys()].sort()).toEqual(["x", "y"]);
  });
});

const B = "https://api.github.com/repos/o/r";
function rig(replies: Record<string, Partial<HttpResponse> & { json?: unknown }>) {
  const calls: HttpRequest[] = [];
  const http: Http = async (req) => {
    calls.push(req);
    const r = replies[`${req.method} ${req.url}`];
    if (!r) throw new Error(`unexpected ${req.method} ${req.url}`);
    return { status: 200, headers: {}, text: r.json !== undefined ? JSON.stringify(r.json) : "", arrayBuffer: new ArrayBuffer(0), ...r };
  };
  return { gh: new RestGitHub(http, "o", "r", () => "tok"), calls };
}

describe("RestGitHub", () => {
  test("getHead: headers, etag, 304, 404/409", async () => {
    const k = `GET ${B}/git/ref/heads/main`;
    let { gh, calls } = rig({ [k]: { json: { object: { sha: "abc" } }, headers: { ETag: 'W/"1"' } } });
    expect(await gh.getHead('W/"0"')).toEqual({ notModified: false, sha: "abc", etag: 'W/"1"' });
    expect(calls[0]!.headers).toMatchObject({ Authorization: "Bearer tok", Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "If-None-Match": 'W/"0"' });
    expect(await rig({ [k]: { status: 304 } }).gh.getHead("x")).toEqual({ notModified: true });
    for (const status of [404, 409]) expect(await rig({ [k]: { status } }).gh.getHead(null)).toMatchObject({ sha: null });
  });
  test("getTree keeps blobs, throws when truncated", async () => {
    const k = `GET ${B}/git/trees/c1?recursive=1`;
    const tree = [{ path: "a", type: "blob", sha: "1" }, { path: "d", type: "tree", sha: "2" }];
    expect([...(await rig({ [k]: { json: { tree } } }).gh.getTree("c1"))]).toEqual([["a", "1"]]);
    await expect(rig({ [k]: { json: { tree, truncated: true } } }).gh.getTree("c1")).rejects.toThrow("tree truncated");
  });
  test("getBlobText uses raw accept", async () => {
    const { gh, calls } = rig({ [`GET ${B}/git/blobs/b1`]: { text: "hello" } });
    expect(await gh.getBlobText("b1")).toBe("hello");
    expect(calls[0]!.headers!.Accept).toBe("application/vnd.github.raw+json");
  });
  test("putFile body, result, 409/422 conflict", async () => {
    const k = `PUT ${B}/contents/f/ab/cd`;
    const { gh, calls } = rig({ [k]: { json: { content: { sha: "b" }, commit: { sha: "c" } } } });
    expect(await gh.putFile("f/ab/cd", "é", "prev", "m")).toEqual({ blobSha: "b", commitSha: "c" });
    expect(JSON.parse(calls[0]!.body as string)).toEqual({ message: "m", content: "w6k=", sha: "prev", branch: "main" });
    const r2 = rig({ [k]: { json: { content: { sha: "b" }, commit: { sha: "c" } } } });
    await r2.gh.putFile("f/ab/cd", "x", null, "m");
    expect(JSON.parse(r2.calls[0]!.body as string)).not.toHaveProperty("sha");
    for (const status of [409, 422]) await expect(rig({ [k]: { status } }).gh.putFile("f/ab/cd", "x", null, "m")).rejects.toBeInstanceOf(ShaConflictError);
  });
  test("deleteFile body", async () => {
    const { gh, calls } = rig({ [`DELETE ${B}/contents/gitvault.json`]: { json: { commit: { sha: "c" } } } });
    expect(await gh.deleteFile("gitvault.json", "s", "m")).toEqual({ commitSha: "c" });
    expect(JSON.parse(calls[0]!.body as string)).toEqual({ message: "m", sha: "s", branch: "main" });
  });
  test("commitBatch sequence; 422 on ref -> ShaConflictError", async () => {
    const replies = {
      [`POST ${B}/git/trees`]: { json: { sha: "t" } },
      [`POST ${B}/git/commits`]: { json: { sha: "c2" } },
      [`PATCH ${B}/git/refs/heads/main`]: { json: {} },
    };
    const { gh, calls } = rig(replies);
    expect(await gh.commitBatch("c1", [{ path: "a", text: "x" }, { path: "b", text: null }], "m")).toEqual({ commitSha: "c2" });
    expect(JSON.parse(calls[0]!.body as string)).toEqual({ base_tree: "c1", tree: [{ path: "a", mode: "100644", type: "blob", content: "x" }, { path: "b", mode: "100644", type: "blob", sha: null }] });
    expect(JSON.parse(calls[1]!.body as string)).toEqual({ message: "m", tree: "t", parents: ["c1"] });
    expect(JSON.parse(calls[2]!.body as string)).toEqual({ sha: "c2", force: false });
    await expect(rig({ ...replies, [`PATCH ${B}/git/refs/heads/main`]: { status: 422 } }).gh.commitBatch("c1", [], "m")).rejects.toBeInstanceOf(ShaConflictError);
  });
  test("fileHistoryBlobShas skips 404", async () => {
    const { gh } = rig({
      [`GET ${B}/commits?path=p&per_page=2`]: { json: [{ sha: "c2" }, { sha: "c1" }] },
      [`GET ${B}/contents/p?ref=c2`]: { status: 404 },
      [`GET ${B}/contents/p?ref=c1`]: { json: { sha: "b1" } },
    });
    expect(await gh.fileHistoryBlobShas("p", 2)).toEqual(["b1"]);
  });
  test("repoSizeKb", async () => {
    expect(await rig({ [`GET ${B}`]: { json: { size: 42 } } }).gh.repoSizeKb()).toBe(42);
  });
  test("getTarball not implemented yet", async () => {
    await expect(rig({}).gh.getTarball("c")).rejects.toThrow("not implemented");
  });
  test("error mapping", async () => {
    const k = `GET ${B}`;
    await expect(rig({ [k]: { status: 401 } }).gh.repoSizeKb()).rejects.toBeInstanceOf(AuthError);
    const e = await rig({ [k]: { status: 403, headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1700000000" } } }).gh.repoSizeKb().catch((x) => x);
    expect(e).toBeInstanceOf(RateLimitError);
    expect(e.resetAt).toBe(1700000000000);
    vi.spyOn(Date, "now").mockReturnValue(5000);
    const e2 = await rig({ [k]: { status: 429, headers: { "retry-after": "30" } } }).gh.repoSizeKb().catch((x) => x);
    expect(e2.resetAt).toBe(35000);
    vi.restoreAllMocks();
    await expect(rig({ [k]: { status: 500 } }).gh.repoSizeKb()).rejects.toMatchObject({ name: "HttpError", status: 500 });
  });
});
