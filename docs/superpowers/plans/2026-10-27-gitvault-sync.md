# Gitvault Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Плагин Obsidian, синхронизирующий хранилище с приватным репозиторием GitHub, зашифрованно паролем, с 3-way merge и конфликт-копиями.

**Architecture:** GitHub — «сервер» с условной записью (Contents API по sha файла, refs с `force:false`). Чистый движок `SyncEngine` (без зависимостей от Obsidian) работает поверх двух интерфейсов: `GitHubApi` и `LocalFs`; оба имеют фейковые реализации в тестах, поэтому вся логика синка проверяется симуляцией трёх устройств. Obsidian-слой (`main.ts`, `obsidianfs.ts`, UI) тонкий.

**Tech Stack:** TypeScript 5, esbuild, Obsidian API (`requestUrl`, `DataAdapter`), WebCrypto, `node-diff3`, vitest.

**Spec:** `docs/superpowers/specs/2026-10-27-gitvault-sync-design.md`

## Global Constraints

- Никакого Node API в `src/` (iOS): только WebCrypto, `TextEncoder/Decoder`, `DecompressionStream`, API Obsidian. `manifest.json`: `"isDesktopOnly": false`, id `gitvault-sync`.
- Весь HTTP — через инъектируемый `Http` (реализация на `requestUrl`); заголовки GitHub: `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`.
- Шифрование: PBKDF2-SHA256, 600 000 итераций, соль 16 байт, AES-256-GCM, iv 12 байт, MAGIC `GVS1`.
- Раскладка репозитория: `gitvault.json` + `f/<token[0..2]>/<token>`; содержимое файлов — base64-текст шифротекста.
- Пути нормализуются в NFC перед токенизацией и хранением в состоянии.
- Токен, пароль, deviceId — только `app.saveLocalStorage`, никогда в `data.json` или репозиторий.
- Всегда игнорируется: `.obsidian/plugins/gitvault-sync/**`, `.obsidian/workspace*.json`, `.trash/**`, `.git/**`.
- Пороги по умолчанию: batch при > 5 файлов на push; tarball при > 300 изменённых на pull; массовое удаление > 20 % и > 10 файлов; файл > 50 МБ не синхронизируется; merge только для файлов ≤ 2 МБ; предупреждение о репозитории ≥ 700 МБ.
- Тайминги: push через 2 с тишины, не реже 15 с при непрерывном наборе; опрос 4 с (видимо) / 60 с (скрыто); ведро записей ёмкость 20, +4/мин.
- Коммит-сообщения не содержат путей: `gvs: <deviceName> <n> file(s)`.
- Код из Obsyncian (MIT) переносится с указанием авторства в `NOTICE`; из `pro/` remotely-save — ничего.
- Конфликт-копия: `<имя без расширения> (conflict <deviceName> YYYY-MM-DD HHmm).<ext>`; удалённая версия остаётся на исходном пути.

## Review Focus

1. Обрыв после успешного PUT, но до сохранения состояния (iPhone убил приложение) — следующий цикл должен сойтись **без** конфликт-копии (локальное = удалённое). Тест в Task 8.
2. Пользователь печатает, пока pull пишет файл — запись откладывается, правка не затирается. Тест в Task 9.
3. Переименование папки с 50 файлами — 50 удалений + 50 созданий не должны срабатывать как «массовое удаление» (удаление, у которого есть создание с тем же `localHash`, — переименование). Тест в Task 9.
4. macOS отдаёт имена в NFD — тот же файл с iPhone (NFC) не должен стать двумя файлами. Тест в Task 3 и Task 8.
5. 401 посреди цикла (токен отозван) — синк на паузе «войдите снова», локальное состояние и файлы не тронуты. Тест в Task 10.

---

## Файловая структура

```
manifest.json, package.json, tsconfig.json, esbuild.config.mjs, versions.json, styles.css, NOTICE, README.md
src/
  util.ts        — base64, sha256Hex, gitBlobSha, repoPath, conflictPath, nfc, isIgnored(glob)
  crypto.ts      — VaultConfig, VaultKeys, create/unlock, pathToken, encryptFile/decryptFile
  merge.ts       — порт merge.ts Obsyncian: isMergeablePath, tryDecodeUtf8, merge3, mergeJson
  http.ts        — тип Http, HttpError, RateLimitError, AuthError, obsidianHttp(requestUrl)
  github.ts      — интерфейс GitHubApi + RestGitHub (реализация)
  tar.ts         — gunzip (DecompressionStream) + parseTar
  localfs.ts     — интерфейс LocalFs, FileStat
  state.ts       — SyncState, FileRecord, StateStore
  engine.ts      — SyncEngine
  bucket.ts      — TokenBucket
  auth.ts        — Device Flow
  obsidianfs.ts  — LocalFs поверх DataAdapter + AdapterStateStore
  scheduler.ts   — debounce/poll/visibility
  settings.ts    — SettingsTab, онбординг, модалки
  main.ts        — Plugin: проводка, статус-бар, команды
tests/
  fake-github.ts, fake-fs.ts, helpers.ts
  util.test.ts, crypto.test.ts, merge.test.ts, github.test.ts, tar.test.ts,
  engine.test.ts, sim.test.ts, bucket.test.ts, auth.test.ts, scheduler.test.ts
```

---

### Task 1: Каркас проекта + util

**Files:**
- Create: `package.json`, `tsconfig.json`, `esbuild.config.mjs`, `manifest.json`, `versions.json`, `styles.css`, `.gitignore`, `vitest.config.ts`, `src/util.ts`
- Test: `tests/util.test.ts`

**Interfaces:**
- Produces:
  - `b64encode(buf: ArrayBuffer | Uint8Array): string`, `b64decode(s: string): Uint8Array`
  - `sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string>`
  - `gitBlobSha(text: string): Promise<string>` — SHA-1 от `"blob " + byteLen + "\0" + utf8(text)`, hex
  - `nfc(path: string): string`
  - `repoPath(token: string): string` → `f/${token.slice(0,2)}/${token}`
  - `conflictPath(path: string, deviceName: string, at: Date): string`
  - `isIgnored(path: string, patterns: string[]): boolean` — глоб: `**` любое число сегментов, `*` внутри сегмента
  - `ALWAYS_IGNORED: string[]` (значения из Global Constraints)

- [ ] **Step 1: Каркас.** `package.json` (scripts `build: tsc -noEmit -skipLibCheck && node esbuild.config.mjs production`, `dev`, `test: vitest run`; deps `node-diff3@^3.2.1`; devDeps `obsidian`, `typescript@^5`, `esbuild@^0.24`, `vitest@^2`, `tslib`, `@types/node`), esbuild как в шаблоне obsidian-sample-plugin (external `obsidian`, `electron`, `@codemirror/*`; format cjs; target es2020). `manifest.json`: id `gitvault-sync`, name `Gitvault Sync`, minAppVersion `1.5.0`, isDesktopOnly false. `npm install`.
- [ ] **Step 2: Failing tests** в `tests/util.test.ts`:

```ts
test("gitBlobSha matches git", async () => {
  expect(await gitBlobSha("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
});
test("repoPath shards", () => expect(repoPath("abcdef")).toBe("f/ab/abcdef"));
test("conflictPath", () => {
  const d = new Date(2026, 9, 27, 11, 30);
  expect(conflictPath("a/Note.md", "iPhone", d)).toBe("a/Note (conflict iPhone 2026-10-27 1130).md");
  expect(conflictPath("a/Makefile", "Mac", d)).toBe("a/Makefile (conflict Mac 2026-10-27 1130)");
  expect(conflictPath(".hidden", "Mac", d)).toBe(".hidden (conflict Mac 2026-10-27 1130)");
});
test("nfc", () => expect(nfc("é.md")).toBe("é.md"));
test("isIgnored", () => {
  expect(isIgnored(".obsidian/plugins/gitvault-sync/state.json", ALWAYS_IGNORED)).toBe(true);
  expect(isIgnored(".obsidian/workspace-mobile.json", ALWAYS_IGNORED)).toBe(true);
  expect(isIgnored(".obsidian/app.json", ALWAYS_IGNORED)).toBe(false);
  expect(isIgnored("notes/a.md", ["notes/*.md"])).toBe(true);
  expect(isIgnored("notes/x/a.md", ["notes/*.md"])).toBe(false);
  expect(isIgnored("notes/x/a.md", ["notes/**"])).toBe(true);
});
test("b64 roundtrip", () => {
  const u = new Uint8Array([0, 255, 1, 2]);
  expect(b64decode(b64encode(u))).toEqual(u);
});
```

- [ ] **Step 3:** `npx vitest run tests/util.test.ts` → FAIL (модуль не найден).
- [ ] **Step 4:** Реализовать `src/util.ts`.
- [ ] **Step 5:** `npx vitest run tests/util.test.ts` → PASS.
- [ ] **Step 6:** Commit `feat: project scaffold and utils`.

---

### Task 2: Шифрование

**Files:**
- Create: `src/crypto.ts`, `NOTICE`
- Test: `tests/crypto.test.ts`

**Interfaces:**
- Consumes: `b64encode`, `b64decode`, `nfc` (Task 1)
- Produces:
  - `interface VaultConfig { format: 1; kdf: { alg: "PBKDF2-SHA256"; iterations: number; salt: string }; kcv: string }`
  - `interface VaultKeys { enc: CryptoKey; mac: CryptoKey }`
  - `class WrongPasswordError extends Error`
  - `createVault(password: string, iterations?: number): Promise<{ config: VaultConfig; keys: VaultKeys }>`
  - `unlockVault(password: string, config: VaultConfig): Promise<VaultKeys>`
  - `pathToken(keys: VaultKeys, path: string): Promise<string>` — 64 hex, HMAC-SHA256(mac, `"gvs-path-v1\n" + nfc(path)`)
  - `encryptFile(keys: VaultKeys, path: string, data: ArrayBuffer): Promise<string>`
  - `decryptFile(keys: VaultKeys, text: string): Promise<{ path: string; data: ArrayBuffer }>`

Ключи: один вызов `deriveBits` PBKDF2 на 512 бит → первые 32 байта AES-GCM, вторые 32 HMAC-SHA256 (оба non-extractable). Открытый текст файла: `u32 BE длина пути | путь UTF-8 (NFC) | данные`. Шифротекст: `"GVS1" | iv | ct+tag`, затем base64. `kcv` = base64(encrypt(`"gvs-key-check-v1"`)). Параметр `iterations` нужен только тестам (по умолчанию 600 000; в тестах 1000).

- [ ] **Step 1: Failing tests:**

```ts
test("roundtrip with path", async () => {
  const { keys } = await createVault("pw", 1000);
  const t = await encryptFile(keys, "Папка/Заметка.md", enc("привет"));
  const r = await decryptFile(keys, t);
  expect(r.path).toBe("Папка/Заметка.md"); expect(dec(r.data)).toBe("привет");
});
test("unlock with right/wrong password", async () => {
  const { config } = await createVault("pw", 1000);
  await expect(unlockVault("pw", config)).resolves.toBeDefined();
  await expect(unlockVault("nope", config)).rejects.toBeInstanceOf(WrongPasswordError);
});
test("same keys from unlock decrypt", async () => { /* create → encrypt → unlock → decrypt */ });
test("pathToken deterministic, NFC-insensitive, key-dependent", async () => {
  // token(keys,"é.md") === token(keys,"é.md"); differs between two vaults; /^[0-9a-f]{64}$/
});
test("tampered ciphertext rejected", async () => {
  // flip one byte in b64decode(t) → decryptFile rejects
});
test("ciphertext is randomized", async () => { /* two encryptFile of same input differ */ });
```

- [ ] **Step 2:** `npx vitest run tests/crypto.test.ts` → FAIL.
- [ ] **Step 3:** Реализовать `src/crypto.ts`. `NOTICE`: «Portions adapted from Obsyncian (https://github.com/aabulkhairov/obsyncian), MIT License, Copyright (c) 2026 Almas Abulkhairov» + текст MIT.
- [ ] **Step 4:** → PASS.
- [ ] **Step 5:** Commit `feat: vault encryption`.

---

### Task 3: Merge

**Files:**
- Create: `src/merge.ts`
- Test: `tests/merge.test.ts`

**Interfaces:**
- Produces: `isMergeablePath(path: string): boolean` (`md`, `txt`), `tryDecodeUtf8(buf: ArrayBuffer): string | null`, `merge3(base: string, local: string, remote: string): string | null`, `mergeJson(base: string | null, local: string, remote: string): string | null`, `MAX_MERGE_BYTES = 2 * 1024 * 1024`.

Порт из Obsyncian `src/merge.ts`: взять `isMergeablePath`, `tryDecodeUtf8`, `mergeJson` как есть; `merge3` расширить пословным слиянием пересекающихся блоков (логика `mergeWords` и `unionLines` из их `merge3Markers`), но при неразрешимом блоке возвращать `null` (без маркеров). `mergeUnion` и `merge3Markers` не переносить. В шапке файла — ссылка на источник.

- [ ] **Step 1: Failing tests** (адаптировать кейсы из Obsyncian `test/merge.test.ts` под новую семантику `merge3`):

```ts
test("non-overlapping lines merge", () =>
  expect(merge3("a\nb\nc", "A\nb\nc", "a\nb\nC")).toBe("A\nb\nC"));
test("same line, different words merge", () =>
  expect(merge3("один два три", "ОДИН два три", "один два ТРИ")).toBe("ОДИН два ТРИ"));
test("same words → null", () => expect(merge3("x", "y", "z")).toBeNull());
test("both appended at end → both kept, local first", () =>
  expect(merge3("a", "a\nL", "a\nR")).toBe("a\nL\nR"));
test("identical edits", () => expect(merge3("a", "b", "b")).toBe("b"));
test("mergeJson key-wise", () =>
  expect(JSON.parse(mergeJson('{"a":1,"b":1}', '{"a":2,"b":1}', '{"a":1,"b":3}')!)).toEqual({ a: 2, b: 3 }));
test("mergeJson conflict → remote wins", () =>
  expect(JSON.parse(mergeJson('{"a":1}', '{"a":2}', '{"a":3}')!)).toEqual({ a: 3 }));
test("invalid utf8 → null", () => expect(tryDecodeUtf8(new Uint8Array([0xff, 0xfe]).buffer)).toBeNull());
test("mergeable paths", () => {
  expect(isMergeablePath("a.MD")).toBe(true); expect(isMergeablePath("a.canvas")).toBe(false);
});
```

- [ ] **Step 2:** → FAIL. **Step 3:** реализовать. **Step 4:** → PASS.
- [ ] **Step 5:** Commit `feat: three-way merge (adapted from Obsyncian)`.

---

### Task 4: Интерфейс GitHubApi + фейк

**Files:**
- Create: `src/http.ts` (только типы и ошибки на этом шаге), `src/github.ts` (только интерфейс), `tests/fake-github.ts`
- Test: `tests/github.test.ts` (раздел `FakeGitHub`)

**Interfaces:**
- Produces (`src/http.ts`):
  - `interface HttpRequest { url: string; method: string; headers?: Record<string,string>; body?: string | ArrayBuffer }`
  - `interface HttpResponse { status: number; headers: Record<string,string>; text: string; arrayBuffer: ArrayBuffer }`
  - `type Http = (req: HttpRequest) => Promise<HttpResponse>`
  - `class HttpError extends Error { status: number }`, `class RateLimitError extends Error { resetAt: number }`, `class AuthError extends Error`, `class ShaConflictError extends Error { path?: string }`
- Produces (`src/github.ts`):

```ts
export type Head = { notModified: true } | { notModified: false; sha: string | null; etag: string }; // sha null = пустой репозиторий
export interface GitHubApi {
  getHead(etag: string | null): Promise<Head>;
  getTree(commitSha: string): Promise<Map<string, string>>;           // repo path → blob sha, только blobs
  getBlobText(blobSha: string): Promise<string>;
  putFile(path: string, text: string, prevBlobSha: string | null, message: string): Promise<{ blobSha: string; commitSha: string }>;
  deleteFile(path: string, prevBlobSha: string, message: string): Promise<{ commitSha: string }>;
  commitBatch(baseCommit: string, changes: { path: string; text: string | null }[], message: string): Promise<{ commitSha: string }>;
  getTarball(commitSha: string): Promise<Map<string, string>>;        // repo path → text
  fileHistoryBlobShas(path: string, limit: number): Promise<string[]>;
  repoSizeKb(): Promise<number>;
}
```

  `putFile`/`deleteFile` бросают `ShaConflictError`, если `prevBlobSha` не совпадает с текущим (или файл уже существует при `null`); `commitBatch` бросает `ShaConflictError`, если `main` ≠ `baseCommit`.
- Produces (`tests/fake-github.ts`): `class FakeGitHub implements GitHubApi` с полями `commits`, `head`, `writes` (счётчик content-запросов), `reads`, и хуками `failNext(method: keyof GitHubApi, err: Error)`, `onBeforeWrite?: () => void`. Каждый экземпляр-«клиент» устройства — `fake.client()` (общее хранилище, свой счётчик). ETag = head sha; `getHead` с совпадающим etag → `notModified`. Blob sha считать `gitBlobSha`.

- [ ] **Step 1: Failing tests** для фейка (фиксируют семантику, на которую опирается движок):

```ts
test("putFile CAS", async () => {
  const gh = new FakeGitHub().client();
  const a = await gh.putFile("x", "1", null, "m");
  await expect(gh.putFile("x", "2", null, "m")).rejects.toBeInstanceOf(ShaConflictError);
  await gh.putFile("x", "2", a.blobSha, "m");
  await expect(gh.putFile("x", "3", a.blobSha, "m")).rejects.toBeInstanceOf(ShaConflictError);
});
test("putFile on other file succeeds after foreign commit", async () => { /* дерево содержит оба */ });
test("commitBatch requires fast-forward", async () => { /* base устарел → ShaConflictError */ });
test("getHead etag", async () => { /* пустой → sha null; после put → новый etag; тот же etag → notModified */ });
test("getTree returns blob shas equal to gitBlobSha(text)", async () => {});
```

- [ ] **Step 2:** → FAIL. **Step 3:** реализовать. **Step 4:** → PASS.
- [ ] **Step 5:** Commit `feat: GitHubApi interface and in-memory fake`.

---

### Task 5: RestGitHub и obsidianHttp

**Files:**
- Modify: `src/http.ts` (добавить `obsidianHttp`), `src/github.ts` (добавить `RestGitHub`)
- Test: `tests/github.test.ts` (раздел `RestGitHub` с записанными ответами через фейковый `Http`)

**Interfaces:**
- Consumes: `Http`, ошибки (Task 4), `parseTarball` (Task 6 — для `getTarball`; до Task 6 метод бросает `Error("not implemented")`, тест на него добавляется в Task 6)
- Produces: `new RestGitHub(http: Http, owner: string, repo: string, token: () => string)`; `obsidianHttp: Http` (через `requestUrl({ ..., throw: false })`).

Маппинг (base `https://api.github.com/repos/{owner}/{repo}`):
- `getHead`: `GET /git/ref/heads/main` + `If-None-Match`; 304 → notModified; 404/409 → `{sha: null}`; иначе `object.sha`, `etag` из заголовка.
- `getTree`: `GET /git/trees/{sha}?recursive=1`; `truncated: true` → `throw Error("tree truncated")`.
- `getBlobText`: `GET /git/blobs/{sha}` с `Accept: application/vnd.github.raw+json`.
- `putFile`: `PUT /contents/{path}` `{ message, content: base64(utf8(text)), sha?, branch: "main" }` → `content.sha`, `commit.sha`. 409 или 422 → `ShaConflictError`.
- `deleteFile`: `DELETE /contents/{path}` `{ message, sha, branch: "main" }`.
- `commitBatch`: `POST /git/trees { base_tree, tree: [{ path, mode: "100644", type: "blob", content } | { path, mode: "100644", type: "blob", sha: null }] }` → `POST /git/commits { message, tree, parents: [baseCommit] }` → `PATCH /git/refs/heads/main { sha, force: false }`; 422 на PATCH → `ShaConflictError`.
- `getTarball`: `GET /tarball/{sha}` → `gunzip` → `parseTar`, срезать первый сегмент пути (`owner-repo-sha/`).
- `fileHistoryBlobShas`: `GET /commits?path=&per_page=limit` → для каждого `GET /contents/{path}?ref=` → `sha` (404 = файл в этом коммите удалён, пропустить).
- `repoSizeKb`: `GET ""` → `size`.
- Общие ошибки: 401 → `AuthError`; 403/429 при `x-ratelimit-remaining: 0` → `RateLimitError(resetAt = x-ratelimit-reset * 1000)`; при `retry-after` → `RateLimitError(now + s*1000)`; прочие ≥ 400 → `HttpError`.

- [ ] **Step 1: Failing tests** — фейковый `Http`, отвечающий по `method + url`, проверяет: правильные URL/тела/заголовки для каждого метода; 304 → notModified; 409 на PUT → `ShaConflictError`; 422 на PATCH ref → `ShaConflictError`; 401 → `AuthError`; 403 с `x-ratelimit-remaining: 0`, `x-ratelimit-reset: 1700000000` → `RateLimitError` с `resetAt === 1700000000000`; 429 с `retry-after: 30` → `resetAt === now + 30000`; truncated tree → throw.
- [ ] **Step 2:** → FAIL. **Step 3:** реализовать. **Step 4:** → PASS.
- [ ] **Step 5:** Commit `feat: GitHub REST client`.

---

### Task 6: Tarball

**Files:**
- Create: `src/tar.ts`
- Modify: `src/github.ts` (подключить в `getTarball`)
- Test: `tests/tar.test.ts`, дополнить `tests/github.test.ts`

**Interfaces:**
- Produces: `gunzip(data: ArrayBuffer): Promise<ArrayBuffer>` (через `DecompressionStream("gzip")`; если его нет — `throw Error("no DecompressionStream")`), `parseTar(data: ArrayBuffer): Map<string, Uint8Array>` (ustar: имя 0..100 + prefix 345..500, размер octal 124..136, typeflag `0`/`\0` — файлы, `5` — пропустить, `x`/`g` (pax) — читать `path=` из pax-записи для следующего файла; блоки по 512; конец — два нулевых блока).

- [ ] **Step 1: Failing tests:** фикстура `tests/fixtures/sample.tar.gz`, собранная `tar czf` из папки с файлом `repo-abc/f/ab/abcd` (содержимое `"hello"`), пустой папкой и файлом с именем > 100 символов (pax). Проверить: `parseTar(await gunzip(buf))` даёт 2 файла с правильными путями и содержимым; `RestGitHub.getTarball` срезает `repo-abc/`.
- [ ] **Step 2:** → FAIL. **Step 3:** реализовать. **Step 4:** → PASS (Node ≥ 18 имеет `DecompressionStream`).
- [ ] **Step 5:** Commit `feat: tarball download`.

---

### Task 7: LocalFs, состояние, фейковая ФС

**Files:**
- Create: `src/localfs.ts`, `src/state.ts`, `tests/fake-fs.ts`, `tests/helpers.ts`
- Test: внутри `tests/engine.test.ts` появится в Task 8; здесь — короткий `tests/fake-fs.test.ts`

**Interfaces:**
- Produces (`src/localfs.ts`):

```ts
export interface FileStat { path: string; mtime: number; size: number }
export interface LocalFs {
  list(includeConfig: boolean): Promise<FileStat[]>; // пути как есть с диска
  read(path: string): Promise<ArrayBuffer>;
  stat(path: string): Promise<FileStat | null>;
  write(path: string, data: ArrayBuffer): Promise<FileStat>; // создаёт папки
  trash(path: string): Promise<void>;
}
```

- Produces (`src/state.ts`):

```ts
export interface FileRecord { token: string; blobSha: string; localHash: string; mtime: number; size: number }
export interface SyncState { version: 1; headSha: string | null; refEtag: string | null; files: Record<string, FileRecord> } // ключ — NFC-путь
export interface StateStore { load(): Promise<SyncState | null>; save(s: SyncState): Promise<void> }
export const emptyState = (): SyncState;
```

- Produces (`tests/fake-fs.ts`): `FakeFs implements LocalFs` (Map, монотонные mtime, `nfd: boolean` — отдавать пути в `list` в NFD, как macOS; `onBeforeWrite?: (path) => void` для имитации печати во время записи); `MemoryStateStore`.
- Produces (`tests/helpers.ts`): `makeDevice(fake: FakeGitHub, name: string, opts?)` → `{ fs: FakeFs, engine: SyncEngine, store }` (собирается после Task 8), `text(fs, path): Promise<string>`.

- [ ] **Step 1:** тест FakeFs: write → stat/read; trash удаляет; `nfd: true` отдаёт NFD-путь в `list`, но `read` принимает и NFC, и NFD.
- [ ] **Step 2–4:** FAIL → реализовать → PASS.
- [ ] **Step 5:** Commit `feat: local fs and sync state types`.

---

### Task 8: SyncEngine — базовый pull/push

**Files:**
- Create: `src/engine.ts`, `src/bucket.ts`
- Test: `tests/engine.test.ts`, `tests/bucket.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4, 7.
- Produces:

```ts
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
export class SyncEngine { constructor(deps: EngineDeps); sync(): Promise<SyncReport> }
export class TokenBucket { constructor(capacity: number, refillPerMin: number, now: () => number); tryTake(n: number): boolean; msUntil(n: number): number }
export const DEFAULT_ENGINE_SETTINGS: EngineSettings;
```

Алгоритм `sync()` — по разделу «Цикл синхронизации» спеки, шаги 1–5. Ключевое:
- изменение удалённого определяется **по-файлово**: `tree[repoPath(token)] !== state.files[p].blobSha`; путь удалённого файла узнаётся из `decryptFile` (токен → путь для неизвестных токенов);
- после каждого успешного `putFile`/`deleteFile`/`commitBatch` — `store.save(state)`;
- пустой репозиторий (`sha: null`): сначала `putFile("gitvault.json", ...)` делает не движок, а онбординг (Task 11); движок при `sha: null` только пушит файлы через `putFile` (Git Data API не работает на пустом репо);
- записи на GitHub берут токены из `bucket` (1 на `putFile`/`deleteFile`, 3 на `commitBatch`); нет токенов → остаток откладывается, `report.rateLimitedUntil = now + bucket.msUntil(...)`.
- Конфликт-логика в этом таске упрощена: если оба изменились → `throw Error("conflict: Task 9")` (тесты Task 8 его не задевают).

- [ ] **Step 1: Failing tests** (`tests/engine.test.ts`, через `makeDevice`):

```ts
test("first device uploads, second downloads", async () => {
  // A: write a.md, img.png → A.sync(); B.sync() → B has both with same bytes
});
test("edit propagates", async () => { /* A edits → sync; B.sync → updated */ });
test("delete propagates to trash", async () => { /* A removes → sync; B.sync → B.fs has no file */ });
test("idle sync costs zero writes and no tree fetch", async () => {
  // after convergence: fake.writes unchanged, fake.reads grows only by getHead
});
test("own push does not look like remote change", async () => {
  // A edits, sync; A.sync again → report.pulled empty
});
test("foreign commit between our PUTs is not lost", async () => {
  // fake.onBeforeWrite: B pushes other file during A's push → after A.sync, B.sync: both have both files
});
test("crash after PUT before state save converges without conflict copy", async () => {
  // store.save throws once right after putFile; second A.sync → no '(conflict' files anywhere, report.conflicts empty
});
test("NFD path on mac and NFC on iPhone are one file", async () => {
  // A (nfd) creates 'é.md'; B (nfc) sync → exactly one file; B edits; A sync → still one file
});
test("ignored and large files are not pushed", async () => {
  // .obsidian/plugins/gitvault-sync/data.json, 60MB file → not in fake tree; report.skippedLarge has the big one
});
test("syncConfig=false skips .obsidian, true includes app.json", async () => {});
test("batch path used above threshold", async () => { /* 6 new files → one commitBatch, fake.writes === 3 */ });
test("bucket exhausted defers pushes", async () => { /* capacity 2, 5 files → 2 pushed, rateLimitedUntil set, next sync after time advance pushes rest */ });
```

  `tests/bucket.test.ts`: ёмкость 20, `tryTake(20)` true, затем `tryTake(1)` false; через 15 с `tryTake(1)` true (4/мин); `msUntil`.
- [ ] **Step 2:** → FAIL. **Step 3:** реализовать. **Step 4:** → PASS.
- [ ] **Step 5:** Commit `feat: sync engine pull/push`.

---

### Task 9: SyncEngine — merge, конфликты, удаления, предохранители

**Files:**
- Modify: `src/engine.ts`
- Test: `tests/engine.test.ts`

**Interfaces:**
- Consumes: `merge3`, `mergeJson`, `isMergeablePath`, `tryDecodeUtf8`, `MAX_MERGE_BYTES` (Task 3), `conflictPath` (Task 1).
- Produces: без новых публичных имён; `SyncReport.conflicts` — пути созданных конфликт-копий, `deferred` — отложенные из-за правки во время цикла.

Правила — раздел «Merge и конфликты» и «Предохранители» спеки. База = `getBlobText(state.files[p].blobSha)` → `decryptFile`. Порядок для «изменён с обеих сторон»: идентичны → просто обновить состояние; mergeable и ≤ 2 МБ и `merge3 !== null` → записать результат локально и `putFile` с `prevBlobSha` = новый удалённый sha; `.json` в `.obsidian` → `mergeJson`; иначе → локальное содержимое пишется в `conflictPath(p, deviceName, new Date(now()))` (новый файл, пушится в этом же цикле), удалённое — в `p`. Перед записью на диск: `stat` + при изменении `mtime/size` с момента сканирования — перехэш; если хэш ≠ отсканированного → файл в `deferred`, не трогать. Массовое удаление: удаление считается переименованием, если в этом же цикле есть создание с тем же `localHash`; остальные удаления (локально или на GitHub) > `massDeletePercent`% от числа файлов в состоянии и > `massDeleteMin` → `confirmMassDelete`; false → удаления не выполняются ни в одну сторону, остальное синкается.

- [ ] **Step 1: Failing tests:**

```ts
test("non-overlapping concurrent edits merge silently", async () => {
  // base "a\nb\nc"; A: "A\nb\nc"; B: "a\nb\nC"; A.sync, B.sync, A.sync → both "A\nb\nC", no conflict files
});
test("overlapping edits → conflict copy, remote keeps path", async () => {
  // A: "x"→"y" sync; B: "x"→"z" sync → B has note.md="y" and "note (conflict B ...).md"="z"; A.sync gets copy too
});
test("binary edited on both → conflict copy", async () => {});
test("created on both without base, identical → no conflict", async () => {});
test("created on both without base, different → conflict copy", async () => {});
test("delete vs edit → edit wins, file restored everywhere", async () => {});
test("typing during pull write → deferred, local edit preserved", async () => {
  // FakeFs.onBeforeWrite modifies the target file → report.deferred contains it; content is the typed one; next sync merges
});
test("mass delete asks and can be refused", async () => {
  // 30 files, A deletes 10 → B.sync with confirm=false → B keeps all 30, state unchanged for those
});
test("folder rename of 50 files is not mass delete", async () => {
  // A moves 50 files to new folder → confirmMassDelete never called; B ends with files only in new folder
});
test("empty local vault vs full remote downloads, never deletes", async () => {});
test(".obsidian json merged key-wise when syncConfig", async () => {});
```

- [ ] **Step 2:** → FAIL. **Step 3:** реализовать. **Step 4:** → PASS (включая тесты Task 8).
- [ ] **Step 5:** Commit `feat: merge, conflict copies and safety guards`.

---

### Task 10: SyncEngine — tarball, привязка существующих файлов, ошибки API

**Files:**
- Modify: `src/engine.ts`
- Test: `tests/engine.test.ts`

**Interfaces:**
- Consumes: `getTarball`, `fileHistoryBlobShas` (Task 4).
- Produces: `SyncReport.rateLimitedUntil` заполняется и из `RateLimitError`; `AuthError` пробрасывается из `sync()` наружу (Obsidian-слой ставит паузу).

Поведение: при числе изменённых удалённых файлов > `tarballThreshold` или при `state.headSha === null` и непустом удалённом дереве — `getTarball(head)` вместо поштучных blob. Пустое состояние + локальные файлы есть (раздел «Привязка устройства…» спеки): совпало → записать состояние; отличается → `fileHistoryBlobShas(path, 20)`, найти версию с тем же открытым текстом → взять удалённую без конфликта; не нашли → конфликт-копия. `ShaConflictError` на push → pull этих файлов и повтор, максимум 3 раза за цикл, затем оставить на следующий. `RateLimitError` → прервать цикл, сохранить состояние, вернуть отчёт с `rateLimitedUntil`. `AuthError` → сохранить состояние и пробросить.

- [ ] **Step 1: Failing tests:**

```ts
test("fresh device with >300 remote changes uses tarball", async () => { /* fake.reads: 1 tarball, 0 blobs */ });
test("rebind: lost state, identical files → no transfers, no conflicts", async () => {});
test("rebind: local file is an older version → takes remote, no conflict", async () => {});
test("rebind: local file diverged → conflict copy", async () => {});
test("persistent sha conflict gives up after 3 retries without data loss", async () => {});
test("RateLimitError mid-cycle saves progress and reports resetAt", async () => {});
test("AuthError mid-cycle leaves files and state intact and rethrows", async () => {
  // failNext("putFile", new AuthError()) → sync rejects AuthError; local files unchanged; next sync (no error) pushes
});
```

- [ ] **Step 2:** → FAIL. **Step 3:** реализовать. **Step 4:** → PASS.
- [ ] **Step 5:** Commit `feat: tarball pull, rebind, API error handling`.

---

### Task 11: Симуляция трёх устройств

**Files:**
- Create: `tests/sim.test.ts`

**Interfaces:**
- Consumes: `FakeGitHub`, `FakeFs`, `makeDevice`.

Сценарий на seed (простой PRNG, напр. mulberry32): 3 устройства (одно с `nfd: true`), 300 шагов; на каждом шаге случайное устройство делает одно из: создать / дописать строку / изменить строку / удалить / переименовать / `sync()` / `sync()` с инъекцией ошибки в случайный вызов API (`failNext`) или `store.save`. Журнал «последних сохранённых версий»: каждая версия файла, бывшая на диске устройства прямо перед его `sync()`. В конце — по 2 раунда `sync()` на всех без ошибок, `confirmMassDelete` всегда true.

- [ ] **Step 1: Write test:**

```ts
for (const seed of range(0, 200)) test(`sim seed ${seed}`, async () => {
  // ... run ...
  // 1) все три FakeFs содержат одинаковые множества путей (NFC) и байты
  // 2) каждая журнальная версия X файла p либо равна текущему p, либо содержится в какой-то конфликт-копии,
  //    либо её строки присутствуют в текущем p (результат merge), либо p был удалён позже другим устройством,
  //    либо X есть среди blob в истории FakeGitHub
  // 3) ни один файл не содержит "<<<<<<<"
});
```

- [ ] **Step 2:** `npx vitest run tests/sim.test.ts` → при падении — исправить `src/engine.ts` (не тест); каждую найденную ошибку закрепить отдельным детерминированным тестом в `tests/engine.test.ts`.
- [ ] **Step 3:** → PASS для всех 200 seed.
- [ ] **Step 4:** Commit `test: three-device sync simulation`.

---

### Task 12: Авторизация (Device Flow)

**Files:**
- Create: `src/auth.ts`
- Test: `tests/auth.test.ts`

**Interfaces:**
- Consumes: `Http`, `AuthError` (Task 4).
- Produces:

```ts
export interface DeviceCode { deviceCode: string; userCode: string; verificationUri: string; interval: number; expiresAt: number }
export function startDeviceFlow(http: Http, clientId: string, now: () => number): Promise<DeviceCode>;
export function pollDeviceToken(http: Http, clientId: string, code: DeviceCode, sleep: (ms: number) => Promise<void>, now: () => number): Promise<string>; // access token
export function listInstallationRepos(http: Http, token: string): Promise<{ owner: string; repo: string }[]>;
export const GITHUB_CLIENT_ID: string; // заполняется после регистрации App (README)
```

`POST https://github.com/login/device/code` (`client_id`), `Accept: application/json` → поля `device_code`, `user_code`, `verification_uri`, `interval`, `expires_in`. Опрос `POST https://github.com/login/oauth/access_token` с `grant_type=urn:ietf:params:oauth:grant-type:device_code`: `authorization_pending` → ждать `interval`; `slow_down` → `interval += 5`; `expired_token`/`access_denied` → `AuthError`; истёк `expiresAt` → `AuthError`. Репозитории: `GET /user/installations` → для каждой `GET /user/installations/{id}/repositories`.

- [ ] **Step 0:** Проверить в актуальной документации GitHub: (а) Device Flow для GitHub App не требует `client_secret`; (б) опция отключения истечения user-to-server токенов существует. Если (б) нет — остановиться и сообщить владельцу (нужно решение по refresh).
- [ ] **Step 1: Failing tests** с фейковым `Http`: успешный поток (pending → pending → token); `slow_down` увеличивает интервал на 5 с (проверить аргументы `sleep`); `access_denied` → `AuthError`; истечение по времени → `AuthError`; `listInstallationRepos` собирает репозитории из двух установок.
- [ ] **Step 2:** → FAIL. **Step 3:** реализовать. **Step 4:** → PASS.
- [ ] **Step 5:** Commit `feat: GitHub device flow auth`.

---

### Task 13: Obsidian-слой: ФС, хранилище состояния, планировщик

**Files:**
- Create: `src/obsidianfs.ts`, `src/scheduler.ts`
- Test: `tests/scheduler.test.ts`

**Interfaces:**
- Consumes: `LocalFs`, `StateStore`, `SyncState`, `ALWAYS_IGNORED`.
- Produces:
  - `class ObsidianFs implements LocalFs { constructor(app: App) }` — `list`: `vault.getFiles()` + при `includeConfig` рекурсивный `adapter.list(app.vault.configDir)`; `write`: `adapter.writeBinary` (папки через `adapter.mkdir`), для существующего `TFile` — `vault.modifyBinary`; `trash`: `app.vault.trash(file, true)` (системная корзина; fallback — `adapter.trashLocal`).
  - `class AdapterStateStore implements StateStore { constructor(adapter: DataAdapter, dir: string) }` — запись в `state.json.tmp`, затем `adapter.rename` поверх (`remove` старого, если rename не перезаписывает).
  - `class Scheduler { constructor(opts: { run: () => Promise<void>; now: () => number; setTimer: (fn: () => void, ms: number) => number; clearTimer: (id: number) => void; isVisible: () => boolean }); onLocalChange(): void; onVisibilityChange(): void; start(): void; stop(): void; pauseUntil(ts: number): void }` — правки: таймер 2 000 мс с перезапуском, но не позже 15 000 мс от первой непрошедшей правки; опрос 4 000 / 60 000 мс по видимости; видимость → немедленный `run`; `run` никогда не перекрывается (если идёт — флаг «ещё раз»); `pauseUntil` подавляет запуски до момента.

- [ ] **Step 1: Failing tests** `tests/scheduler.test.ts` с ручными таймерами: серия правок каждые 1 с → первый `run` на 15 с, не раньше; одна правка → `run` через 2 с; скрыто → опрос раз в 60 с; показ → немедленный `run`; долгий `run` + новая правка → ровно один повторный запуск после; `pauseUntil`.
- [ ] **Step 2:** → FAIL. **Step 3:** реализовать `scheduler.ts`, затем `obsidianfs.ts` (без юнит-тестов — проверяется в Task 15 вручную).
- [ ] **Step 4:** → PASS; `npm run build` без ошибок типов.
- [ ] **Step 5:** Commit `feat: obsidian fs adapter and scheduler`.

---

### Task 14: Плагин, настройки, онбординг, UI

**Files:**
- Create: `src/settings.ts`, `src/main.ts`, `styles.css`

**Interfaces:**
- Consumes: всё выше.
- Produces:
  - `interface PluginSettings { owner: string; repo: string; deviceName: string; syncConfig: boolean; ignore: string[]; massDeletePercent: number; rememberPassword: boolean }` — в `data.json` (без секретов).
  - localStorage-ключи: `gitvault-sync:token`, `gitvault-sync:password`, `gitvault-sync:deviceId`.

Поведение (раздел «Онбординг» и «UI» спеки):
- Настройки, блок «Подключение»: «1. Создать репозиторий» → `window.open("https://github.com/new?name=obsidian-vault&visibility=private")`; «2. Разрешить доступ» → `window.open("https://github.com/apps/<APP_SLUG>/installations/new")`, затем модалка Device Flow (код крупно, кнопка «Скопировать и открыть github.com/login/device», статус ожидания); после токена — `listInstallationRepos`, выпадающий список при > 1. Затем модалка пароля: `getTree(head)` нет `gitvault.json` → «Задайте пароль» ×2 + предупреждение «потерянный пароль не восстановить» → `createVault` → `putFile("gitvault.json", JSON)`; есть → «Введите пароль» → `unlockVault`, `WrongPasswordError` → сообщение в модалке. «Выйти» — стереть токен/пароль из localStorage, состояние оставить.
- Остальные настройки: имя устройства (по умолчанию `Platform.isIosApp ? "iPhone" : Platform.isMacOS ? "Mac" : "PC"`), тумблер синка настроек (подпись: «применится после перезапуска Obsidian»), игнор (textarea, по строке), порог массового удаления, строка «Размер репозитория: N МБ» (`repoSizeKb`, жёлтым ≥ 700 МБ).
- `main.ts`: `onload` — загрузить настройки, если есть токен+пароль — `unlockVault` (пароль не запомнен → модалка при старте), собрать `SyncEngine`, `Scheduler`; `vault.on("modify"|"create"|"delete"|"rename")` → `scheduler.onLocalChange()`; `document.addEventListener("visibilitychange")`; команды `sync-now`, `toggle-pause`, `show-status`; статус-бар: `✓ HH:MM` / `↻` / `⚠ N конфликт(а)` / `⏸ лимит GitHub до HH:MM` / `✗ <ошибка>`, клик — модалка статуса (последние 50 событий, ссылки на конфликт-копии открывают файл). `confirmMassDelete` → модалка «Синхронизация удалит N из M файлов. Продолжить?» [Удалить] [Не удалять]. Новые конфликты → `new Notice("Конфликт: создана копия <путь>")`. `AuthError` → пауза + статус «✗ войдите снова». `RateLimitError` → `scheduler.pauseUntil`.

- [ ] **Step 1:** Реализовать `settings.ts`, `main.ts`, `styles.css`.
- [ ] **Step 2:** `npm run build` → `main.js` собран, без ошибок; `npm test` → всё PASS.
- [ ] **Step 3:** Commit `feat: obsidian plugin UI and onboarding`.

---

### Task 15: README, регистрация GitHub App, ручной e2e

**Files:**
- Create: `README.md`
- Modify: `src/auth.ts` (`GITHUB_CLIENT_ID`), `src/settings.ts` (`APP_SLUG`) — после регистрации владельцем

- [ ] **Step 1:** README: что это; установка (BRAT или ручная копия `main.js`, `manifest.json`, `styles.css`); **регистрация GitHub App** пошагово — github.com/settings/apps/new: имя, Homepage URL любой, снять «Webhook active», Permissions → Repository → Contents: Read and write (Metadata: Read подставится), «Enable Device Flow», «Where can this GitHub App be installed: Only on this account», отключить истечение user-to-server токенов; скопировать Client ID и slug; ограничения GitHub (500 записей/ч, 100 МБ/файл, ~1 ГБ на репозиторий) и что делать при приближении; «потерянный пароль не восстановить».
- [ ] **Step 2:** Владелец регистрирует App, присылает Client ID и slug → вписать, `npm run build`.
- [ ] **Step 3: Ручной e2e** (Mac + iPhone, реальный приватный репозиторий), отметить каждый пункт:
  - онбординг на Mac с пустым репозиторием; на iPhone — с вводом пароля; неверный пароль отклоняется;
  - правка на Mac появляется на iPhone ≤ 10 с при открытом приложении;
  - замерить: тратит ли 304 на `getHead` лимит (`x-ratelimit-remaining` до/после 20 опросов) — если тратит, поднять интервал опроса до 10 с и отметить в README;
  - первая загрузка ~1000 файлов пакетом: замерить максимальный размер inline-tree запроса без ошибки, выставить размер чанка с запасом 2×;
  - tarball через `requestUrl` на iPhone (редирект на codeload) работает;
  - одновременная правка одной строки → конфликт-копия на обоих; разных строк → тихий merge;
  - убить Obsidian на iPhone посреди синка → следующий запуск без конфликт-копий;
  - в репозитории на github.com видны только `gitvault.json` и `f/**` с нечитаемым содержимым.
- [ ] **Step 4:** Commit `docs: README and GitHub App setup`.
