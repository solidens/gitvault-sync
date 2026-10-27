import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { gunzip, parseTar } from "../src/tar";

const sample = () => { const b = readFileSync(new URL("./fixtures/sample.tar.gz", import.meta.url)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; };
const dec = (u: Uint8Array) => new TextDecoder().decode(u);

// Hand-built ustar record, to cover pax 'g' (what `git archive` emits first), which `tar` cannot produce.
function rec(name: string, type: string, body = ""): Uint8Array {
  const data = new TextEncoder().encode(body), h = new Uint8Array(512);
  h.set(new TextEncoder().encode(name)); h.set(new TextEncoder().encode(data.length.toString(8).padStart(11, "0")), 124); h[156] = type.charCodeAt(0);
  const pad = new Uint8Array(Math.ceil(data.length / 512) * 512); pad.set(data);
  const out = new Uint8Array(512 + pad.length); out.set(h); out.set(pad, 512);
  return out;
}
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0) + 1024); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o.buffer as ArrayBuffer; };

describe("tar", () => {
  test("gunzip + parseTar: files only, pax long name", async () => {
    const m = parseTar(await gunzip(sample()));
    expect([...m.keys()].sort()).toEqual(["repo-abc/f/ab/abcd", "repo-abc/f/cd/" + "x".repeat(120)]);
    expect(dec(m.get("repo-abc/f/ab/abcd")!)).toBe("hello");
    expect(dec(m.get("repo-abc/f/cd/" + "x".repeat(120))!)).toBe("long");
  });
  test("pax global header is skipped and does not leak path to next entry", () => {
    const m = parseTar(cat(rec("pax_global_header", "g", "52 comment=0123456789abcdef0123456789abcdef01234567\n"), rec("r/a", "0", "A"), rec("r/b", "0", "B")));
    expect([...m.keys()]).toEqual(["r/a", "r/b"]);
  });
  test("pax x path applies to the next file only", () => {
    const m = parseTar(cat(rec("h", "x", "15 path=r/long\n"), rec("short", "0", "A"), rec("r/b", "0", "B")));
    expect([...m.keys()]).toEqual(["r/long", "r/b"]);
  });
});
