![Gitvault Sync](assets/cover.png)

# Gitvault Sync

Sync your Obsidian vault across desktop and mobile devices through **your own private GitHub repository**. Everything is encrypted on the device with your password — GitHub only ever sees ciphertext.

> **Status:** beta, being tested before release to the Obsidian community store. Back up your vault before trying it.

## Why

- **Your storage, no middleman.** No third-party server and no subscription — only your GitHub account.
- **End-to-end encrypted.** File contents *and* file names are encrypted (AES-256-GCM, key from your password via PBKDF2 + HKDF).
- **Nothing silently lost.** Every write is conditional, so two devices can never overwrite each other. Edits to different parts of a note merge automatically; clashing edits keep both versions — yours is saved next to the original as `Note (conflict iPhone 2026-10-27 1130).md`.
- **Fast.** Only changed files are transferred; changes reach other open devices within seconds.
- **Safety nets.** Asks before deleting many files, never treats an empty repo as "delete everything", never overwrites a note you're typing in.
- **Full history for free** — it's a git repository.

## Setup

1. Install the plugin (manual install while in beta: copy `main.js`, `manifest.json`, `styles.css` from the [latest release](../../releases) into `<vault>/.obsidian/plugins/gitvault-sync/`, then enable it in **Settings → Community plugins**).
2. In the plugin settings (the interface is currently in Russian):
   - **Создать** (Create) — creates an empty **private** repository on GitHub;
   - **Разрешить** (Allow) — installs the [Gitvault Sync GitHub App](https://github.com/apps/gitvault-sync) on *that repository only* and signs you in with a one-time code;
   - set a password. On other devices, sign in the same way and enter the same password.

Sync then runs automatically while Obsidian is open. Commands: *Синхронизировать сейчас* (sync now), *Пауза/продолжить* (pause/resume), *Показать статус* (status).

**If you lose the password, the data on GitHub cannot be decrypted.** Your local files are not affected.

## Good to know

- Syncing `.obsidian` settings and plugins is optional (off by default).
- Files over 50 MB are skipped; GitHub works best with repositories under ~1 GB — the plugin warns at 700 MB.
- Mobile apps can't sync in the background — syncing happens while Obsidian is open.

## Disclosures

- **Account:** requires a GitHub account.
- **Network:** talks only to `api.github.com` and `github.com` (sign-in, your repository). No telemetry.
- **Access:** the GitHub App can read and write only the repositories you select when installing it. The access token and password are stored only on your device, never in the vault or the repository.

## Docs

Detailed guide in Russian: [docs/README.ru.md](docs/README.ru.md).

## License

[MIT](LICENSE). Portions adapted from [Obsyncian](https://github.com/aabulkhairov/obsyncian) (MIT) — see [NOTICE](NOTICE).
