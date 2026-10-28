// Obsidian keeps its interface language in localStorage "language" (absent = English); no window in tests.
const lang = (typeof localStorage !== "undefined" && localStorage.getItem("language")) || "en";
export const isRu = lang.startsWith("ru");
/** The string for the user's Obsidian language: English by default, Russian for "ru". */
export const t = (en: string, ru: string): string => (isRu ? ru : en);
