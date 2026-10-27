import { expect, test } from "vitest";
import { TokenBucket } from "../src/bucket";
import type { SyncReport } from "../src/engine";
import type { GitHubApi } from "../src/github";
import { AuthError, RateLimitError } from "../src/http";
import { makeDevice, setupRepo } from "./helpers";

const SEEDS = 200;
const STEPS = 300;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Cyrillic, NFD-sensitive (é), nested folders, mostly .md, a few binaries.
const NAMES = [
  "a.md", "b.md", "Заметка.md", "café.md", "папка/план.md", "dir/é/x.md", "dir/notes.md", "dir/deep/y.md",
  "résumé.md", "img.png", "папка/фото.jpg",
].map((n) => n.normalize("NFC"));
const isBinary = (p: string) => /\.(png|jpg)$/.test(p);
const API: (keyof GitHubApi)[] = ["getHead", "getTree", "getBlobText", "putFile", "deleteFile", "commitBatch", "getTarball", "fileHistoryBlobShas"];

const dec = (b: ArrayBuffer) => new TextDecoder().decode(b);
/** Every user write is a unique tag `#n#` (one per line, or the whole binary); a file's content = its tags. */
const tags = (b: ArrayBuffer) => dec(b).match(/#\d+#/g) ?? [];
const binary = (tag: string) => new Uint8Array([0xff, 0xfe, 0, ...new TextEncoder().encode(tag)]).buffer;

/*
 * Invariant (2), "no saved edit is ever lost", modeled per tag rather than per file version:
 * each user write (create / append / modify line / binary rewrite) introduces a globally unique tag.
 * A tag is legitimately gone only if a user op on a device whose disk held it removed it
 * (modified that line, rewrote the binary, deleted the file) — i.e. a later edit/delete by a device
 * that had already received it. Every other tag ever written must be in the converged final files
 * (at its path, in a conflict copy, in a merge result or under a renamed path). This is stronger than
 * the journal-of-pre-sync-versions check: it covers every write, and git history does not count.
 */
async function runSeed(seed: number): Promise<void> {
  const rnd = mulberry32(seed);
  const int = (n: number) => Math.floor(rnd() * n);
  const pick = <T>(xs: T[]): T => xs[int(xs.length)];
  let clock = Date.UTC(2026, 9, 27, 9, 0);
  const now = () => clock;
  const { fake, keys } = await setupRepo();
  const devs = ["A", "B", "C"].map((name, i) =>
    makeDevice(fake, keys, name, { nfd: i === 2, now, bucket: new TokenBucket(20, 4, now) }));
  const trace: string[] = [];
  let n = 0;
  const written = new Set<string>(), killed = new Set<string>();
  const fresh = () => { const t = `#${++n}#`; written.add(t); return t; };
  const injected = new Set<Error>();

  const sync = async (i: number): Promise<SyncReport | null> => {
    try {
      return await devs[i].engine.sync();
    } catch (e) {
      if (!injected.has(e as Error)) throw new Error(`seed ${seed}: unexpected sync failure on ${"ABC"[i]}: ${(e as Error).stack}\n${trace.join("\n")}`);
      return null;
    }
  };

  for (let step = 0; step < STEPS; step++) {
    clock += 60_000; // refills 4 bucket tokens and moves conflict-copy timestamps
    const i = int(3), d = devs[i], fs = d.fs;
    const files = fs.paths();
    const r = rnd();
    if (r < 0.12) { // create
      const p = pick(NAMES);
      if (fs.has(p)) continue;
      const t = fresh();
      fs.set(p, isBinary(p) ? binary(t) : `${t}\n`);
      trace.push(`${step} ${"ABC"[i]} create ${p} ${t}`);
    } else if (r < 0.32 && files.length) { // append a line
      const p = pick(files), old = await fs.read(p), t = fresh();
      if (isBinary(p)) { tags(old).forEach((x) => killed.add(x)); fs.set(p, binary(t)); }
      else fs.set(p, `${dec(old)}${dec(old).endsWith("\n") || !old.byteLength ? "" : "\n"}${t}\n`);
      trace.push(`${step} ${"ABC"[i]} append ${p} ${t}`);
    } else if (r < 0.47 && files.length) { // modify a line
      const p = pick(files), old = await fs.read(p), t = fresh();
      const lines = dec(old).split("\n"), idx = lines.map((l, k) => (l ? k : -1)).filter((k) => k >= 0);
      if (isBinary(p) || !idx.length) { tags(old).forEach((x) => killed.add(x)); fs.set(p, isBinary(p) ? binary(t) : `${t}\n`); }
      else {
        const k = pick(idx);
        (lines[k].match(/#\d+#/g) ?? []).forEach((x) => killed.add(x));
        lines[k] = t;
        fs.set(p, lines.join("\n"));
      }
      trace.push(`${step} ${"ABC"[i]} modify ${p} ${t}`);
    } else if (r < 0.53 && files.length) { // delete
      const p = pick(files);
      tags(await fs.read(p)).forEach((x) => killed.add(x));
      fs.remove(p);
      trace.push(`${step} ${"ABC"[i]} delete ${p}`);
    } else if (r < 0.59 && files.length) { // rename
      const p = pick(files), q = pick(NAMES);
      if (fs.has(q)) continue;
      const data = await fs.read(p);
      fs.remove(p);
      fs.set(q, data);
      trace.push(`${step} ${"ABC"[i]} rename ${p} -> ${q}`);
    } else if (r < 0.79) { // sync
      trace.push(`${step} ${"ABC"[i]} sync ${JSON.stringify(await sync(i))}`);
    } else if (r < 0.91) { // sync with one injected fault
      const kind = int(4);
      let err: Error;
      if (kind === 3) { err = new Error("injected save failure"); d.store.failNextSave(err); }
      else {
        err = kind === 0 ? new Error("injected network error") : kind === 1 ? new RateLimitError(clock + 60_000) : new AuthError();
        fake.failNext(pick(API), err);
      }
      injected.add(err);
      trace.push(`${step} ${"ABC"[i]} sync+fault(${err.name}) ${JSON.stringify(await sync(i))}`);
    } else { // two devices race
      const j = (i + 1 + int(2)) % 3;
      const [a, b] = await Promise.all([sync(i), sync(j)]);
      trace.push(`${step} ${"ABC"[i]}||${"ABC"[j]} ${JSON.stringify(a)} ${JSON.stringify(b)}`);
    }
  }

  // Final convergence: no faults; a round where nobody changes anything ends it.
  fake.clearFailures();
  for (const d of devs) d.store.clearFail();
  let quiet = false;
  for (let round = 0; round < 5 && !quiet; round++) {
    clock += 3_600_000; // full buckets
    quiet = true;
    for (let i = 0; i < 3; i++) {
      const rep = await devs[i].engine.sync();
      trace.push(`final ${round} ${"ABC"[i]} ${JSON.stringify(rep)}`);
      const busy = rep.pulled.length || rep.pushed.length || rep.deleted.length || rep.conflicts.length || rep.deferred.length || rep.rateLimitedUntil;
      if (busy) quiet = false;
    }
  }
  const ctx = `seed ${seed}\n${trace.join("\n")}`;
  expect(quiet, `did not converge in 5 rounds; ${ctx}`).toBe(true);

  // 1) same NFC paths and bytes everywhere, and GitHub holds exactly that many files
  const snap = async (i: number) => {
    const out: [string, string][] = [];
    for (const p of devs[i].fs.paths()) out.push([p.normalize("NFC"), Buffer.from(await devs[i].fs.read(p)).toString("hex")]);
    return out.sort();
  };
  const final = await snap(0);
  expect(await snap(1), ctx).toEqual(final);
  expect(await snap(2), ctx).toEqual(final);
  expect([...fake.commits.at(-1)!.tree.keys()].filter((p) => p.startsWith("f/")).length, ctx).toBe(final.length);

  // 2) every tag written and never removed by a user op survives somewhere
  const present = new Set<string>();
  for (const p of devs[0].fs.paths()) tags(await devs[0].fs.read(p)).forEach((t) => present.add(t));
  const lost = [...written].filter((t) => !killed.has(t) && !present.has(t));
  expect(lost, `lost edits; ${ctx}`).toEqual([]);

  // 3) no conflict markers
  for (const p of devs[0].fs.paths()) expect(dec(await devs[0].fs.read(p)), `${p}; ${ctx}`).not.toContain("<<<<<<<");
}

for (let seed = 0; seed < SEEDS; seed++) test(`sim seed ${seed}`, () => runSeed(seed));
