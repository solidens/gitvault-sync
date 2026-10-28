import { TokenBucket } from "../src/bucket";
import { createVault, type VaultKeys } from "../src/crypto";
import { DEFAULT_ENGINE_SETTINGS, type EngineSettings, SyncEngine } from "../src/engine";
import type { LocalFs } from "../src/localfs";
import { FakeFs, MemoryStateStore } from "./fake-fs";
import { FakeGitHub } from "./fake-github";

export async function text(fs: LocalFs, path: string): Promise<string> {
  return new TextDecoder().decode(await fs.read(path));
}

/** Repo with gitvault.json committed, as onboarding leaves it. */
export async function setupRepo(): Promise<{ fake: FakeGitHub; keys: VaultKeys }> {
  const fake = new FakeGitHub();
  const { config, keys } = await createVault("pw", 1000);
  await fake.putFile("gitvault.json", JSON.stringify(config), null, "gvs: init");
  return { fake, keys };
}

export function makeDevice(
  fake: FakeGitHub,
  keys: VaultKeys,
  name: string,
  opts: {
    nfd?: boolean;
    caseInsensitive?: boolean;
    settings?: Partial<EngineSettings>;
    bucket?: TokenBucket;
    confirmMassDelete?: (count: number, total: number) => Promise<boolean>;
    now?: () => number;
  } = {},
) {
  const fs = new FakeFs({ nfd: opts.nfd, caseInsensitive: opts.caseInsensitive });
  const store = new MemoryStateStore();
  const api = fake.client();
  const now = opts.now ?? (() => Date.now());
  const settings: EngineSettings = { ...DEFAULT_ENGINE_SETTINGS, configDir: ".obsidian", pluginId: "gitvault-sync", ...opts.settings }; // mutable: tests toggle settings mid-life
  const deps = {
    api, fs, keys, store, deviceName: name, now, settings,
    bucket: opts.bucket ?? new TokenBucket(20, 4, now),
    confirmMassDelete: opts.confirmMassDelete ?? (async () => true),
  };
  const engine = new SyncEngine(deps);
  /** New engine over the same disk and state, like a plugin reload. */
  const restart = () => new SyncEngine(deps);
  return { fs, store, engine, api, settings, restart };
}
