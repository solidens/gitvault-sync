// vitest has no obsidian runtime; http.ts imports requestUrl from it.
export const requestUrl = (): never => { throw new Error("obsidian stub"); };
