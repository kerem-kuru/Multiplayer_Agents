import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Hafta 7, Değişmez Kural 6 — **oda görünümünde ham çıktı yok.**
 *
 * Bu, gözle bakılıp "tamam görünüyor" denecek bir kural değil: bir gün biri
 * kartlara küçük bir diff önizlemesi eklemek isteyecek ve kural sessizce
 * ölecek. Burada BİLEŞEN AĞACI taranıyor — `RoomView`'dan ulaşılabilen hiçbir
 * dosya terminal, patch ya da tool sonucu gösteren bileşenleri import
 * edemiyor.
 *
 * Playwright tarafı DOM'u ölçüyor (`gate:w7`, kontrol 17); bu test aynı şeyi
 * saniyeler içinde ve tarayıcı açmadan söylüyor.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..", "src");

/** Oda görünümüne girmesi yasak olan bileşenler ve kütüphaneler. */
const YASAK = ["TerminalView", "DiffFile", "DiffView", "xterm", "LineComment", "ReviewTray"];

/** Yerel (göreli) import'ları çıkarır. */
function localImports(source: string): string[] {
  const out: string[] = [];
  const re = /from\s+["'](\.[^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

async function readIfExists(file: string): Promise<string | null> {
  for (const candidate of [file, `${file}.tsx`, `${file}.ts`]) {
    try {
      return await readFile(candidate, "utf8");
    } catch {
      // sıradakini dene
    }
  }
  return null;
}

/** `RoomView`dan başlayarak ulaşılabilen tüm yerel dosyalar. */
async function reachableFiles(entry: string): Promise<Map<string, string>> {
  const seen = new Map<string, string>();
  const queue = [entry];

  while (queue.length > 0) {
    const current = queue.pop()!;
    // ".js" uzantılı TS import'ları diskte ".tsx"/".ts".
    const base = current.replace(/\.js$/, "");
    if (seen.has(base)) continue;
    const source = await readIfExists(base);
    if (source === null) continue;
    seen.set(base, source);

    for (const rel of localImports(source)) {
      queue.push(path.resolve(path.dirname(base), rel));
    }
  }
  return seen;
}

describe("oda görünümünde ham çıktı yok", () => {
  it("RoomView ağacı terminal/diff bileşenlerini import etmiyor", async () => {
    const files = await reachableFiles(path.join(SRC, "pages", "RoomView.tsx"));

    // Tarama gerçekten çalıştı mı: en az giriş + kart bileşeni görülmeli.
    expect(files.size).toBeGreaterThanOrEqual(2);
    // Anahtarlar uzantısız tutuluyor (".js" import'u ".tsx" dosyaya çözülüyor).
    const names = [...files.keys()].map((f) => path.basename(f).replace(/\.(tsx|ts)$/, ""));
    expect(names).toContain("RoomView");
    expect(names).toContain("AgentCard");

    const ihlaller: string[] = [];
    for (const [file, source] of files) {
      for (const yasak of YASAK) {
        // Yalnızca import satırlarına bak: bir yorumda adı geçmesi ihlal değil.
        const importLines = source
          .split("\n")
          .filter((l) => /^\s*import\s/.test(l) || /require\(/.test(l));
        if (importLines.some((l) => l.includes(yasak))) {
          ihlaller.push(`${path.basename(file)} → ${yasak}`);
        }
      }
    }

    expect(ihlaller).toEqual([]);
  });

  it("agent detayı bunları KULLANABİLİR — kural yalnızca oda görünümünde", async () => {
    // Karşı kontrol: test yanlışlıkla her şeyi "temiz" bulmuyor.
    const detail = await readFile(path.join(SRC, "components", "RoomPage.tsx"), "utf8");
    expect(detail).toContain("TerminalView");
  });
});
