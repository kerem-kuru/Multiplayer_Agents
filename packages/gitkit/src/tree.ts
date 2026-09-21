import path from "node:path";
import { git } from "./git.js";

/**
 * "Şu anki çalışma ağacı" → bir git ağaç nesnesi, kullanıcının index'ine
 * DOKUNMADAN.
 *
 * Neden geçici index: `git add -A` normalde `.git/index` dosyasını yazar. O
 * dosya agent'ın (ve Hafta 9'da commit akışının) çalışma alanıdır; her araç
 * çağrısından sonra onu ezmek agent'ın gözünde dosyaları sahneye almak olur.
 * `GIT_INDEX_FILE` ile ayrı bir dosyaya yazınca branch, HEAD, index ve çalışma
 * ağacı değişmeden kalır.
 *
 * Geçici index dosyası KALICIDIR ve bilinçli olarak öyle: sonraki `add -A`
 * çağrıları sadece mtime'ı değişen dosyaları yeniden hash'ler. Her seferinde
 * silmek büyük depolarda her araç çağrısını saniyelere çıkarır.
 */
export const ROOMS_INDEX = ".git/rooms-index";

/** Agent'ın `.gitignore`'ına DOKUNULMAZ; bizimkiler `.git/info/exclude`'a girer. */
export const DEFAULT_EXCLUDES = [
  "node_modules/",
  "dist/",
  "build/",
  ".venv/",
  "__pycache__/",
  ".next/",
  "coverage/",
  ".DS_Store",
];

const indexEnv = (cwd: string): Record<string, string> => ({
  GIT_INDEX_FILE: path.join(cwd, ROOMS_INDEX),
});

/**
 * Çalışma ağacının şu anki hâlinin ağaç sha'sı.
 *
 * `add -A` `.gitignore` ve `info/exclude` kurallarına uyar, yani
 * `node_modules/` diff'e girmez.
 */
export async function currentTree(cwd: string): Promise<string> {
  const env = indexEnv(cwd);
  await git(cwd, ["add", "-A", "--", "."], { env });
  return (await git(cwd, ["write-tree"], { env })).trim();
}

/** HEAD commit'i. Checkpoint commit'inin ebeveyni olur. */
export async function headCommit(cwd: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "HEAD"])).trim();
}

export async function isRepo(cwd: string): Promise<boolean> {
  try {
    const out = (await git(cwd, ["rev-parse", "--is-inside-work-tree"])).trim();
    return out === "true";
  } catch {
    return false;
  }
}
