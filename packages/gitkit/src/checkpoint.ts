import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { git } from "./git.js";
import { DEFAULT_EXCLUDES, ROOMS_INDEX, currentTree, headCommit, isRepo } from "./tree.js";

/**
 * Checkpoint = bir ağaç nesnesi + onu tutan bir commit + `refs/rooms/*` altında
 * bir ref.
 *
 * **Neden branch'e commit değil:** checkpoint'i agent'ın branch'ine atmak
 * agent'ın geçmişini kirletir ve Hafta 9–10'daki commit/push akışını bozar.
 * Checkpoint'ler geçici bir index ile üretilir; branch'e, HEAD'e, kullanıcının
 * index'ine ve çalışma ağacına DOKUNMAZ.
 *
 * **Ref neden gerekli:** ref'siz bir commit nesnesi ulaşılamazdır ve `git gc`
 * onu siler. O zaman "öğle arasındaki hâle göre diff" isteyince taban ağacı
 * bulunamaz.
 */
export const CHECKPOINT_REF_PREFIX = "refs/rooms/checkpoints";

export type CheckpointKind = "baseline" | "manual" | "turn";

export interface Checkpoint {
  checkpointId: string;
  commitSha: string;
  treeSha: string;
}

/** `cp_` + 12 hex. Kısa: event'lerde, ref adında ve UI'da görünüyor. */
export function newCheckpointId(): string {
  return `cp_${randomBytes(6).toString("hex")}`;
}

export function checkpointRef(id: string): string {
  return `${CHECKPOINT_REF_PREFIX}/${id}`;
}

export async function createCheckpoint(
  cwd: string,
  id: string,
  label: string,
): Promise<Checkpoint> {
  const tree = await currentTree(cwd);
  const head = await headCommit(cwd);
  const commit = (
    await git(cwd, ["commit-tree", tree, "-p", head, "-m", `rooms checkpoint: ${label}`])
  ).trim();
  await git(cwd, ["update-ref", checkpointRef(id), commit]);
  return { checkpointId: id, commitSha: commit, treeSha: tree };
}

/** Checkpoint'in ağacı hâlâ duruyor mu — isteğe bağlı diff bunu sorar. */
export async function resolveCheckpointTree(cwd: string, id: string): Promise<string | null> {
  try {
    return (await git(cwd, ["rev-parse", `${checkpointRef(id)}^{tree}`])).trim();
  } catch {
    return null;
  }
}

/**
 * Boş ağacın sha'sı. Sabit yazmak yerine hesaplanıyor: sha256 nesne biçimiyle
 * açılmış bir depoda sabit yanlış olurdu.
 */
async function emptyTree(cwd: string): Promise<string> {
  const scratch = path.join(cwd, ".git", `rooms-empty-index-${randomBytes(4).toString("hex")}`);
  try {
    return (await git(cwd, ["write-tree"], { env: { GIT_INDEX_FILE: scratch } })).trim();
  } finally {
    await fs.rm(scratch, { force: true }).catch(() => undefined);
  }
}

async function ensureExcludes(cwd: string): Promise<void> {
  const file = path.join(cwd, ".git", "info", "exclude");
  await fs.mkdir(path.dirname(file), { recursive: true });
  let current = "";
  try {
    current = await fs.readFile(file, "utf8");
  } catch {
    current = "";
  }
  const have = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const missing = DEFAULT_EXCLUDES.filter((p) => !have.has(p));
  if (missing.length === 0) return;
  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  await fs.appendFile(file, `${prefix}# agent-rooms\n${missing.join("\n")}\n`, "utf8");
}

export interface InitWorkspaceResult extends Checkpoint {
  /** Depo bu çağrıda mı yaratıldı — kapı ve README bunu ayırt ediyor. */
  created: boolean;
}

/**
 * Workspace'i depoya çevir ve TABAN checkpoint'ini al.
 *
 * Agent'ın ilk başlatılmasından ÖNCE, sunucu tarafından bir kez çağrılır.
 * Sonradan workspace'e elle kopyalanan dosyalar agent değişikliği gibi
 * görünür; bunu sıfırlamanın yolu manuel checkpoint almaktır.
 */
export async function initWorkspace(cwd: string): Promise<InitWorkspaceResult> {
  const existed = await isRepo(cwd);
  if (!existed) await git(cwd, ["init", "-b", "main"]);

  // Yalnızca BU depo için. Global git konfigürasyonuna dokunulmuyor.
  await git(cwd, ["config", "user.name", "rooms"]);
  await git(cwd, ["config", "user.email", "rooms@localhost"]);
  await ensureExcludes(cwd);

  /**
   * HEAD yoksa (yeni depo ya da hiç commit almamış depo) boş bir başlangıç
   * commit'i gerekiyor: checkpoint commit'lerinin bir ebeveyni olmalı.
   * `commit-tree` ile yapılıyor, `git commit` ile değil — `git commit`
   * kullanıcının index'ini okur ve yazar.
   */
  let unborn = false;
  try {
    await headCommit(cwd);
  } catch {
    unborn = true;
  }
  if (unborn) {
    const tree = await emptyTree(cwd);
    const commit = (await git(cwd, ["commit-tree", tree, "-m", "rooms: boş başlangıç"])).trim();
    const branch = (await git(cwd, ["symbolic-ref", "--quiet", "HEAD"]).catch(() => "refs/heads/main\n")).trim();
    await git(cwd, ["update-ref", branch || "refs/heads/main", commit]);
  }

  const cp = await createCheckpoint(cwd, newCheckpointId(), "taban");
  return { ...cp, created: !existed };
}

export { ROOMS_INDEX };
