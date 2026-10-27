import { App, Modal, moment, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
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

export const APP_SLUG = "REPLACE_WITH_APP_SLUG";
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
  if ([...tree.keys()].some((p) => p.startsWith("f/"))) throw new Error("в репозитории есть файлы, но нет gitvault.json");
  return null;
}

/** Steps 3-4 of onboarding: device flow, then pick the repo, then the password. */
export async function login(plugin: GitvaultSync): Promise<void> {
  const token = await new DeviceFlowModal(plugin.app).run();
  if (!token) return;
  try {
    const repos = await listInstallationRepos(obsidianHttp, token);
    if (repos.length === 0) {
      new Notice("Нет доступа ни к одному репозиторию: нажмите «2. Разрешить доступ» и выберите свой репозиторий");
      return;
    }
    const pick = repos.length === 1 ? repos[0] : await new RepoModal(plugin.app, repos).run();
    if (pick) await unlock(plugin, pick.owner, pick.repo, token);
  } catch (e) {
    new Notice(`Gitvault Sync: ${errText(e)}`);
  }
}

/** Step 5: create the vault in an empty repo, or unlock an existing one. Resolves when the modal is shown. */
export async function unlock(plugin: GitvaultSync, owner: string, repo: string, token: string): Promise<void> {
  const api = new RestGitHub(obsidianHttp, owner, repo, () => token);
  const config = await fetchVaultConfig(api);
  new PasswordModal(plugin.app, config === null, plugin.settings.rememberPassword, async (password, remember) => {
    let keys: VaultKeys;
    if (config) {
      try { keys = await unlockVault(password, config); } catch (e) {
        if (e instanceof WrongPasswordError) return "Неверный пароль";
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

export class GitvaultSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: GitvaultSync) { super(app, plugin); }

  display(): void {
    const { containerEl: c, plugin } = this;
    const s = plugin.settings;
    c.empty();

    new Setting(c).setName("Подключение").setHeading();
    const token = plugin.token();
    if (token && s.owner) {
      const row = new Setting(c).setName("Репозиторий").setDesc(`${s.owner}/${s.repo}`);
      if (!plugin.isRunning()) {
        row.addButton((b) => b.setButtonText("Ввести пароль").onClick(() => {
          unlock(plugin, s.owner, s.repo, token).catch((e) => new Notice(`Gitvault Sync: ${errText(e)}`));
        }));
      }
      row.addButton((b) => b.setButtonText("Выйти").setWarning().onClick(async () => { await plugin.signOut(); this.display(); }));
    } else {
      new Setting(c).setName("1. Создать репозиторий").setDesc("Приватный репозиторий на GitHub; нажмите Create.")
        .addButton((b) => b.setButtonText("Создать").onClick(() => {
          window.open("https://github.com/new?name=obsidian-vault&visibility=private");
        }));
      new Setting(c).setName("2. Разрешить доступ")
        .setDesc("Выберите «Only select repositories» и свой репозиторий, затем подтвердите вход кодом.")
        .addButton((b) => b.setButtonText("Разрешить").setCta().onClick(async () => {
          window.open(`https://github.com/apps/${APP_SLUG}/installations/new`);
          await login(plugin);
          this.display();
        }));
    }

    new Setting(c).setName("Синхронизация").setHeading();
    // text fields save on "change" (blur/Enter), not per keystroke: each save rebuilds the engine
    const onCommit = (el: HTMLInputElement | HTMLTextAreaElement, save: (v: string) => Promise<void>) =>
      el.addEventListener("change", () => void save(el.value));
    new Setting(c).setName("Имя устройства").setDesc("Попадает в сообщения коммитов и имена конфликт-копий.")
      .addText((t) => onCommit(t.setValue(s.deviceName).inputEl, async (v) => {
        s.deviceName = v.trim() || defaultDeviceName();
        await plugin.saveSettings();
      }));
    new Setting(c).setName("Синхронизировать настройки и плагины").setDesc("Папка .obsidian; применится после перезапуска Obsidian.")
      .addToggle((t) => t.setValue(s.syncConfig).onChange(async (v) => { s.syncConfig = v; await plugin.saveSettings(); }));
    new Setting(c).setName("Игнорировать").setDesc("Шаблоны путей, по одному на строку, например Attachments/** или *.pdf")
      .addTextArea((t) => onCommit(t.setValue(s.ignore.join("\n")).inputEl, async (v) => {
        s.ignore = v.split("\n").map((l) => l.trim()).filter(Boolean);
        await plugin.saveSettings();
      }));
    new Setting(c).setName("Порог массового удаления, %")
      .setDesc("Если синхронизация удалит больше этой доли файлов (и больше 10 штук), она спросит подтверждение.")
      .addText((t) => onCommit(t.setValue(String(s.massDeletePercent)).inputEl, async (v) => {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 100) return;
        s.massDeletePercent = n;
        await plugin.saveSettings();
      }));

    const api = plugin.api();
    if (api) {
      const size = c.createEl("p", { text: "Размер репозитория: …", cls: "gvs-repo-size" });
      api.repoSizeKb().then((kb) => {
        size.setText(`Размер репозитория: ${Math.round(kb / 1024)} МБ`);
        size.toggleClass("gvs-warn", kb >= WARN_REPO_KB);
      }, (e) => size.setText(`Размер репозитория: ошибка (${errText(e)})`));
    }
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
    this.setTitle("Вход через GitHub");
    const { contentEl: el } = this;
    const status = el.createEl("p", { text: "Получение кода…" });
    try {
      const code = await startDeviceFlow(obsidianHttp, GITHUB_CLIENT_ID, Date.now);
      if (this.closed) return;
      el.createDiv({ cls: "gvs-code", text: code.userCode });
      new Setting(el).addButton((b) => b.setButtonText("Скопировать и открыть github.com/login/device").setCta().onClick(async () => {
        await navigator.clipboard.writeText(code.userCode).catch(() => {});
        window.open(code.verificationUri);
      }));
      status.setText("Ожидание подтверждения на github.com…");
      el.appendChild(status);
      const sleep = (ms: number) => new Promise<void>((res, rej) =>
        window.setTimeout(() => (this.closed ? rej(new Error("cancelled")) : res()), ms));
      const token = await pollDeviceToken(obsidianHttp, GITHUB_CLIENT_ID, code, sleep, Date.now);
      this.done(token);
      this.close();
    } catch (e) {
      if (!this.closed) status.setText(`Ошибка: ${errText(e)}`);
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
  constructor(app: App, private repos: { owner: string; repo: string }[]) { super(app); }

  run(): Promise<{ owner: string; repo: string } | null> {
    return new Promise((resolve) => {
      this.done = (r) => { this.done = () => {}; resolve(r); };
      this.open();
    });
  }

  onOpen(): void {
    this.setTitle("Выберите репозиторий");
    let i = 0;
    new Setting(this.contentEl)
      .addDropdown((d) => {
        this.repos.forEach((r, n) => d.addOption(String(n), `${r.owner}/${r.repo}`));
        d.onChange((v) => { i = Number(v); });
      })
      .addButton((b) => b.setButtonText("Выбрать").setCta().onClick(() => { this.done(this.repos[i]); this.close(); }));
  }

  onClose(): void {
    this.contentEl.empty();
    this.done(null);
  }
}

/** submit returns an error message to show, or null on success. */
class PasswordModal extends Modal {
  constructor(app: App, private create: boolean, private remember: boolean,
    private submit: (password: string, remember: boolean) => Promise<string | null>) { super(app); }

  onOpen(): void {
    const { contentEl: el } = this;
    this.setTitle(this.create ? "Задайте пароль" : "Введите пароль");
    if (this.create) {
      el.createEl("p", { cls: "mod-warning", text: "Потерянный пароль не восстановить: без него данные в репозитории не расшифровать." });
    }
    const field = (placeholder: string) => {
      const input = el.createEl("input", { type: "password", cls: "gvs-password", attr: { placeholder } });
      return input;
    };
    const pw = field("Пароль");
    const pw2 = this.create ? field("Повторите пароль") : null;
    new Setting(el).setName("Запомнить на этом устройстве")
      .addToggle((t) => t.setValue(this.remember).onChange((v) => { this.remember = v; }));
    const error = el.createEl("p", { cls: "gvs-error" });
    new Setting(el).addButton((b) => b.setButtonText("Готово").setCta().onClick(async () => {
      if (!pw.value) return error.setText("Введите пароль");
      if (pw2 && pw2.value !== pw.value) return error.setText("Пароли не совпадают");
      b.setDisabled(true);
      error.setText("Проверка…");
      try {
        const msg = await this.submit(pw.value, this.remember);
        if (msg === null) return this.close();
        error.setText(msg);
      } catch (e) {
        error.setText(`Ошибка: ${errText(e)}`);
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
    m.setTitle("Gitvault Sync");
    m.contentEl.createEl("p", { text });
    new Setting(m.contentEl)
      .addButton((b) => b.setButtonText(ok).setWarning().onClick(() => { answer = true; m.close(); }))
      .addButton((b) => b.setButtonText(cancel).onClick(() => m.close()));
    m.onClose = () => resolve(answer);
    m.open();
  });
}

export interface SyncEvent { at: number; text: string; path?: string }

export class StatusModal extends Modal {
  constructor(app: App, private status: string, private events: SyncEvent[], private openFile: (path: string) => void) { super(app); }

  onOpen(): void {
    this.setTitle("Gitvault Sync");
    const { contentEl: el } = this;
    el.createEl("p", { text: this.status });
    if (this.events.length === 0) el.createEl("p", { text: "Событий пока нет." });
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
