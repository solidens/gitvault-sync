// No Node APIs here: must run on iOS (WebCrypto, TextEncoder, btoa/atob only).

export const alwaysIgnored = (configDir: string, pluginId: string): string[] => [
  `${configDir}/plugins/${pluginId}/**`,
  `${configDir}/workspace*.json`,
  ".trash/**",
  ".git/**",
];

const bytes = (b: ArrayBuffer | Uint8Array) => (b instanceof Uint8Array ? b : new Uint8Array(b));
const hex = (buf: ArrayBuffer) =>
  Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, "0")).join("");

export function b64encode(buf: ArrayBuffer | Uint8Array): string {
  const u = bytes(buf);
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

export function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", bytes(data) as BufferSource));
}

export async function gitBlobSha(text: string): Promise<string> {
  const body = new TextEncoder().encode(text);
  const head = new TextEncoder().encode(`blob ${body.length}\0`);
  const all = new Uint8Array(head.length + body.length);
  all.set(head);
  all.set(body, head.length);
  return hex(await crypto.subtle.digest("SHA-1", all));
}

export const nfc = (path: string): string => path.normalize("NFC");

export const repoPath = (token: string): string => `f/${token.slice(0, 2)}/${token}`;

export function conflictPath(path: string, deviceName: string, at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}${p(at.getMinutes())}`;
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  // dot at start of the name (dotfile) is not an extension
  const hasExt = dot > slash + 1;
  const base = hasExt ? path.slice(0, dot) : path;
  const ext = hasExt ? path.slice(dot) : "";
  return `${base} (conflict ${deviceName} ${stamp})${ext}`;
}

function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else re += "[^/]*";
    } else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function isIgnored(path: string, patterns: string[]): boolean {
  return patterns.some((g) => globToRegex(g).test(path));
}

/** Obsidian refuses these characters in file names on every platform (and Windows refuses them on disk). */
export const hasForbiddenName = (path: string): boolean => /[*"\\<>:|?]/.test(path);
