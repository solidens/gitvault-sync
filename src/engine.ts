import type { TokenBucket } from "./bucket";
import { decryptFile, encryptFile, pathToken, type VaultKeys } from "./crypto";
import type { GitHubApi } from "./github";
import type { LocalFs } from "./localfs";
import { emptyState, type StateStore, type SyncState } from "./state";
import { ALWAYS_IGNORED, gitBlobSha, isIgnored, nfc, repoPath, sha256Hex } from "./util";

export interface EngineSettings {
  syncConfig: boolean; ignore: string[];
  batchThreshold: number;     // 5
  tarballThreshold: number;   // 300
  massDeletePercent: number;  // 20
  massDeleteMin: number;      // 10
  maxFileBytes: number;       // 50 * 1024 * 1024
}
export interface SyncReport { pulled: string[]; pushed: string[]; deleted: string[]; conflicts: string[]; deferred: string[]; skippedLarge: string[]; rateLimitedUntil?: number }
export interface EngineDeps {
  api: GitHubApi; fs: LocalFs; keys: VaultKeys; store: StateStore; deviceName: string;
  settings: EngineSettings; now: () => number; bucket: TokenBucket;
  confirmMassDelete: (count: number, total: number) => Promise<boolean>;
}

export const DEFAULT_ENGINE_SETTINGS: EngineSettings = {
  syncConfig: false, ignore: [],
  batchThreshold: 5, tarballThreshold: 300,
  massDeletePercent: 20, massDeleteMin: 10,
  maxFileBytes: 50 * 1024 * 1024,
};

interface Local { diskPath: string; mtime: number; size: number; hash: string }
interface Remote { token: string; sha: string; data?: ArrayBuffer }
/** local null = delete on GitHub; prev = blob sha currently on GitHub (null = new file). */
interface Push { path: string; token: string; prev: string | null; local: Local | null }

export class SyncEngine {
  constructor(private d: EngineDeps) {}

  async sync(): Promise<SyncReport> {
    const { api, fs, keys, store, settings } = this.d;
    const state = (await store.load()) ?? emptyState();
    const report: SyncReport = { pulled: [], pushed: [], deleted: [], conflicts: [], deferred: [], skippedLarge: [] };
    const ignore = [...ALWAYS_IGNORED, ...settings.ignore];
    const tooLarge = new Set<string>();
    const skip = (p: string) =>
      tooLarge.has(p) || isIgnored(p, ignore) || (!settings.syncConfig && p.startsWith(".obsidian/"));

    // Skip rules changed -> refetch the full tree so files that just became visible are seen as remote, not as new.
    const filter = JSON.stringify([settings.syncConfig, settings.ignore, settings.maxFileBytes]);
    if (state.filter !== filter) {
      state.headSha = state.refEtag = null;
      state.filter = filter;
    }

    // 1. Poll. headSha/refEtag only decide whether to fetch the tree; changes are detected per file.
    const head = await api.getHead(state.refEtag);
    let base = state.headSha; // commit the batch path builds on; null = empty repo (putFile only)
    let tree: Map<string, string> | null = null;
    if (!head.notModified) {
      base = head.sha;
      if (head.sha !== state.headSha) tree = head.sha === null ? new Map() : await api.getTree(head.sha);
    }

    // 2. Local scan: rehash only files whose mtime/size changed.
    const local = new Map<string, Local>();
    for (const st of await fs.list(settings.syncConfig)) {
      const p = nfc(st.path);
      if (skip(p)) continue;
      if (st.size > settings.maxFileBytes) {
        tooLarge.add(p);
        report.skippedLarge.push(p);
        continue;
      }
      const rec = state.files[p];
      const hash = rec && rec.mtime === st.mtime && rec.size === st.size
        ? rec.localHash
        : await sha256Hex(await fs.read(st.path));
      local.set(p, { diskPath: st.path, mtime: st.mtime, size: st.size, hash });
    }

    // Remote view: from the tree if the branch moved, otherwise what we last saw (synced + skipped files).
    const remote = new Map<string, Remote>();
    const remoteTokens = new Map<string, string>(); // token -> blob sha of every known remote vault file
    const skipped: NonNullable<SyncState["skipped"]> = {};
    const addRemote = async (token: string, sha: string, known?: string) => {
      remoteTokens.set(token, sha);
      if (known !== undefined) return void remote.set(known, { token, sha });
      const cached = state.skipped?.[token];
      // unknown token: only the content knows its path
      const f = cached?.blobSha === sha ? { path: cached.path, data: undefined } : await this.download(sha);
      if (skip(f.path)) skipped[token] = { blobSha: sha, path: f.path };
      else remote.set(f.path, { token, sha, data: f.data });
    };
    const byToken = new Map(Object.entries(state.files).map(([p, r]) => [r.token, p]));
    if (tree) {
      for (const [rp, sha] of tree) {
        if (!rp.startsWith("f/")) continue; // gitvault.json etc.
        const token = rp.slice(rp.lastIndexOf("/") + 1);
        await addRemote(token, sha, byToken.get(token));
      }
    } else {
      for (const [token, p] of byToken) await addRemote(token, state.files[p].blobSha, p);
      for (const [token, e] of Object.entries(state.skipped ?? {})) await addRemote(token, e.blobSha);
    }
    state.skipped = skipped;

    // 3. Pull / decide pushes.
    const pushes: Push[] = [];
    for (const p of new Set([...Object.keys(state.files), ...local.keys(), ...remote.keys()])) {
      if (skip(p)) continue;
      const rec = state.files[p], loc = local.get(p);
      let rem = remote.get(p);
      if (!rec && !rem && loc) { // defense in depth: never create over an existing remote file
        const token = await pathToken(keys, p), sha = remoteTokens.get(token);
        if (sha !== undefined) rem = { token, sha };
      }
      const localChanged = rec ? loc?.hash !== rec.localHash : !!loc;
      const remoteChanged = rec ? rem?.sha !== rec.blobSha : !!rem;
      if (!localChanged && !remoteChanged) continue;

      if (!remoteChanged) {
        pushes.push({ path: p, token: rec?.token ?? await pathToken(keys, p), prev: rem?.sha ?? null, local: loc ?? null });
        continue;
      }
      if (!rem) { // deleted on GitHub (rec exists)
        if (loc && localChanged) pushes.push({ path: p, token: rec!.token, prev: null, local: loc }); // edit beats delete
        else {
          if (loc) { await fs.trash(loc.diskPath); report.deleted.push(p); }
          delete state.files[p];
        }
        continue;
      }
      const data = rem.data ?? (await this.download(rem.sha)).data;
      const hash = await sha256Hex(data);
      if (loc && hash === loc.hash) { // both sides already agree (e.g. crash after PUT before state save)
        state.files[p] = { token: rem.token, blobSha: rem.sha, localHash: hash, mtime: loc.mtime, size: loc.size };
        continue;
      }
      if (loc && localChanged) throw new Error("conflict: Task 9");
      // remote changed, local unchanged or deleted locally (edit beats delete)
      const st = await fs.write(loc?.diskPath ?? p, data);
      state.files[p] = { token: rem.token, blobSha: rem.sha, localHash: hash, mtime: st.mtime, size: st.size };
      report.pulled.push(p);
    }
    if (!head.notModified) {
      state.headSha = head.sha;
      state.refEtag = head.etag || null;
    }
    await store.save(state);

    // 4. Push.
    if (pushes.length) await this.push(state, pushes, base, report);
    return report;
  }

  private async download(blobSha: string): Promise<{ path: string; data: ArrayBuffer }> {
    const f = await decryptFile(this.d.keys, await this.d.api.getBlobText(blobSha));
    return { path: nfc(f.path), data: f.data };
  }

  private async push(state: SyncState, pushes: Push[], base: string | null, report: SyncReport): Promise<void> {
    const { api, fs, keys, store, bucket, now, deviceName, settings } = this.d;
    const msg = (n: number) => `gvs: ${deviceName} ${n} file(s)`;
    const encrypt = async (x: Push, l: Local) => {
      const data = await fs.read(l.diskPath);
      return { text: await encryptFile(keys, x.path, data), hash: await sha256Hex(data) };
    };
    // mtime/size from the scan, hash of the bytes actually pushed: a later edit shows up as a new mtime -> rehash.
    const record = (x: Push, l: Local, blobSha: string, hash: string) => {
      state.files[x.path] = { token: x.token, blobSha, localHash: hash, mtime: l.mtime, size: l.size };
      report.pushed.push(x.path);
    };
    const forget = (x: Push) => { delete state.files[x.path]; report.deleted.push(x.path); };
    const limited = (n: number) => { report.rateLimitedUntil = now() + bucket.msUntil(n); };

    // Git Data API needs an existing commit, so an empty repo always goes file by file.
    if (base !== null && pushes.length > settings.batchThreshold) {
      if (!bucket.tryTake(3)) return limited(3);
      // shortcut: one request for the whole batch; split into ~20 MB chunks when first uploads of big vaults hit the request limit.
      const items = await Promise.all(pushes.map(async (x) => ({ x, e: x.local ? await encrypt(x, x.local) : null })));
      await api.commitBatch(base, items.map(({ x, e }) => ({ path: repoPath(x.token), text: e?.text ?? null })), msg(pushes.length));
      for (const { x, e } of items) {
        if (x.local && e) record(x, x.local, await gitBlobSha(e.text), e.hash);
        else forget(x);
      }
      await store.save(state);
      return;
    }
    for (const x of pushes) {
      if (!bucket.tryTake(1)) return limited(1);
      if (x.local) {
        const e = await encrypt(x, x.local);
        const r = await api.putFile(repoPath(x.token), e.text, x.prev, msg(1));
        record(x, x.local, r.blobSha, e.hash);
      } else {
        await api.deleteFile(repoPath(x.token), x.prev!, msg(1));
        forget(x);
      }
      await store.save(state);
    }
  }
}
