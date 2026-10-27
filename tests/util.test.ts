import { expect, test } from "vitest";
import { ALWAYS_IGNORED, b64decode, b64encode, conflictPath, gitBlobSha, isIgnored, nfc, repoPath, sha256Hex } from "../src/util";

test("gitBlobSha matches git", async () => {
  expect(await gitBlobSha("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
});
test("sha256Hex", async () => {
  expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
test("repoPath shards", () => expect(repoPath("abcdef")).toBe("f/ab/abcdef"));
test("conflictPath", () => {
  const d = new Date(2026, 9, 27, 11, 30);
  expect(conflictPath("a/Note.md", "iPhone", d)).toBe("a/Note (conflict iPhone 2026-10-27 1130).md");
  expect(conflictPath("a/Makefile", "Mac", d)).toBe("a/Makefile (conflict Mac 2026-10-27 1130)");
  expect(conflictPath(".hidden", "Mac", d)).toBe(".hidden (conflict Mac 2026-10-27 1130)");
});
test("nfc", () => expect(nfc("é.md")).toBe("é.md"));
test("isIgnored", () => {
  expect(isIgnored(".obsidian/plugins/gitvault-sync/state.json", ALWAYS_IGNORED)).toBe(true);
  expect(isIgnored(".obsidian/workspace-mobile.json", ALWAYS_IGNORED)).toBe(true);
  expect(isIgnored(".trash/x.md", ALWAYS_IGNORED)).toBe(true);
  expect(isIgnored(".git/HEAD", ALWAYS_IGNORED)).toBe(true);
  expect(isIgnored(".obsidian/app.json", ALWAYS_IGNORED)).toBe(false);
  expect(isIgnored("notes/a.md", ["notes/*.md"])).toBe(true);
  expect(isIgnored("notes/x/a.md", ["notes/*.md"])).toBe(false);
  expect(isIgnored("notes/x/a.md", ["notes/**"])).toBe(true);
  expect(isIgnored("notesXmd", ["notes.md"])).toBe(false);
});
test("b64 roundtrip", () => {
  const u = new Uint8Array([0, 255, 1, 2]);
  expect(b64decode(b64encode(u))).toEqual(u);
  expect(b64encode(u)).toBe("AP8BAg==");
});
