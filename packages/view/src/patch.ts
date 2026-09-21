import type { AnchorState, CommentSide, FileDiff } from "@agent-rooms/protocol";

/**
 * Unified patch → satır satır, iki taraflı numaralandırma.
 *
 * SAF ve yan etkisiz: hem sunucu (çapa doğrulaması) hem istemci (satır
 * çizimi ve yorum konumu) bunu çağırıyor. İki ayrı ayrıştırıcı olsaydı
 * kullanıcının tıkladığı satır ile sunucunun doğruladığı satır zamanla
 * birbirinden ayrılırdı — ve fark, yorumun sessizce yanlış satıra
 * yapışmasıyla görünürdü.
 */

export interface PatchLine {
  /** Eski dosyadaki satır numarası; eklenen satırlarda null. */
  oldLine: number | null;
  /** Yeni dosyadaki satır numarası; silinen satırlarda null. */
  newLine: number | null;
  kind: "context" | "add" | "del";
  /** Satırın metni — baştaki `+`/`-`/boşluk işareti ÇIKARILMIŞ hâli. */
  text: string;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parsePatch(patch: string | null): PatchLine[] {
  if (!patch) return [];
  const out: PatchLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;

  for (const raw of patch.split("\n")) {
    const hunk = HUNK.exec(raw);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[3]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue; // `diff --git`, `index`, `---`, `+++` başlıkları
    // "\ No newline at end of file" bir satır değil, bir not.
    if (raw.startsWith("\\")) continue;

    const mark = raw[0];
    const text = raw.slice(1);
    if (mark === "+") {
      out.push({ oldLine: null, newLine: newNo++, kind: "add", text });
    } else if (mark === "-") {
      out.push({ oldLine: oldNo++, newLine: null, kind: "del", text });
    } else if (mark === " ") {
      out.push({ oldLine: oldNo++, newLine: newNo++, kind: "context", text });
    }
    // Boş satır (patch'in sonundaki) ve tanınmayan işaret atlanır.
  }
  return out;
}

const numberOf = (l: PatchLine, side: CommentSide): number | null =>
  side === "new" ? l.newLine : l.oldLine;

/** Bu tarafta bu numaradaki satırın metni. Yoksa null. */
export function lineAt(patch: string | null, side: CommentSide, line: number): string | null {
  const found = parsePatch(patch).find((l) => numberOf(l, side) === line);
  return found ? found.text : null;
}

/** Çapa durumu şeması `@agent-rooms/protocol` içinde — tek tanım. */
export type { AnchorState };

export interface AnchorResult {
  anchor: AnchorState;
  currentLine: number | null;
}

/**
 * Bir yorumun çapası nerede.
 *
 * ÇAPA SATIR NUMARASI DEĞİL, SATIR NUMARASI + METİNDİR. Agent araya üç satır
 * eklerse 42 artık başka bir satırdır; yalnızca numaraya güvenmek yorumu
 * sessizce yanlış yere taşır. Bu yüzden:
 *
 * - aynı numarada aynı metin varsa `current`
 * - aynı metin dosyada başka bir satırda TEK kez geçiyorsa `moved`
 * - metin yoksa veya BİRDEN ÇOK kez geçiyorsa `outdated`
 *
 * Birden çok geçişte tahmin YAPILMAZ: iki aday varasında seçim yapmak,
 * yanlış satıra yapışmanın kibar hâli olurdu.
 */
export function anchorOf(
  file: FileDiff | undefined,
  side: CommentSide,
  line: number,
  lineText: string,
): AnchorResult {
  // Dosya diff'ten tamamen çıktı (ya da binary): çapa tutmuyor.
  if (!file || file.patch === null) return { anchor: "outdated", currentLine: null };

  const lines = parsePatch(file.patch);
  const at = lines.find((l) => numberOf(l, side) === line);
  if (at && at.text === lineText) return { anchor: "current", currentLine: line };

  const hits = lines.filter((l) => l.text === lineText && numberOf(l, side) !== null);
  if (hits.length === 1) return { anchor: "moved", currentLine: numberOf(hits[0]!, side) };

  return { anchor: "outdated", currentLine: null };
}
