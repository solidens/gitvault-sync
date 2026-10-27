import { expect, test } from "vitest";
import { isMergeablePath, mergeJson, merge3, tryDecodeUtf8 } from "../src/merge";

test("non-overlapping lines merge", () =>
  expect(merge3("a\nb\nc", "A\nb\nc", "a\nb\nC")).toBe("A\nb\nC"));
test("same line, different words merge", () =>
  expect(merge3("один два три", "ОДИН два три", "один два ТРИ")).toBe("ОДИН два ТРИ"));
test("same words → null", () => expect(merge3("x", "y", "z")).toBeNull());
test("both appended at end → both kept, local first", () =>
  expect(merge3("a", "a\nL", "a\nR")).toBe("a\nL\nR"));
test("identical edits", () => expect(merge3("a", "b", "b")).toBe("b"));
test("mergeJson key-wise", () =>
  expect(JSON.parse(mergeJson('{"a":1,"b":1}', '{"a":2,"b":1}', '{"a":1,"b":3}')!)).toEqual({ a: 2, b: 3 }));
test("mergeJson conflict → remote wins", () =>
  expect(JSON.parse(mergeJson('{"a":1}', '{"a":2}', '{"a":3}')!)).toEqual({ a: 3 }));
test("invalid utf8 → null", () => expect(tryDecodeUtf8(new Uint8Array([0xff, 0xfe]).buffer)).toBeNull());
test("mergeable paths", () => {
  expect(isMergeablePath("a.MD")).toBe(true); expect(isMergeablePath("a.canvas")).toBe(false);
});
