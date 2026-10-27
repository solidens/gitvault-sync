export interface FileStat { path: string; mtime: number; size: number }
/** write() refused: the file no longer holds the expected bytes (the user is editing it). */
export class LocalChangedError extends Error {
  constructor(public path: string) { super(`changed meanwhile: ${path}`); this.name = "LocalChangedError"; }
}
export interface LocalFs {
  list(includeConfig: boolean): Promise<FileStat[]>; // paths as on disk
  read(path: string): Promise<ArrayBuffer>;
  stat(path: string): Promise<FileStat | null>;
  /** Creates folders. expected: bytes the file must still hold (null = must not exist), else LocalChangedError; omitted = no check. */
  write(path: string, data: ArrayBuffer, expected?: ArrayBuffer | null): Promise<FileStat>;
  trash(path: string): Promise<void>;
}
