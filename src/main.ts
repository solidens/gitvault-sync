import { moment, Notice, Plugin, TFile } from "obsidian";
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
const hhmm = (ts: number) => moment(ts).format("HH:mm");
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function conflictsLabel(n: number): string {
  const d = n % 10, h = n % 100;
  const word = d === 1 && h !== 11 ? "конфликт" : d >= 2 && d <= 4 && (h < 12 || h > 14) ? "конфликта" : "конфликтов";
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
  private events: SyncEvent[] = [];
  private conflicts = new Set<string>();
  private warnedLarge = new Set<string>();

  async onload(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
    if (!this.settings.deviceName) this.settings.deviceName = defaultDeviceName();
    if (!this.app.loadLocalStorage(DEVICE_ID_KEY)) this.app.saveLocalStorage(DEVICE_ID_KEY, crypto.randomUUID());

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("gvs-status");
    this.registerDomEvent(this.statusEl, "click", () => this.showStatus());
    this.addSettingTab(new GitvaultSettingTab(this.app, this));

    this.addCommand({ id: "sync-now", name: "Синхронизировать сейчас", callback: () => this.syncNow() });
    this.addCommand({ id: "toggle-pause", name: "Пауза/продолжить", callback: () => this.togglePause() });
    this.addCommand({ id: "show-status", name: "Показать статус", callback: () => this.showStatus() });

    this.app.workspace.onLayoutReady(() => {
      // registered after layout-ready: the vault fires "create" for every file while indexing at startup
      const changed = () => this.scheduler.onLocalChange();
      this.registerEvent(this.app.vault.on("modify", changed));
      this.registerEvent(this.app.vault.on("create", changed));
      this.registerEvent(this.app.vault.on("delete", changed));
      this.registerEvent(this.app.vault.on("rename", changed));
      this.registerDomEvent(document, "visibilitychange", () => this.scheduler.onVisibilityChange());
      void this.init();
    });
  }

  onunload(): void {
    this.scheduler.stop();
  }

  token(): string | null {
    return this.app.loadLocalStorage(TOKEN_KEY);
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

  /** Startup (or retry): unlock with the remembered password, otherwise ask for it. */
  private async init(): Promise<void> {
    const token = this.token();
    const { owner, repo } = this.settings;
    if (!token || !owner) return this.setStatus("✗ не подключено");
    const password = this.app.loadLocalStorage(PASSWORD_KEY);
    try {
      if (!password) return await unlock(this, owner, repo, token);
      const config = await fetchVaultConfig(this.api()!);
      if (!config) throw new Error("в репозитории нет gitvault.json");
      this.keys = await unlockVault(password, config);
      this.buildEngine();
      this.start();
    } catch (e) {
      if (e instanceof WrongPasswordError) {
        this.app.saveLocalStorage(PASSWORD_KEY, null);
        this.setStatus("✗ неверный пароль");
        return void unlock(this, owner, repo, token).catch((err) => this.fail(err));
      }
      this.fail(e);
    }
  }

  async connect(c: { owner: string; repo: string; token: string; keys: VaultKeys; password: string; remember: boolean; created: boolean }): Promise<void> {
    const s = this.settings;
    // State tracked for another repo or older keys would read as "everything was deleted remotely".
    if (c.created || s.owner !== c.owner || s.repo !== c.repo) await this.resetState();
    this.app.saveLocalStorage(TOKEN_KEY, c.token);
    this.app.saveLocalStorage(PASSWORD_KEY, c.remember ? c.password : null);
    Object.assign(s, { owner: c.owner, repo: c.repo, rememberPassword: c.remember });
    this.keys = c.keys;
    await this.saveSettings();
    this.log(`Подключено к ${c.owner}/${c.repo}`);
    this.start();
  }

  /** Forgets the secrets; the sync state stays so signing in again resumes without a full re-scan. */
  signOut(): void {
    this.app.saveLocalStorage(TOKEN_KEY, null);
    this.app.saveLocalStorage(PASSWORD_KEY, null);
    this.scheduler.stop();
    this.keys = this.engine = null;
    this.setStatus("✗ не подключено");
  }

  private get stateDir(): string {
    return `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
  }

  private async resetState(): Promise<void> {
    const f = `${this.stateDir}/state.json`;
    if (await this.app.vault.adapter.exists(f)) await this.app.vault.adapter.remove(f);
  }

  /** Recreated on every settings change; it keeps nothing between syncs, so the next cycle uses the new settings. */
  private buildEngine(): void {
    const api = this.api();
    if (!this.keys || !api) return;
    const s = this.settings;
    this.engine = new SyncEngine({
      api, fs: new ObsidianFs(this.app), keys: this.keys,
      store: new AdapterStateStore(this.app.vault.adapter, this.stateDir),
      deviceName: s.deviceName,
      settings: { ...DEFAULT_ENGINE_SETTINGS, syncConfig: s.syncConfig, ignore: s.ignore, massDeletePercent: s.massDeletePercent },
      now: Date.now, bucket: this.bucket,
      confirmMassDelete: (n, total) =>
        confirmModal(this.app, `Синхронизация удалит ${n} из ${total} файлов. Продолжить?`, "Удалить", "Не удалять"),
    });
  }

  private start(): void {
    if (!this.engine) return;
    if (this.paused) return this.setStatus("⏸ пауза");
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
      this.scheduler.stop();
      this.setStatus("⏸ пауза");
    } else this.start();
  }

  private async runSync(): Promise<void> {
    if (!this.engine) return;
    this.setStatus("↻");
    try {
      this.report(await this.engine.sync());
    } catch (e) {
      this.fail(e);
    }
  }

  private report(r: SyncReport): void {
    for (const p of r.conflicts) {
      this.conflicts.add(p);
      new Notice(`Конфликт: создана копия ${p}`);
      this.log(`Конфликт: создана копия ${p}`, p);
    }
    for (const p of r.skippedLarge) {
      if (this.warnedLarge.has(p)) continue;
      this.warnedLarge.add(p);
      new Notice(`Не синхронизируется (больше 50 МБ): ${p}`);
      this.log(`Не синхронизируется (больше 50 МБ): ${p}`);
    }
    if (r.pulled.length || r.pushed.length || r.deleted.length) {
      this.log(`Загружено ${r.pulled.length}, отправлено ${r.pushed.length}, удалено ${r.deleted.length}`);
    }
    if (r.pulled.some((p) => p.startsWith(this.app.vault.configDir + "/"))) {
      new Notice("Настройки обновлены: применятся после перезапуска Obsidian");
    }
    if (r.rateLimitedUntil) {
      this.scheduler.pauseUntil(r.rateLimitedUntil);
      this.setStatus(`⏸ лимит GitHub до ${hhmm(r.rateLimitedUntil)}`);
      this.log(`Лимит GitHub, пауза до ${hhmm(r.rateLimitedUntil)}`);
      return;
    }
    // a conflict counts until the user deletes its copy
    for (const p of this.conflicts) if (!this.app.vault.getAbstractFileByPath(p)) this.conflicts.delete(p);
    this.setStatus(this.conflicts.size ? conflictsLabel(this.conflicts.size) : `✓ ${hhmm(Date.now())}`);
  }

  private fail(e: unknown): void {
    if (e instanceof AuthError) this.scheduler.stop();
    const msg = e instanceof AuthError ? "войдите снова" : errText(e);
    this.setStatus(`✗ ${msg}`);
    this.log(`Ошибка: ${msg}`);
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
