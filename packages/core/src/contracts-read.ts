import { execCapture } from "./agents/exec.js";
import { CONTRACTS_GROUP } from "./room-fs.js";

/**
 * Hafta 7, Adım 7 — bir sözleşme dosyasının İÇERİĞİNİ okumak.
 *
 * `contracts/` her agent'a yazılabilir; yani içindeki her şey agent'ın
 * elinden çıkmış VERİDİR, symlink dahil. İlk sürüm dosyayı root ile
 * `cat` ediyordu ve yalnızca `..` arıyordu: frontend
 * `ln -s /room/worktrees/backend/x /room/contracts/leak` yapınca endpoint
 * backend'in dosyasını — ve `/etc/shadow`'u — döndürdü (23 Eylül, canlı
 * odada ölçüldü). İzolasyon dosya sisteminde kuruluyor; onu root olarak
 * okuyan her sunucu yolu delik açar.
 *
 * İki katman, biri tutmasa diğeri tutsun:
 *   1. **Kimlik:** okuma `nobody:rooms-contracts` ile yapılır — hiçbir
 *      agent'ın worktree grubunda değil, home dizinlerine giremez. Symlink
 *      nereye giderse gitsin, bu kimliğin okuyamadığı yeri okuyamaz.
 *   2. **Yol:** `realpath -e` çözülmüş yolun hâlâ `/room/contracts/`
 *      altında olduğunu doğrular; dışarı çıkan link (ör. `/etc/passwd`,
 *      herkesin okuyabildiği bir dosya) reddedilir.
 */

/** Sözleşme okumaya ayrılmış kimlik. Kullanıcı:grup biçimi ek grupları YÜKLEMEZ — istenen bu. */
export const CONTRACTS_READER = `nobody:${CONTRACTS_GROUP}`;

/** Çıkış kodları → anlamları. */
export const CONTRACT_READ_EXIT = { notFound: 2, outside: 3 } as const;

/** Container içinde koşacak komut (saf; birim testli). Yol argüman olarak geçer, kabuğa gömülmez. */
export function contractReadCommand(rel: string): string[] {
  const script = [
    `p=$(realpath -e -- "/room/contracts/$1" 2>/dev/null) || exit ${CONTRACT_READ_EXIT.notFound}`,
    `case "$p" in /room/contracts/*) ;; *) exit ${CONTRACT_READ_EXIT.outside} ;; esac`,
    `[ -f "$p" ] || exit ${CONTRACT_READ_EXIT.notFound}`,
    `exec cat -- "$p"`,
  ].join("\n");
  return ["sh", "-c", script, "contract-read", rel];
}

/** Göreli yol kabaca geçerli mi (asıl kontrol container içindeki realpath). */
export function isPlausibleContractPath(rel: string): boolean {
  return rel.length > 0 && !rel.startsWith("/") && !rel.split("/").includes("..") && !rel.includes("\0");
}

export type ContractRead =
  | { ok: true; content: string }
  | { ok: false; reason: "not_found" | "outside" };

export async function readContract(container: string, rel: string): Promise<ContractRead> {
  if (!isPlausibleContractPath(rel)) return { ok: false, reason: "outside" };
  const res = await execCapture({
    container,
    user: CONTRACTS_READER,
    cmd: contractReadCommand(rel),
    timeoutMs: 15_000,
  });
  if (res.exitCode === 0) return { ok: true, content: res.stdout };
  if (res.exitCode === CONTRACT_READ_EXIT.outside) return { ok: false, reason: "outside" };
  if (res.exitCode === CONTRACT_READ_EXIT.notFound) return { ok: false, reason: "not_found" };
  // `nobody` okuyamadı (ör. agent dosyayı 0600 yaptı): bulunamadıya denk.
  return { ok: false, reason: "not_found" };
}
