import { t } from "./i18n";
import { App, debounce, Modal, moment, Notice, Platform, PluginSettingTab, Setting, type SettingDefinitionItem } from "obsidian";
import { GITHUB_CLIENT_ID, listInstallationRepos, pollDeviceToken, startDeviceFlow } from "./auth";
import { createVault, unlockVault, WrongPasswordError, type VaultConfig, type VaultKeys } from "./crypto";
import { RestGitHub, type GitHubApi } from "./github";
import { obsidianHttp } from "./http";
import type GitvaultSync from "./main";

/** Stored in data.json. No secrets here: data.json sits in .obsidian, which iCloud, git or Obsidian Sync may copy anywhere. */
export interface PluginSettings {
  owner: string; repo: string; deviceName: string; syncConfig: boolean;
  ignore: string[]; massDeletePercent: number; rememberPassword: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  owner: "", repo: "", deviceName: "", syncConfig: false, ignore: [], massDeletePercent: 20, rememberPassword: true,
};

export const defaultDeviceName = (): string => (Platform.isIosApp ? "iPhone" : Platform.isMacOS ? "Mac" : "PC");

// Secrets go to app.saveLocalStorage (per device, outside the vault), never data.json or the repo.
export const TOKEN_KEY = "gitvault-sync:token";
export const PASSWORD_KEY = "gitvault-sync:password";
export const DEVICE_ID_KEY = "gitvault-sync:deviceId";

export const APP_SLUG = "gitvault-sync";
const CONFIG_PATH = "gitvault.json";
const WARN_REPO_KB = 700 * 1024;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** null = repo not initialised yet. Throws if files exist without gitvault.json (never offer to re-create over them). */
export async function fetchVaultConfig(api: GitHubApi): Promise<VaultConfig | null> {
  const head = await api.getHead(null);
  if (head.notModified || head.sha === null) return null;
  const tree = await api.getTree(head.sha);
  const blob = tree.get(CONFIG_PATH);
  if (blob) return JSON.parse(await api.getBlobText(blob)) as VaultConfig;
  if ([...tree.keys()].some((p) => p.startsWith("f/"))) throw new Error(t("the repository has files but no gitvault.json", "в репозитории есть файлы, но нет gitvault.json"));
  return null;
}

type Repo = { owner: string; repo: string };

/**
 * One entry point for every device: sign in, then the repos decide the path.
 * A repo that already holds a vault means "join it" (password only), so a second device can't start a second vault.
 */
export async function login(plugin: GitvaultSync): Promise<void> {
  const token = await new DeviceFlowModal(plugin.app).run();
  if (!token) return;
  try {
    for (;;) {
      const repos = await listInstallationRepos(obsidianHttp, token);
      const kinds = await Promise.all(repos.map((r) =>
        fetchVaultConfig(new RestGitHub(obsidianHttp, r.owner, r.repo, () => token)).then((c) => (c ? "vault" : "empty"), () => "other")));
      const vaults = repos.filter((_, i) => kinds[i] === "vault"), empty = repos.filter((_, i) => kinds[i] === "empty");
      const pool = vaults.length ? vaults : empty;
      if (pool.length) {
        const pick = pool.length === 1 ? pool[0]
          : await new RepoModal(plugin.app, pool, vaults.length ? t("Choose a vault", "Выберите хранилище") : t("Choose an empty repository", "Выберите пустой репозиторий")).run();
        if (pick) await unlock(plugin, pick.owner, pick.repo, token);
        return;
      }
      if (!(await new SetupModal(plugin.app).run())) return; // "Проверить снова" loops with the same token
    }
  } catch (e) {
    new Notice(`Gitvault Sync: ${errText(e)}`);
  }
}

/** Create the vault in an empty repo, or unlock an existing one. Resolves when the modal is shown. */
export async function unlock(plugin: GitvaultSync, owner: string, repo: string, token: string): Promise<void> {
  const api = new RestGitHub(obsidianHttp, owner, repo, () => token);
  const config = await fetchVaultConfig(api);
  new PasswordModal(plugin.app, `${owner}/${repo}`, config === null, plugin.settings.rememberPassword, async (password, remember) => {
    let keys: VaultKeys;
    if (config) {
      try { keys = await unlockVault(password, config); } catch (e) {
        if (e instanceof WrongPasswordError) return t("Wrong password", "Неверный пароль");
        throw e;
      }
    } else {
      const v = await createVault(password);
      await api.putFile(CONFIG_PATH, JSON.stringify(v.config), null, "gvs: init");
      keys = v.keys;
    }
    await plugin.connect({ owner, repo, token, keys, password, remember, created: config === null });
    return null;
  }).open();
}

type ControlKey = "deviceName" | "syncConfig" | "ignore" | "massDeletePercent";

export class GitvaultSettingTab extends PluginSettingTab {
  // controls commit as the user types: save once typing pauses, since each save rebuilds the engine
  private saveSoon = debounce(() => void this.plugin.saveSettings(), 800, true);

  constructor(app: App, private plugin: GitvaultSync) { super(app, plugin); }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const { plugin } = this;
    const s = plugin.settings, token = plugin.token();
    if (!(token && s.owner)) { // a single section: no heading (plugin guidelines)
      return [{
        name: t("Sign in with GitHub", "Войти через GitHub"),
        desc: t("Your vault syncs through your own private GitHub repository, encrypted with your password. " +
            "Sign in — the plugin works out whether this is your first device or the vault is already set up on another one.",
          "Хранилище синхронизируется через ваш приватный репозиторий GitHub и шифруется паролем. " +
            "Войдите — плагин сам поймёт, первое это устройство или хранилище уже настроено на другом."),
        render: (row) => {
          row.addButton((b) => b.setButtonText(t("Sign in", "Войти")).setCta().onClick(async () => { await login(plugin); this.update(); }));
        },
      }];
    }
    const api = plugin.api();
    return [
      { type: "group", heading: t("Connection", "Подключение"), items: [{
        name: t(`Vault ${s.owner}/${s.repo}`, `Хранилище ${s.owner}/${s.repo}`),
        desc: plugin.isRunning() ? t("Sync is on.", "Синхронизация включена.") : t("Password not entered: sync is stopped.", "Пароль не введён: синхронизация остановлена."),
        render: (row) => {
          if (!plugin.isRunning()) {
            row.addButton((b) => b.setButtonText(t("Enter password", "Ввести пароль")).setCta().onClick(() => {
              unlock(plugin, s.owner, s.repo, token).catch((e) => new Notice(`Gitvault Sync: ${errText(e)}`));
            }));
          }
          row.addButton((b) => b.setButtonText(t("Sign out", "Выйти")).setDestructive().onClick(async () => { await plugin.signOut(); this.update(); }));
        },
      }] },
      { type: "group", heading: t("Sync", "Синхронизация"), items: [
        { name: t("Device name", "Имя устройства"), desc: t("Used in commit messages and conflict copy names.", "Попадает в сообщения коммитов и имена конфликт-копий."),
          control: { type: "text", key: "deviceName" } },
        { name: t("Sync settings and plugins", "Синхронизировать настройки и плагины"),
          desc: t(`The ${plugin.app.vault.configDir} folder; applies after restarting Obsidian.`, `Папка ${plugin.app.vault.configDir}; применится после перезапуска Obsidian.`),
          control: { type: "toggle", key: "syncConfig" } },
      ] },
      { type: "group", heading: t("Advanced", "Дополнительно"), items: [
        { name: t("Ignore", "Игнорировать"), desc: t("Path patterns, one per line, e.g. Attachments/** or *.pdf", "Шаблоны путей, по одному на строку, например Attachments/** или *.pdf"),
          control: { type: "textarea", key: "ignore", rows: 4 } },
        { name: t("Mass-deletion threshold, %", "Порог массового удаления, %"),
          desc: t("If a sync would delete more than this share of files (and more than 10), it asks first.", "Если синхронизация удалит больше этой доли файлов (и больше 10 штук), она спросит подтверждение."),
          control: { type: "number", key: "massDeletePercent", min: 1, max: 100, step: 1 } },
        { name: t("Repository size", "Размер репозитория"), visible: !!api, searchable: false,
          render: (row) => {
            row.setDesc("…");
            api?.repoSizeKb().then((kb) => {
              row.setDesc(t(`${Math.round(kb / 1024)} MB`, `${Math.round(kb / 1024)} МБ`));
              row.descEl.toggleClass("gvs-warn", kb >= WARN_REPO_KB);
            }, (e) => row.setDesc(t(`error (${errText(e)})`, `ошибка (${errText(e)})`)));
          } },
      ] },
    ];
  }

  getControlValue(key: string): unknown {
    const s = this.plugin.settings;
    return key === "ignore" ? s.ignore.join("\n") : s[key as ControlKey];
  }

  setControlValue(key: string, value: unknown): void {
    const s = this.plugin.settings;
    switch (key as ControlKey) {
      case "deviceName": s.deviceName = String(value).trim() || defaultDeviceName(); break;
      case "syncConfig": s.syncConfig = value === true; break;
      case "ignore": s.ignore = String(value).split("\n").map((l) => l.trim()).filter(Boolean); break;
      case "massDeletePercent": {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > 100) return;
        s.massDeletePercent = n;
        break;
      }
    }
    this.saveSoon();
  }
}

class DeviceFlowModal extends Modal {
  private closed = false;
  private done: (token: string | null) => void = () => {};

  run(): Promise<string | null> {
    return new Promise((resolve) => {
      this.done = (t) => { this.done = () => {}; resolve(t); };
      this.open();
    });
  }

  async onOpen(): Promise<void> {
    this.setTitle(t("Sign in with GitHub", "Вход через GitHub"));
    const { contentEl: el } = this;
    const status = el.createEl("p", { text: t("Getting a code…", "Получение кода…") });
    try {
      const code = await startDeviceFlow(obsidianHttp, GITHUB_CLIENT_ID, Date.now);
      if (this.closed) return;
      el.createDiv({ cls: "gvs-code", text: code.userCode });
      new Setting(el).addButton((b) => b.setButtonText(t("Copy and open github.com/login/device", "Скопировать и открыть github.com/login/device")).setCta().onClick(async () => {
        await navigator.clipboard.writeText(code.userCode).catch(() => {});
        window.open(code.verificationUri);
      }));
      status.setText(t("Waiting for confirmation on github.com…", "Ожидание подтверждения на github.com…"));
      el.appendChild(status);
      const sleep = (ms: number) => new Promise<void>((res, rej) =>
        window.setTimeout(() => (this.closed ? rej(new Error("cancelled")) : res()), ms));
      const token = await pollDeviceToken(obsidianHttp, GITHUB_CLIENT_ID, code, sleep, Date.now);
      this.done(token);
      this.close();
    } catch (e) {
      if (!this.closed) status.setText(t(`Error: ${errText(e)}`, `Ошибка: ${errText(e)}`));
    }
  }

  onClose(): void {
    this.closed = true;
    this.contentEl.empty();
    this.done(null);
  }
}

class RepoModal extends Modal {
  private done: (r: { owner: string; repo: string } | null) => void = () => {};
  constructor(app: App, private repos: Repo[], private title: string) { super(app); }

  run(): Promise<{ owner: string; repo: string } | null> {
    return new Promise((resolve) => {
      this.done = (r) => { this.done = () => {}; resolve(r); };
      this.open();
    });
  }

  onOpen(): void {
    this.setTitle(this.title);
    let i = 0;
    new Setting(this.contentEl)
      .addDropdown((d) => {
        for (const [n, r] of this.repos.entries()) d.addOption(String(n), `${r.owner}/${r.repo}`);
        d.onChange((v) => { i = Number(v); });
      })
      .addButton((b) => b.setButtonText(t("Choose", "Выбрать")).setCta().onClick(() => { this.done(this.repos[i]); this.close(); }));
  }

  onClose(): void {
    this.contentEl.empty();
    this.done(null);
  }
}

/** No repo accessible yet: the first-device steps. Resolves true for "check again". */
class SetupModal extends Modal {
  private done: (again: boolean) => void = () => {};
  run(): Promise<boolean> {
    return new Promise((resolve) => { this.done = (v) => { this.done = () => {}; resolve(v); }; this.open(); });
  }

  onOpen(): void {
    this.setTitle(t("First device", "Первое устройство"));
    const { contentEl: el } = this;
    el.createEl("p", { text: t("The app has no access to any repository yet. If your vault is already set up on another device, sign in with the same GitHub account. Otherwise:", "У приложения пока нет доступа ни к одному репозиторию. Если хранилище уже настроено на другом устройстве, войдите тем же аккаунтом GitHub. Иначе:") });
    new Setting(el).setName(t("1. Create a private repository", "1. Создайте приватный репозиторий")).setDesc(t("Empty, without a README.", "Пустой, без README."))
      .addButton((b) => b.setButtonText(t("Create", "Создать")).onClick(() => window.open("https://github.com/new?name=obsidian-vault&visibility=private")));
    new Setting(el).setName(t("2. Give access to it", "2. Дайте доступ к нему")).setDesc(t("Choose “Only select repositories” and that repository.", "Выберите «Only select repositories» и этот репозиторий."))
      .addButton((b) => b.setButtonText(t("Allow", "Разрешить")).onClick(() => window.open(`https://github.com/apps/${APP_SLUG}/installations/new`)));
    new Setting(el).addButton((b) => b.setButtonText(t("Check again", "Проверить снова")).setCta().onClick(() => { this.done(true); this.close(); }));
  }

  onClose(): void { this.contentEl.empty(); this.done(false); }
}

/** submit returns an error message to show, or null on success. */
class PasswordModal extends Modal {
  constructor(app: App, private repo: string, private create: boolean, private remember: boolean,
    private submit: (password: string, remember: boolean) => Promise<string | null>) { super(app); }

  onOpen(): void {
    const { contentEl: el } = this;
    this.setTitle(this.create ? t("New vault", "Новое хранилище") : t("Connect to vault", "Подключение к хранилищу"));
    el.createEl("p", { text: this.create
      ? t(`This is your first device: a vault will be created in ${this.repo}. Choose a password — you will enter the same one on your other devices.`, `Это первое устройство: в ${this.repo} будет создано хранилище. Придумайте пароль — на других устройствах вы введёте его же.`)
      : t(`The vault ${this.repo} is already set up on another device. Enter its password.`, `Хранилище ${this.repo} уже настроено на другом устройстве. Введите его пароль.`) });
    if (this.create) {
      el.createEl("p", { cls: "mod-warning", text: t("A lost password can't be recovered: without it the data in the repository can't be decrypted.", "Потерянный пароль не восстановить: без него данные в репозитории не расшифровать.") });
    }
    const field = (placeholder: string) => {
      const input = el.createEl("input", { type: "password", cls: "gvs-password", attr: { placeholder } });
      return input;
    };
    const pw = field(t("Password", "Пароль"));
    const pw2 = this.create ? field(t("Repeat password", "Повторите пароль")) : null;
    new Setting(el).setName(t("Remember on this device", "Запомнить на этом устройстве"))
      .addToggle((t) => t.setValue(this.remember).onChange((v) => { this.remember = v; }));
    const error = el.createEl("p", { cls: "gvs-error" });
    new Setting(el).addButton((b) => b.setButtonText(t("Done", "Готово")).setCta().onClick(async () => {
      if (!pw.value) return error.setText(t("Enter the password", "Введите пароль"));
      if (pw2 && pw2.value !== pw.value) return error.setText(t("Passwords don't match", "Пароли не совпадают"));
      b.setDisabled(true);
      error.setText(t("Checking…", "Проверка…"));
      try {
        const msg = await this.submit(pw.value, this.remember);
        if (msg === null) return this.close();
        error.setText(msg);
      } catch (e) {
        error.setText(t(`Error: ${errText(e)}`, `Ошибка: ${errText(e)}`));
      }
      b.setDisabled(false);
    }));
    pw.focus();
  }

  onClose(): void { this.contentEl.empty(); }
}

export function confirmModal(app: App, text: string, ok: string, cancel: string): Promise<boolean> {
  return new Promise((resolve) => {
    let answer = false;
    const m = new Modal(app);
    m.setTitle(t("Confirm", "Подтверждение"));
    m.contentEl.createEl("p", { text });
    new Setting(m.contentEl)
      .addButton((b) => b.setButtonText(ok).setDestructive().onClick(() => { answer = true; m.close(); }))
      .addButton((b) => b.setButtonText(cancel).onClick(() => m.close()));
    m.onClose = () => resolve(answer);
    m.open();
  });
}

export interface SyncEvent { at: number; text: string; path?: string }

export class StatusModal extends Modal {
  constructor(app: App, private status: string, private events: SyncEvent[], private openFile: (path: string) => void) { super(app); }

  onOpen(): void {
    this.setTitle(t("Sync status", "Статус синхронизации"));
    const { contentEl: el } = this;
    el.createEl("p", { text: this.status });
    if (this.events.length === 0) el.createEl("p", { text: t("No events yet.", "Событий пока нет.") });
    const list = el.createEl("ul", { cls: "gvs-events" });
    for (const ev of [...this.events].reverse()) {
      const li = list.createEl("li");
      li.createSpan({ cls: "gvs-time", text: moment(ev.at).format("HH:mm") + " " });
      if (!ev.path) { li.appendText(ev.text); continue; }
      const path = ev.path;
      li.appendText(ev.text.slice(0, ev.text.length - path.length));
      li.createEl("a", { text: path, href: "#" }).addEventListener("click", (e) => {
        e.preventDefault();
        this.close();
        this.openFile(path);
      });
    }
  }

  onClose(): void { this.contentEl.empty(); }
}
