// vitest has no obsidian runtime; http.ts imports requestUrl from it, obsidianfs.ts TFile.
export const requestUrl = (): never => { throw new Error("obsidian stub"); };
export class TFile { path = ""; }
export class TFolder { path = ""; children: unknown[] = []; isRoot(): boolean { return this.path === "/"; } }
