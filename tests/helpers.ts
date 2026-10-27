import type { LocalFs } from "../src/localfs";

export async function text(fs: LocalFs, path: string): Promise<string> {
  return new TextDecoder().decode(await fs.read(path));
}
