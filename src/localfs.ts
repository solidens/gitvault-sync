export interface FileStat { path: string; mtime: number; size: number }
export interface LocalFs {
  list(includeConfig: boolean): Promise<FileStat[]>; // paths as on disk
  read(path: string): Promise<ArrayBuffer>;
  stat(path: string): Promise<FileStat | null>;
  write(path: string, data: ArrayBuffer): Promise<FileStat>; // creates folders
  trash(path: string): Promise<void>;
}
