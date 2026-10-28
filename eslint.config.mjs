// The same rules the Obsidian community directory runs on releases. Tests and build scripts are not shipped.
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  { ignores: ["main.js", "node_modules/**", "tests/**", "*.mjs", "*.config.ts"] },
  ...obsidianmd.configs.recommended,
  { languageOptions: { parserOptions: { projectService: { allowDefaultProject: ["eslint.config.*"] } } } },
]);
