// No Node APIs here: WebCrypto only (iOS). Key schedule adapted from Obsyncian (see NOTICE).
import { b64decode, b64encode, nfc } from "./util";

export interface VaultConfig {
  format: 1;
  kdf: { alg: typeof KDF_ALG; iterations: number; salt: string };
  kcv: string;
}
export interface VaultKeys { enc: CryptoKey; mac: CryptoKey }
export class WrongPasswordError extends Error {
  constructor() { super("Wrong password"); this.name = "WrongPasswordError"; }
}

/** PBKDF2-SHA256 -> 256-bit master -> HKDF-SHA256 per purpose (AES key, HMAC key). */
const KDF_ALG = "PBKDF2-SHA256+HKDF";
const MIN_ITERATIONS = 100_000, MAX_ITERATIONS = 10_000_000;
const MAGIC = new TextEncoder().encode("GVS1");
const KCV_PLAIN = "gvs-key-check-v1";
const IV_LEN = 12;
const te = new TextEncoder();
const bs = (u: Uint8Array) => u as BufferSource;

async function deriveKeys(password: string, salt: Uint8Array, iterations: number): Promise<VaultKeys> {
  const base = await crypto.subtle.importKey("raw", bs(te.encode(password)), "PBKDF2", false, ["deriveBits"]);
  const master = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: bs(salt), iterations }, base, 256);
  const hk = await crypto.subtle.importKey("raw", master, "HKDF", false, ["deriveKey"]);
  const info = (label: string) => ({ name: "HKDF", hash: "SHA-256", salt: bs(new Uint8Array(0)), info: bs(te.encode(label)) });
  return {
    enc: await crypto.subtle.deriveKey(info("gvs-enc-v1"), hk, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]),
    mac: await crypto.subtle.deriveKey(info("gvs-mac-v1"), hk, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign"]),
  };
}

async function seal(keys: VaultKeys, plain: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: bs(iv) }, keys.enc, bs(plain)));
  const out = new Uint8Array(MAGIC.length + IV_LEN + ct.length);
  out.set(MAGIC);
  out.set(iv, MAGIC.length);
  out.set(ct, MAGIC.length + IV_LEN);
  return b64encode(out);
}

async function open(keys: VaultKeys, text: string): Promise<Uint8Array> {
  const raw = b64decode(text);
  if (raw.length < MAGIC.length + IV_LEN || !MAGIC.every((b, i) => raw[i] === b)) throw new Error("Not a GVS1 file");
  const iv = raw.slice(MAGIC.length, MAGIC.length + IV_LEN);
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bs(iv) }, keys.enc, bs(raw.slice(MAGIC.length + IV_LEN))));
}

export async function createVault(password: string, iterations = 600_000) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keys = await deriveKeys(password, salt, iterations);
  const config: VaultConfig = {
    format: 1,
    kdf: { alg: KDF_ALG, iterations, salt: b64encode(salt) },
    kcv: await seal(keys, te.encode(KCV_PLAIN)),
  };
  return { config, keys };
}

/** config comes from the repo: anything unexpected is refused before spending CPU on it. */
export async function unlockVault(password: string, config: VaultConfig): Promise<VaultKeys> {
  if (config?.format !== 1) throw new Error("gitvault.json: unknown format");
  if (config.kdf?.alg !== KDF_ALG) throw new Error(`gitvault.json: unsupported key algorithm ${String(config.kdf?.alg)}`);
  const n = config.kdf.iterations;
  if (!Number.isInteger(n) || n < MIN_ITERATIONS || n > MAX_ITERATIONS) throw new Error(`gitvault.json: invalid iteration count ${n}`);
  const keys = await deriveKeys(password, b64decode(config.kdf.salt), config.kdf.iterations);
  try {
    if (new TextDecoder().decode(await open(keys, config.kcv)) === KCV_PLAIN) return keys;
  } catch { /* fall through */ }
  throw new WrongPasswordError();
}

export async function pathToken(keys: VaultKeys, path: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", keys.mac, bs(te.encode("gvs-path-v1\n" + nfc(path))));
  return Array.from(new Uint8Array(sig), (x) => x.toString(16).padStart(2, "0")).join("");
}

export async function encryptFile(keys: VaultKeys, path: string, data: ArrayBuffer): Promise<string> {
  const p = te.encode(nfc(path));
  const plain = new Uint8Array(4 + p.length + data.byteLength);
  new DataView(plain.buffer).setUint32(0, p.length);
  plain.set(p, 4);
  plain.set(new Uint8Array(data), 4 + p.length);
  return seal(keys, plain);
}

export async function decryptFile(keys: VaultKeys, text: string): Promise<{ path: string; data: ArrayBuffer }> {
  const plain = await open(keys, text);
  const n = new DataView(plain.buffer, plain.byteOffset).getUint32(0);
  if (4 + n > plain.length) throw new Error("Corrupt file header");
  return {
    path: new TextDecoder().decode(plain.slice(4, 4 + n)),
    data: plain.slice(4 + n).buffer,
  };
}
