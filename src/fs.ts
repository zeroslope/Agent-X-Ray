import { realpath, stat } from "node:fs/promises";

export async function resolveExistingDirectory(path: string): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  try {
    const source = await stat(path);
    if (!source.isDirectory()) {
      return { ok: false, error: `Working directory is not a directory: ${path}` };
    }
    return { ok: true, path: await realpath(path) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Cannot access working directory: ${path}: ${message}` };
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    const source = await stat(path);
    return source.isFile();
  } catch {
    return false;
  }
}
