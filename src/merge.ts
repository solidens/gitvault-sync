// Ported from Obsyncian (MIT, Copyright (c) 2026 Almas Abulkhairov):
// https://github.com/aabulkhairov/obsyncian — src/merge.ts
// merge3 differs: unresolvable blocks yield null instead of conflict markers.
import { diff3Merge } from "node-diff3";

export const MAX_MERGE_BYTES = 2 * 1024 * 1024;

// Only formats where a line-based merge is meaningful. Notably NOT .canvas:
// it's JSON, and a line merge can produce syntactically broken output.
export const MERGEABLE_EXTENSIONS = new Set(["md", "txt"]);

export function isMergeablePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return MERGEABLE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

// Strict decode: a .md file that isn't valid UTF-8 (someone renamed a binary)
// must fall back to the conflict-copy path, not get mangled by merging.
export function tryDecodeUtf8(buf: ArrayBuffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

// Three-way merge. Line-wise first; for hunks both sides touched: pure
// additions at one spot keep both (local first), otherwise retry word by word.
// Returns null when any block is unresolvable (caller makes a conflict copy).
export function merge3(base: string, local: string, remote: string): string | null {
  const regions = diff3Merge(local.split("\n"), base.split("\n"), remote.split("\n"), {
    excludeFalseConflicts: true,
  });
  const lines: string[] = [];
  for (const region of regions) {
    if (region.ok) {
      lines.push(...region.ok);
      continue;
    }
    const { a, o, b } = region.conflict!;
    if (o.length === 0) {
      lines.push(...unionLines(a, b));
      continue;
    }
    const byWord = mergeWords(o.join("\n"), a.join("\n"), b.join("\n"));
    if (byWord === null) return null;
    lines.push(...byWord.split("\n"));
  }
  return lines.join("\n");
}

// Both blocks, minus whatever they share at the start and end (two devices
// that added the same heading and then different items below it).
function unionLines(a: string[], b: string[]): string[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return [...a.slice(0, a.length - tail), ...b.slice(head)];
}

// Words (any script — \w alone would shred Cyrillic), runs of whitespace,
// and single punctuation marks.
const TOKEN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;
const MAX_HUNK_TOKENS = 5000;

// Word-level 3-way merge of one hunk; null when the two sides touched the
// same words (including both inserting at the same position — unlike whole
// lines, two word insertions at one spot have no safe order).
function mergeWords(base: string, local: string, remote: string): string | null {
  const o = base.match(TOKEN) ?? [];
  const a = local.match(TOKEN) ?? [];
  const b = remote.match(TOKEN) ?? [];
  if (Math.max(o.length, a.length, b.length) > MAX_HUNK_TOKENS) return null;
  const out: string[] = [];
  for (const region of diff3Merge(a, o, b, { excludeFalseConflicts: true })) {
    if (!region.ok) return null;
    out.push(...region.ok);
  }
  return out.join("");
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isObject(v: Json | undefined): v is { [key: string]: Json } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sameJson(x: Json | undefined, y: Json | undefined): boolean {
  return JSON.stringify(x) === JSON.stringify(y);
}

// Key-by-key merge of a settings file (.obsidian/*.json, plugin data.json).
// A key only one side changed takes that side's value; nested objects merge
// recursively; a key both sides changed to different values takes the
// remote's — settings have no meaningful "both", and the remote is the one
// every other device already agreed on. Arrays are values, not merged.
// Without a base, a key is "changed" on whichever side has it. Returns null
// when any side isn't a JSON object.
export function mergeJson(base: string | null, local: string, remote: string): string | null {
  let o: Json | undefined, a: Json, b: Json;
  try {
    o = base === null ? undefined : (JSON.parse(base) as Json);
    a = JSON.parse(local) as Json;
    b = JSON.parse(remote) as Json;
  } catch {
    return null;
  }
  if (!isObject(a) || !isObject(b)) return null;
  const indent = /^\{\r?\n(\s+)/.exec(local)?.[1] ?? /^\{\r?\n(\s+)/.exec(remote)?.[1];
  return JSON.stringify(mergeJsonObjects(isObject(o) ? o : undefined, a, b), null, indent);
}

function mergeJsonObjects(
  o: { [key: string]: Json } | undefined,
  a: { [key: string]: Json },
  b: { [key: string]: Json }
): { [key: string]: Json } {
  const out: { [key: string]: Json } = {};
  // Remote's key order first: when nothing local changed the result is
  // byte-for-byte the remote file.
  for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
    const inA = key in a, inB = key in b;
    const ov = o?.[key], av = a[key], bv = b[key];
    let value: Json | undefined;
    if (inA && inB) {
      if (sameJson(av, bv)) value = bv;
      else if (isObject(av) && isObject(bv)) value = mergeJsonObjects(isObject(ov) ? ov : undefined, av, bv);
      else if (o && key in o && sameJson(bv, ov)) value = av; // only local changed it
      else value = bv;
    } else if (inA) {
      // Missing remotely: deleted there (drop it) unless local changed it since.
      value = o && key in o && sameJson(av, ov) ? undefined : av;
    } else {
      value = o && key in o && sameJson(bv, ov) ? undefined : bv;
    }
    if (value !== undefined) out[key] = value;
  }
  return out;
}
