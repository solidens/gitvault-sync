import type { TokenBucket } from "./bucket";
import { decryptFile, encryptFile, pathToken, type VaultKeys } from "./crypto";
import type { GitHubApi } from "./github";
import { AuthError, RateLimitError, ShaConflictError } from "./http";
import { LocalChangedError, type LocalFs } from "./localfs";
import { isMergeablePath, MAX_MERGE_BYTES, merge3, mergeJson, tryDecodeUtf8 } from "./merge";
import { emptyState, type StateStore, type SyncState } from "./state";
import { alwaysIgnored, conflictPath, gitBlobSha, isIgnored, nfc, repoPath, sha256Hex } from "./util";

export interface EngineSettings {
  syncConfig: boolean; ignore: string[];
  batchThreshold: number;     // 5
  tarballThreshold: number;   // 300
  massDeletePercent: number;  // 20
  massDeleteMin: number;      // 10
  maxFileBytes: number;       // 50 * 1024 * 1024
  configDir: string;          // app.vault.configDir, ".obsidian" by default
  pluginId: string;           // manifest.id
}
/** gaveUp: local changes not sent because GitHub kept moving (sha conflicts); the next cycle tries again. */
export interface SyncReport { pulled: string[]; pushed: string[]; deleted: string[]; conflicts: string[]; deferred: string[]; skippedLarge: string[]; gaveUp: string[]; rateLimitedUntil?: number }
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
  configDir: ".obsidian", pluginId: "gitvault-sync",
};

const CONFIG_FILE = "gitvault.json";
export const UNDECRYPTABLE = "Файл на GitHub не расшифровывается — пароль или gitvault.json изменились";

/** localHash of a remote file kept only as a conflict copy because its path differs from a local one only by case. */
const CASE_COLLISION = "case-collision";

interface Local { diskPath: string; mtime: number; size: number; hash: string }
interface Remote { token: string; sha: string; data?: ArrayBuffer }
/** local null = delete on GitHub; prev = blob sha currently on GitHub (null = new file). */
interface Push { path: string; token: string; prev: string | null; local: Local | null }

/** Push rejected because GitHub moved (409/422): re-run the cycle (pull, merge, push) at most this often. */
const MAX_SHA_RETRIES = 3;
/** Refused compare-and-swap writes of an unchanged file before falling back to a byte check. */
const MAX_REFUSALS = 3;

export class SyncEngine {
  private tarball = new Map<string, string>(); // blob sha -> ciphertext from this cycle's tarball
  private unpushed = new Set<string>(); // paths of the current push not sent yet
  private refused = new Map<string, { disk: string; n: number }>(); // path -> CAS refusals in a row while the disk stayed the same
  constructor(private d: EngineDeps) {}

  /** AuthError is rethrown (caller pauses); rate limits and persistent sha conflicts end the cycle with a report. */
  async sync(): Promise<SyncReport> {
    const report: SyncReport = { pulled: [], pushed: [], deleted: [], conflicts: [], deferred: [], skippedLarge: [], gaveUp: [] };
    try {
      for (let retry = 0; ; retry++) {
        const state = (await this.d.store.load()) ?? emptyState();
        try {
          await this.cycle(state, report, retry > 0);
          return report;
        } catch (e) {
          // every state change so far matches the disk; a failing save must not hide the original error
          await this.d.store.save(state).catch(() => {});
          if (e instanceof RateLimitError) return { ...report, rateLimitedUntil: e.resetAt };
          if (!(e instanceof ShaConflictError)) throw e;
          if (retry === MAX_SHA_RETRIES) return { ...report, gaveUp: [...this.unpushed] }; // local content is on disk; next cycle tries again
        }
      }
    } finally {
      this.tarball.clear();
      this.unpushed.clear();
    }
  }

  /** One pass. repoll = skip the ETag so a retry after a sha conflict sees the new head. */
  private async cycle(state: SyncState, report: SyncReport, repoll: boolean): Promise<void> {
    const { api, fs, keys, store, settings } = this.d;
    report.deferred = []; report.skippedLarge = []; // describe the latest pass; the other lists accumulate across retries
    const first = Object.entries(state.files)[0];
    // records made with other keys: the user unlocked a vault re-created meanwhile, so this state describes nothing
    if (first && await pathToken(keys, first[0]) !== first[1].token) Object.assign(state, emptyState(), { filter: undefined, skipped: undefined, configSha: undefined });
    const fresh = state.headSha === null && Object.keys(state.files).length === 0;
    if (fresh) state.rebinding = true; // survives an interrupted first cycle, which leaves some records behind
    const ignore = [...alwaysIgnored(settings.configDir, settings.pluginId), ...settings.ignore];
    const tooLarge = new Set<string>();
    const skip = (p: string) =>
      tooLarge.has(p) || isIgnored(p, ignore) || (!settings.syncConfig && p.startsWith(settings.configDir + "/"));

    // Skip rules changed -> refetch the full tree so files that just became visible are seen as remote, not as new.
    const filter = JSON.stringify([settings.syncConfig, settings.ignore, settings.maxFileBytes, settings.configDir]);
    if (state.filter !== filter) {
      state.headSha = state.refEtag = null;
      state.filter = filter;
    }

    // 1. Poll. headSha/refEtag only decide whether to fetch the tree; changes are detected per file.
    const head = await api.getHead(repoll ? null : state.refEtag);
    let base = state.headSha; // commit the batch path builds on; null = empty repo (putFile only)
    let tree: Map<string, string> | null = null;
    if (!head.notModified) {
      base = head.sha;
      // a retry re-reads the tree even on an unchanged head: the conflict may come from a stale state record
      if (repoll || head.sha !== state.headSha) tree = head.sha === null ? new Map() : await api.getTree(head.sha);
    }

    if (tree) { // gitvault.json replaced (vault re-created elsewhere): our keys can't read the new files
      const cfg = tree.get(CONFIG_FILE);
      if (cfg && state.configSha && cfg !== state.configSha && Object.keys(state.files).length) throw new Error(UNDECRYPTABLE);
      if (cfg) state.configSha = cfg;
    }

    // 2. Local scan: rehash only files whose mtime/size changed.
    const local = new Map<string, Local>();
    const lower = new Map<string, string>(); // lowercased -> path of every file on disk, synced or not (case-insensitive disks)
    for (const st of await fs.list(settings.syncConfig)) {
      const p = nfc(st.path);
      lower.set(p.toLowerCase(), p);
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
    if (tree && base) await this.prefetch(base, tree, state, fresh);
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

    // Empty-storage rule: one side empty while we tracked many files is a first load, never "everything was deleted".
    const total = Object.keys(state.files).length;
    if (total > settings.massDeleteMin && ((tree && remoteTokens.size === 0 && local.size > 0) || (local.size === 0 && remoteTokens.size > 0))) {
      state.files = {};
    }

    // 3. Pull / decide pushes. Deletions are collected and run after the mass-delete guard.
    let pushes: Push[] = [];
    const trashes: { p: string; loc: Local }[] = [];
    const created = new Map<string, number>(); // localHash -> files new this cycle; each offsets one deletion (a rename)
    const create = (h: string) => created.set(h, (created.get(h) ?? 0) + 1);
    let again = false; // something waits for the next cycle: keep the old head
    const taken = (q: string) => local.has(q) || remote.has(q) || !!state.files[q];
    // compare-and-swap write; null = the user changed the file meanwhile (deferred to the next cycle)
    const put = async (q: string, data: ArrayBuffer, expected: ArrayBuffer | null) => {
      try {
        const st = await fs.write(q, data, expected);
        this.refused.delete(q);
        return st;
      } catch (e) {
        if (!(e instanceof LocalChangedError)) throw e;
        const st = expected && await fs.stat(q);
        if (!st) return null;
        const disk = `${st.mtime}:${st.size}`, r = this.refused.get(q);
        const n = r?.disk === disk ? r.n + 1 : 1;
        this.refused.set(q, { disk, n });
        // backstop: the editor-level check keeps refusing although the file on disk never changed (a text
        // normalization we don't know about): fall back to a byte check and a plain write
        if (n < MAX_REFUSALS || (await sha256Hex(await fs.read(q))) !== (await sha256Hex(expected))) return null;
        this.refused.delete(q);
        return fs.write(q, data);
      }
    };
    const newPush = async (q: string, st: { mtime: number; size: number }, hash: string): Promise<Push> =>
      ({ path: q, token: await pathToken(keys, q), prev: null, local: { diskPath: q, mtime: st.mtime, size: st.size, hash } });
    for (const p of new Set([...Object.keys(state.files), ...local.keys(), ...remote.keys()])) {
      if (skip(p)) continue;
      const rec = state.files[p], loc = local.get(p);
      let rem = remote.get(p);
      if (!rec && !rem && loc) { // defense in depth: never create over an existing remote file
        const token = await pathToken(keys, p), sha = remoteTokens.get(token);
        if (sha !== undefined) rem = { token, sha };
      }
      // a case-collision record was never on disk under this path, so its absence is not a local delete
      const localChanged = rec ? !(rec.localHash === CASE_COLLISION && !loc) && loc?.hash !== rec.localHash : !!loc;
      const remoteChanged = rec ? rem?.sha !== rec.blobSha : !!rem;
      if (!localChanged && !remoteChanged) continue;

      if (!remoteChanged) {
        if (!rec && loc) create(loc.hash);
        pushes.push({ path: p, token: rec?.token ?? await pathToken(keys, p), prev: rem?.sha ?? null, local: loc ?? null });
        continue;
      }
      if (!rem) { // deleted on GitHub (rec exists)
        if (loc && localChanged) { // edit beats delete; uploaded as new, so drop the record of the deleted remote blob
          pushes.push({ path: p, token: rec!.token, prev: null, local: loc });
          delete state.files[p];
        } else if (loc) trashes.push({ p, loc });
        else delete state.files[p];
        continue;
      }
      const data = rem.data ?? (await this.download(rem.sha)).data;
      const hash = await sha256Hex(data);
      const synced = (st: { mtime: number; size: number }) =>
        state.files[p] = { token: rem.token, blobSha: rem.sha, localHash: hash, mtime: st.mtime, size: st.size };
      if (loc && hash === loc.hash) { synced(loc); continue; } // both sides already agree (e.g. crash after PUT before state save)

      if (!loc) { // new on GitHub, or edited there and deleted here (edit beats delete)
        const other = lower.get(p.toLowerCase());
        // p not scanned but the disk finds it: a case-insensitive disk resolves p to `other`
        const collides = !!other && other !== p && !!(await fs.stat(p));
        if (collides && trashes.some((t) => t.p === other)) { // case-only rename: write once the old name is gone
          if (!rec) create(hash);
          again = true;
          continue;
        }
        if (collides) { // writing would overwrite `other`
          const cp = await this.conflictName(p, taken);
          const st = await put(cp, data, null);
          if (!st) { report.deferred.push(p); continue; }
          lower.set(cp.toLowerCase(), cp);
          state.files[p] = { token: rem.token, blobSha: rem.sha, localHash: CASE_COLLISION, mtime: -1, size: -1 };
          pushes.push(await newPush(cp, st, hash));
          report.conflicts.push(cp);
          continue;
        }
        const st = await put(p, data, null);
        if (!st) { report.deferred.push(p); continue; }
        if (!rec) create(hash);
        synced(st);
        lower.set(p.toLowerCase(), p);
        report.pulled.push(p);
        continue;
      }
      // remote changed and local unchanged, or (rebind without state only) local is an old remote version;
      // with state, a new local file matching an old version is a deliberate re-creation (e.g. renamed back), never stale
      if (!localChanged || (!rec && state.rebinding && await this.isOldVersion(rem.token, loc.hash))) {
        const cur = await this.scanned(loc);
        const st = cur && await put(loc.diskPath, data, cur);
        if (!st) { report.deferred.push(p); continue; }
        synced(st);
        report.pulled.push(p);
        continue;
      }

      // changed on both sides
      const mine = await this.scanned(loc);
      if (!mine) { report.deferred.push(p); continue; }
      const merged = await this.merge(p, rec?.blobSha, mine, data);
      if (merged !== null) {
        const out = new TextEncoder().encode(merged).buffer as ArrayBuffer;
        const mh = await sha256Hex(out);
        const st = mh === loc.hash ? loc : await put(loc.diskPath, mh === hash ? data : out, mine);
        if (!st) { report.deferred.push(p); continue; }
        if (mh === hash) { synced(st); report.pulled.push(p); continue; }
        if (mh !== loc.hash) report.pulled.push(p);
        // base = remote; mtime -1 forces a rehash so the merge is re-pushed if this cycle's push doesn't happen
        state.files[p] = { token: rem.token, blobSha: rem.sha, localHash: hash, mtime: -1, size: -1 };
        pushes.push({ path: p, token: rem.token, prev: rem.sha, local: { diskPath: loc.diskPath, mtime: st.mtime, size: st.size, hash: mh } });
        continue;
      }
      // conflict copy: local version under a new name, remote keeps the path.
      // CAS-check the target first (same bytes back): a user typing in it defers without leaving a copy behind
      if (!(await put(loc.diskPath, mine, mine))) { report.deferred.push(p); continue; }
      const cp = await this.conflictName(p, taken);
      const cst = await put(cp, mine, null);
      if (!cst) { report.deferred.push(p); continue; }
      lower.set(cp.toLowerCase(), cp);
      pushes.push(await newPush(cp, cst, loc.hash));
      report.conflicts.push(cp);
      const st = await put(loc.diskPath, data, mine);
      if (!st) { report.deferred.push(p); continue; } // the copy is pushed; p is merged again next cycle
      synced(st);
      report.pulled.push(p);
    }

    // Mass-delete guard (both directions); renames don't count.
    const deletions = [...trashes.map((t) => t.p), ...pushes.filter((x) => !x.local).map((x) => x.path)]
      .filter((p) => {
        const h = state.files[p].localHash, n = created.get(h) ?? 0;
        if (n) created.set(h, n - 1);
        return !n;
      });
    const deleteOk = !(deletions.length > total * settings.massDeletePercent / 100 && deletions.length > settings.massDeleteMin)
      || await this.d.confirmMassDelete(deletions.length, total);
    if (deleteOk) {
      for (const { p, loc } of trashes) {
        if (!(await this.scanned(loc))) { report.deferred.push(p); continue; }
        await fs.trash(loc.diskPath);
        report.deleted.push(p);
        delete state.files[p];
      }
    } else pushes = pushes.filter((x) => x.local);

    // Keep the old head when something was put off, so the next cycle sees those remote changes again.
    if (!head.notModified && deleteOk && !again && !report.deferred.length) {
      state.headSha = head.sha;
      state.refEtag = head.etag || null;
      delete state.rebinding; // bind completed
    }
    await store.save(state);

    // 4. Push.
    if (pushes.length) await this.push(state, pushes, base, report);
  }

  /** One tarball instead of per-file blobs: first load of a device, or more than tarballThreshold blobs to fetch. */
  private async prefetch(headSha: string, tree: Map<string, string>, state: SyncState, fresh: boolean): Promise<void> {
    const known = new Map(Object.values(state.files).map((r) => [r.token, r.blobSha]));
    let n = 0;
    for (const [rp, sha] of tree) {
      const token = rp.slice(rp.lastIndexOf("/") + 1);
      if (rp.startsWith("f/") && known.get(token) !== sha && state.skipped?.[token]?.blobSha !== sha) n++;
    }
    if (!(n > this.d.settings.tarballThreshold || (fresh && n > 0))) return;
    let files: Map<string, string>;
    try {
      files = await this.d.api.getTarball(headSha);
    } catch (e) {
      if (e instanceof RateLimitError || e instanceof AuthError) throw e;
      return; // e.g. no DecompressionStream: fall back to per-file blobs
    }
    for (const [rp, sha] of tree) {
      const t = files.get(rp);
      if (t !== undefined) this.tarball.set(sha, t);
    }
  }

  /** Rebind without state: does the local file equal one of the last 20 remote versions (an outdated copy)? */
  private async isOldVersion(token: string, localHash: string): Promise<boolean> {
    try {
      for (const sha of await this.d.api.fileHistoryBlobShas(repoPath(token), 20)) {
        if ((await sha256Hex((await this.download(sha)).data)) === localHash) return true;
      }
    } catch (e) {
      if (e instanceof RateLimitError || e instanceof AuthError) throw e;
    }
    return false; // unknown -> conflict copy, which loses nothing
  }

  /** Current bytes of a scanned file, or null when they no longer match the scan (the user is editing it). */
  private async scanned(loc: Local): Promise<ArrayBuffer | null> {
    if (!(await this.d.fs.stat(loc.diskPath))) return null;
    const cur = await this.d.fs.read(loc.diskPath);
    return (await sha256Hex(cur)) === loc.hash ? cur : null;
  }

  /** Merged text, or null when a conflict copy is needed. Base = last synced blob; unfetchable base = no base. */
  private async merge(p: string, baseSha: string | undefined, mine: ArrayBuffer, theirs: ArrayBuffer): Promise<string | null> {
    const json = p.startsWith(this.d.settings.configDir + "/") && p.endsWith(".json");
    if (!(json || isMergeablePath(p)) || mine.byteLength > MAX_MERGE_BYTES || theirs.byteLength > MAX_MERGE_BYTES) return null;
    const local = tryDecodeUtf8(mine), remote = tryDecodeUtf8(theirs);
    if (local === null || remote === null) return null;
    let base: string | null = null;
    if (baseSha !== undefined) {
      try { base = tryDecodeUtf8((await this.download(baseSha)).data); } catch { base = null; }
    }
    if (json) return mergeJson(base, local, remote);
    return base === null ? null : merge3(base, local, remote);
  }

  private async conflictName(p: string, taken: (q: string) => boolean): Promise<string> {
    const c = nfc(conflictPath(p, this.d.deviceName, new Date(this.d.now())));
    const i = c.lastIndexOf(")");
    for (let n = 1; ; n++) {
      const q = n === 1 ? c : `${c.slice(0, i + 1)} ${n}${c.slice(i + 1)}`;
      if (!taken(q) && !(await this.d.fs.stat(q))) return q;
    }
  }

  private async download(blobSha: string): Promise<{ path: string; data: ArrayBuffer }> {
    const text = this.tarball.get(blobSha) ?? await this.d.api.getBlobText(blobSha);
    let f: { path: string; data: ArrayBuffer };
    try { f = await decryptFile(this.d.keys, text); } catch { throw new Error(UNDECRYPTABLE); }
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
      this.unpushed.delete(x.path);
    };
    const forget = (x: Push) => { delete state.files[x.path]; report.deleted.push(x.path); this.unpushed.delete(x.path); };
    this.unpushed = new Set(pushes.map((x) => x.path));
    const limited = (n: number) => { report.rateLimitedUntil = now() + bucket.msUntil(n); };

    // Git Data API needs an existing commit, so an empty repo always goes file by file.
    if (base !== null && pushes.length > settings.batchThreshold) {
      if (!bucket.tryTake(3)) return limited(3);
      // encrypted lazily, chunk by chunk; only blob sha + hash are kept
      const sent = new Map<string, { blobSha: string; hash: string }>();
      const changes = pushes.map((x) => ({
        path: repoPath(x.token),
        text: x.local ? async () => {
          const e = await encrypt(x, x.local!);
          sent.set(x.path, { blobSha: await gitBlobSha(e.text), hash: e.hash });
          return e.text;
        } : null,
      }));
      await api.commitBatch(base, changes, msg(pushes.length));
      for (const x of pushes) {
        const e = sent.get(x.path);
        if (!x.local) forget(x);
        else if (e) record(x, x.local, e.blobSha, e.hash);
        else throw new Error(`batch did not send ${x.path}`);
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
