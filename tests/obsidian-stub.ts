// vitest has no obsidian runtime; http.ts imports requestUrl from it, obsidianfs.ts TFile.
export const requestUrl = (): never => { throw new Error("obsidian stub"); };
export class TFile { path = ""; }
export const getLanguage = (): string => "en";
