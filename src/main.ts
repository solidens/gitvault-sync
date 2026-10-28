import { isRu, t } from "./i18n";
import { moment, Notice, Platform, Plugin, TFile } from "obsidian";
import { TokenBucket } from "./bucket";
import { unlockVault, WrongPasswordError, type VaultKeys } from "./crypto";
import { DEFAULT_ENGINE_SETTINGS, SyncEngine, type SyncReport } from "./engine";
import { RestGitHub } from "./github";
import { AuthError, obsidianHttp } from "./http";
import { AdapterStateStore, ObsidianFs } from "./obsidianfs";
import { Scheduler } from "./scheduler";
import {
  confirmModal, DEFAULT_SETTINGS, defaultDeviceName, DEVICE_ID_KEY, fetchVaultConfig, GitvaultSettingTab,
  PASSWORD_KEY, StatusModal, TOKEN_KEY, unlock, type PluginSettings, type SyncEvent,
} from "./settings";

const MAX_EVENTS = 50;
const RETRY_MIN_MS = 30_000;
const RETRY_MAX_MS = 5 * 60_000;
const MOBILE_NOTICE_EVERY_MS = 10 * 60_000;
const hhmm = (ts: number) => moment(ts).format("HH:mm");
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function conflictsLabel(n: number): string {
  const d = n % 10, h = n % 100;
  const word = !isRu ? (n === 1 ? "conflict" : "conflicts") : d === 1 && h !== 11 ? "конфликт" : d >= 2 && d <= 4 && (h < 12 || h > 14) ? "конфликта" : "конфликтов";
  return `⚠ ${n} ${word}`;
}

export default class GitvaultSync extends Plugin {
  settings: PluginSettings = { ...DEFAULT_SETTINGS };
  private keys: VaultKeys | null = null;
  private engine: SyncEngine | null = null;
  private bucket = new TokenBucket(20, 4, Date.now);
  private scheduler = new Scheduler({
    run: () => this.runSync(),
    now: Date.now,
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (id) => window.clearTimeout(id),
    isVisible: () => document.visibilityState === "visible",
  });
  private paused = false;
  private status = "";
  private statusEl!: HTMLElement;
  private tab!: GitvaultSettingTab;
  private events: SyncEvent[] = [];
  private conflicts = new Set<string>();
  private warnedLarge = new Set<string>();
  private initing = false;
  private initRetryable = false; // last init failed on something transient (network, 5xx, rate limit)
  private retryTimer: number | null = null;
  private retryMs = RETRY_MIN_MS;
  private noticedAt = new Map<string, number>(); // error message -> last mobile Notice
  private gen = 0; // bumped by connect/signOut/unload: a slower init or sync started before must not apply its result

  async onload(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<PluginSettings> | null) };
    if (!this.settings.deviceName) this.settings.deviceName = defaultDeviceName();
    if (!this.app.loadLocalStorage(DEVICE_ID_KEY)) this.app.saveLocalStorage(DEVICE_ID_KEY, crypto.randomUUID());

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("gvs-status");
    this.registerDomEvent(this.statusEl, "click", () => this.showStatus());
    this.tab = new GitvaultSettingTab(this.app, this);
    this.addSettingTab(this.tab);

    this.addCommand({ id: "sync-now", name: t("Sync now", "Синхронизировать сейчас"), callback: () => this.syncNow() });
    this.addCommand({ id: "toggle-pause", name: t("Pause/resume sync", "Пауза/продолжить"), callback: () => this.togglePause() });
    this.addCommand({ id: "show-status", name: t("Show sync status", "Показать статус"), callback: () => this.showStatus() });

    this.app.workspace.onLayoutReady(() => {
      // registered after layout-ready: the vault fires "create" for every file while indexing at startup
      const changed = () => this.scheduler.onLocalChange();
      this.registerEvent(this.app.vault.on("modify", changed));
      this.registerEvent(this.app.vault.on("create", changed));
      this.registerEvent(this.app.vault.on("delete", changed));
      this.registerEvent(this.app.vault.on("rename", changed));
      this.registerDomEvent(document, "visibilitychange", () => {
        if (!this.engine && this.initRetryable && document.visibilityState === "visible") void this.init();
        else this.scheduler.onVisibilityChange();
      });
      void this.init();
    });
  }

  onunload(): void {
    this.gen++; // an in-flight sync finishes (its state matches the disk) but reports nothing
    this.clearRetry();
    void this.scheduler.stop();
  }

  token(): string | null {
    return this.app.loadLocalStorage(TOKEN_KEY) as string | null;
  }

  isRunning(): boolean {
    return this.engine !== null;
  }

  api(): RestGitHub | null {
    const token = this.token();
    return token && this.settings.owner ? new RestGitHub(obsidianHttp, this.settings.owner, this.settings.repo, () => this.token() ?? "") : null;
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.buildEngine();
  }

  /**
   * Startup (or retry): unlock with the remembered password, otherwise ask for it.
   * Transient failures retry with backoff and on returning to the app: on iOS the plugin
   * often loads offline at a cold launch and then lives for days without a reload.
   */
  private async init(): Promise<void> {
    if (this.initing || this.engine) return;
    this.clearRetry();
    this.initRetryable = false;
    const token = this.token();
    const { owner, repo } = this.settings;
    if (!token || !owner) return this.setStatus(t("✗ not connected", "✗ не подключено"));
    const password = this.app.loadLocalStorage(PASSWORD_KEY) as string | null;
    this.initing = true;
    const gen = this.gen;
    try {
      if (!password) return await unlock(this, owner, repo, token);
      const config = await fetchVaultConfig(this.api()!);
      if (gen !== this.gen) return;
      if (!config) throw new Error(t("the repository has no gitvault.json", "в репозитории нет gitvault.json"));
      const keys = await unlockVault(password, config);
      if (gen !== this.gen) return; // connect() meanwhile: these keys belong to the old repo
      this.keys = keys;
      this.retryMs = RETRY_MIN_MS;
      this.buildEngine();
      this.start();
    } catch (e) {
      if (gen !== this.gen) return; // never clear a password connect() has just saved
      if (e instanceof WrongPasswordError) {
        this.app.saveLocalStorage(PASSWORD_KEY, null);
        this.setStatus(t("✗ wrong password", "✗ неверный пароль"));
        return void unlock(this, owner, repo, token).catch((err) => this.fail(err));
      }
      this.fail(e);
      if (!(e instanceof AuthError)) this.scheduleRetry();
    } finally {
      this.initing = false;
    }
  }

  private scheduleRetry(): void {
    this.initRetryable = true;
    this.retryTimer = window.setTimeout(() => { this.retryTimer = null; void this.init(); }, this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  async connect(c: { owner: string; repo: string; token: string; keys: VaultKeys; password: string; remember: boolean; created: boolean }): Promise<void> {
    const s = this.settings;
    const gen = ++this.gen;
    this.clearRetry();
    this.initRetryable = false;
    await this.scheduler.stop(); // an in-flight sync must not save its state after this point
    if (gen !== this.gen) return; // a newer connect/sign-out won
    Object.assign(s, { owner: c.owner, repo: c.repo, rememberPassword: c.remember });
    // State is per repo; a new vault has new keys, so its old state would read as "everything was deleted remotely".
    if (c.created) await this.resetState();
    if (gen !== this.gen) return;
    this.app.saveLocalStorage(TOKEN_KEY, c.token);
    this.app.saveLocalStorage(PASSWORD_KEY, c.remember ? c.password : null);
    this.keys = c.keys;
    await this.saveSettings();
    if (gen !== this.gen) return;
    this.log(t(`Connected to ${c.owner}/${c.repo}`, `Подключено к ${c.owner}/${c.repo}`));
    new Notice(t(`Gitvault Sync: connected to ${c.owner}/${c.repo}, sync started`, `Gitvault Sync: подключено к ${c.owner}/${c.repo}, синхронизация запущена`));
    this.start();
    this.tab.update(); // the settings tab may be open behind the password modal
  }

  /** Forgets the secrets; the sync state stays so signing in again resumes without a full re-scan. */
  async signOut(): Promise<void> {
    this.gen++;
    this.app.saveLocalStorage(TOKEN_KEY, null);
    this.app.saveLocalStorage(PASSWORD_KEY, null);
    this.clearRetry();
    this.initRetryable = false;
    this.keys = this.engine = null;
    await this.scheduler.stop();
    this.setStatus(t("✗ not connected", "✗ не подключено"));
  }

  private get stateDir(): string {
    return `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
  }

  /** One state file per repo (GitHub names are [A-Za-z0-9._-] and case-insensitive). */
  private get stateFile(): string {
    return `state-${`${this.settings.owner}__${this.settings.repo}`.toLowerCase().replace(/[^a-z0-9._-]/g, "_")}.json`;
  }

  private async resetState(): Promise<void> {
    const f = `${this.stateDir}/${this.stateFile}`;
    if (await this.app.vault.adapter.exists(f)) await this.app.vault.adapter.remove(f);
  }

  /** Recreated on every settings change; it keeps nothing between syncs, so the next cycle uses the new settings. */
  private buildEngine(): void {
    const api = this.api();
    if (!this.keys || !api) return;
    const s = this.settings;
    this.engine = new SyncEngine({
      api, fs: new ObsidianFs(this.app), keys: this.keys,
      store: new AdapterStateStore(this.app.vault.adapter, this.stateDir, this.stateFile),
      deviceName: s.deviceName,
      settings: {
        ...DEFAULT_ENGINE_SETTINGS, syncConfig: s.syncConfig, ignore: s.ignore, massDeletePercent: s.massDeletePercent,
        configDir: this.app.vault.configDir, pluginId: this.manifest.id,
      },
      now: Date.now, bucket: this.bucket,
      confirmMassDelete: async (n, total) => {
        const ok = await confirmModal(this.app, t(`Sync is about to delete ${n} of ${total} files. Continue?`, `Синхронизация удалит ${n} из ${total} файлов. Продолжить?`), t("Delete", "Удалить"), t("Don't delete", "Не удалять"));
        if (!ok) this.pauseAfterDeclinedDelete(n); // otherwise the next poll asks again in a few seconds
        return ok;
      },
    });
  }

  private pauseAfterDeclinedDelete(n: number): void {
    this.paused = true;
    void this.scheduler.stop(); // not awaited: called from inside the running sync
    this.setStatus(t("⏸ deletion declined", "⏸ удаление отклонено"));
    this.log(t(`Deleting ${n} files declined, sync paused`, `Удаление ${n} файлов отклонено, синхронизация на паузе`));
    new Notice(t(`Sync paused: deleting ${n} files was declined. Resume with the "Pause/resume sync" command`, `Синхронизация на паузе: отклонено удаление ${n} файлов. Продолжить — команда «Пауза/продолжить»`));
  }

  private start(): void {
    if (!this.engine) return;
    if (this.paused) return this.setStatus(t("⏸ paused", "⏸ пауза"));
    this.scheduler.start();
    this.scheduler.runNow();
  }

  private syncNow(): void {
    if (!this.engine) return void this.init();
    if (this.paused) this.togglePause();
    else { this.scheduler.start(); this.scheduler.runNow(); } // start() again: revives the scheduler after an auth stop
  }

  private togglePause(): void {
    this.paused = !this.paused;
    if (this.paused) {
      void this.scheduler.stop();
      this.setStatus(t("⏸ paused", "⏸ пауза"));
    } else this.start();
  }

  private async runSync(): Promise<void> {
    if (!this.engine) return;
    const gen = this.gen;
    if (!this.paused) this.setStatus("↻");
    try {
      const r = await this.engine.sync();
      if (gen === this.gen) this.report(r);
    } catch (e) {
      if (gen === this.gen) this.fail(e);
    }
  }

  private report(r: SyncReport): void {
    for (const p of r.conflicts) {
      this.conflicts.add(p);
      new Notice(t(`Conflict: saved a copy ${p}`, `Конфликт: создана копия ${p}`));
      this.log(t(`Conflict: saved a copy ${p}`, `Конфликт: создана копия ${p}`), p);
    }
    for (const p of r.skippedLarge) {
      if (this.warnedLarge.has(p)) continue;
      this.warnedLarge.add(p);
      new Notice(t(`Not synced (over 50 MB): ${p}`, `Не синхронизируется (больше 50 МБ): ${p}`));
      this.log(t(`Not synced (over 50 MB): ${p}`, `Не синхронизируется (больше 50 МБ): ${p}`));
    }
    for (const p of r.skippedName) {
      if (this.warnedLarge.has(p)) continue;
      this.warnedLarge.add(p);
      new Notice(t(`Not synced (name contains * " \\ < > : | ?): ${p}`, `Не синхронизируется (недопустимые символы * " \\ < > : | ? в имени): ${p}`));
      this.log(t(`Not synced (forbidden characters in the name): ${p}`, `Не синхронизируется (недопустимые символы в имени): ${p}`));
    }
    if (r.pulled.length || r.pushed.length || r.deleted.length) {
      this.log(t(`Downloaded ${r.pulled.length}, uploaded ${r.pushed.length}, deleted ${r.deleted.length}`, `Загружено ${r.pulled.length}, отправлено ${r.pushed.length}, удалено ${r.deleted.length}`));
    }
    if (r.pulled.some((p) => p.startsWith(this.app.vault.configDir + "/"))) {
      new Notice(t("Settings updated: restart Obsidian to apply them", "Настройки обновлены: применятся после перезапуска Obsidian"));
    }
    if (r.rateLimitedUntil) {
      this.scheduler.pauseUntil(r.rateLimitedUntil);
      this.log(t(`GitHub rate limit, paused until ${hhmm(r.rateLimitedUntil)}`, `Лимит GitHub, пауза до ${hhmm(r.rateLimitedUntil)}`));
      if (!this.paused) {
        this.setStatus(t(`⏸ GitHub limit until ${hhmm(r.rateLimitedUntil)}`, `⏸ лимит GitHub до ${hhmm(r.rateLimitedUntil)}`));
        this.mobileNotice("лимит GitHub", t(`⏸ GitHub limit until ${hhmm(r.rateLimitedUntil)}`, `⏸ лимит GitHub до ${hhmm(r.rateLimitedUntil)}`));
      }
      return;
    }
    if (r.gaveUp.length) this.log(t(`Could not upload ${r.gaveUp.length}: GitHub changed during the upload, will retry`, `Не удалось отправить ${r.gaveUp.length}: GitHub менялся во время отправки, повтор позже`));
    // a conflict counts until the user deletes its copy
    for (const p of this.conflicts) if (!this.app.vault.getAbstractFileByPath(p)) this.conflicts.delete(p);
    if (this.paused) return;
    this.setStatus(r.gaveUp.length ? t(`⚠ ${r.gaveUp.length} not uploaded`, `⚠ не удалось отправить ${r.gaveUp.length}`)
      : this.conflicts.size ? conflictsLabel(this.conflicts.size) : `✓ ${hhmm(Date.now())}`);
  }

  private fail(e: unknown): void {
    if (e instanceof AuthError) void this.scheduler.stop();
    const msg = e instanceof AuthError ? t("sign in again", "войдите снова") : errText(e);
    this.log(t(`Error: ${msg}`, `Ошибка: ${msg}`));
    if (this.paused) return;
    this.setStatus(`✗ ${msg}`);
    this.mobileNotice(msg, `✗ ${msg}`);
  }

  /** No status bar on mobile: surface it as a Notice, at most once per key per 10 min. */
  private mobileNotice(key: string, text: string): void {
    const last = this.noticedAt.get(key) ?? -Infinity;
    if (Platform.isMobile && Date.now() - last >= MOBILE_NOTICE_EVERY_MS) {
      this.noticedAt.set(key, Date.now());
      new Notice(`Gitvault Sync: ${text}`);
    }
  }

  private log(text: string, path?: string): void {
    this.events.push({ at: Date.now(), text, path });
    if (this.events.length > MAX_EVENTS) this.events.shift();
  }

  private setStatus(text: string): void {
    this.status = text;
    this.statusEl.setText(text);
  }

  private showStatus(): void {
    new StatusModal(this.app, this.status, this.events, (path) => {
      const f = this.app.vault.getAbstractFileByPath(path);
      if (f instanceof TFile) void this.app.workspace.getLeaf(true).openFile(f);
    }).open();
  }
}
