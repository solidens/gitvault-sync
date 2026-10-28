import { getLanguage } from "obsidian";

export const isRu = getLanguage().startsWith("ru");
/** The string for the user's Obsidian language: English by default, Russian for "ru". */
export const t = (en: string, ru: string): string => (isRu ? ru : en);
