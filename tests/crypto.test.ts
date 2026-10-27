import { expect, test } from "vitest";
import { createVault, decryptFile, encryptFile, pathToken, unlockVault, WrongPasswordError } from "../src/crypto";
import { b64decode, b64encode } from "../src/util";

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const dec = (b: ArrayBuffer) => new TextDecoder().decode(b);

test("roundtrip with path", async () => {
  const { keys } = await createVault("pw", 1000);
  const t = await encryptFile(keys, "Папка/Заметка.md", enc("привет"));
  const r = await decryptFile(keys, t);
  expect(r.path).toBe("Папка/Заметка.md");
  expect(dec(r.data)).toBe("привет");
});
test("unlock with right/wrong password", async () => {
  const { config } = await createVault("pw", 1000);
  await expect(unlockVault("pw", config)).resolves.toBeDefined();
  await expect(unlockVault("nope", config)).rejects.toBeInstanceOf(WrongPasswordError);
});
test("same keys from unlock decrypt", async () => {
  const { config, keys } = await createVault("pw", 1000);
  const t = await encryptFile(keys, "a.md", enc("x"));
  const k2 = await unlockVault("pw", config);
  expect(dec((await decryptFile(k2, t)).data)).toBe("x");
});
test("pathToken deterministic, NFC-insensitive, key-dependent", async () => {
  const a = (await createVault("pw", 1000)).keys;
  const b = (await createVault("pw", 1000)).keys;
  const t = await pathToken(a, "é.md");
  expect(t).toMatch(/^[0-9a-f]{64}$/);
  expect(await pathToken(a, "é.md")).toBe(t);
  expect(await pathToken(a, "é.md")).toBe(t);
  expect(await pathToken(b, "é.md")).not.toBe(t);
});
test("tampered ciphertext rejected", async () => {
  const { keys } = await createVault("pw", 1000);
  const raw = b64decode(await encryptFile(keys, "a.md", enc("x")));
  raw[raw.length - 1] ^= 1;
  await expect(decryptFile(keys, b64encode(raw))).rejects.toBeDefined();
});
test("ciphertext is randomized", async () => {
  const { keys } = await createVault("pw", 1000);
  expect(await encryptFile(keys, "a.md", enc("x"))).not.toBe(await encryptFile(keys, "a.md", enc("x")));
});
