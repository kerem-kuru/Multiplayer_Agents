import type { RoomView } from "@agent-rooms/view";

/**
 * Hafta 7, Adım 8 — çakışma tespiti.
 *
 * Saf fonksiyon: oda görünümü girer, çakışma listesi çıkar. `AgentManager` her
 * `diff.updated` ve `contract.changed` sonrası çalıştırır, önceki sonuçla
 * karşılaştırır ve farkları event olarak yazar.
 *
 * **Bu bir ENGELLEME değil, bir GÖRÜNÜRLÜK.** Dosyalar kilitlenmiyor, hiçbir
 * yazma reddedilmiyor. Amaç, ileride birleştirmede çıkacak sorunu insanın
 * ŞİMDİ görmesi. Gerçek `merge-tree` kontrolü Hafta 9'un işi.
 */

export type ConflictKind = "path_overlap" | "contracts_race";

export interface Conflict {
  id: string;
  kind: ConflictKind;
  /** Her zaman sıralı — id'nin deterministik olması buna bağlı. */
  agents: string[];
  paths: string[];
}

/** İki agent'ın aynı `contracts/` dosyasına yazması bu süre içindeyse yarış sayılır. */
export const CONTRACTS_RACE_WINDOW_MS = 60_000;

/**
 * Çakışma kimliği DETERMİNİSTİK üretilir: tür + sıralı agent'lar + sıralı yollar.
 *
 * Rastgele bir id (ör. uuid) olsaydı aynı çakışma her ölçümde "yeni" sayılır,
 * her turn sonunda bir `conflict.detected` daha yazılır ve ekranda sürekli
 * yanıp sönen bir uyarı olurdu.
 */
export function conflictId(kind: ConflictKind, agents: string[], paths: string[]): string {
  return [kind, [...agents].sort().join("+"), [...paths].sort().join(",")].join("|");
}

/**
 * Bir agent'ın canlı diff'inde değişmiş yolları verir.
 *
 * `status: "clean"` olanlar ATLANIR: Hafta 6'da tabana geri dönen dosya bu
 * durumla işaretleniyor ve artık bir değişiklik değil. Atlanmasaydı, bir agent
 * değişikliğini geri aldıktan sonra çakışma temizlenmezdi.
 */
function changedPaths(view: RoomView, agent: string): string[] {
  const files = view.agents[agent]?.diff?.files ?? {};
  const out: string[] = [];
  for (const [path, f] of Object.entries(files)) {
    if ((f as { status?: string }).status === "clean") continue;
    out.push(path);
  }
  return out;
}

/**
 * Açık çakışmaları hesaplar.
 *
 * `now` dışarıdan veriliyor: `contracts_race` zamana bağlı ve test edilebilir
 * olması için saati fonksiyonun içinden okumamak gerekiyor.
 */
export function detectConflicts(view: RoomView, now: Date = new Date()): Conflict[] {
  const out: Conflict[] = [];
  const agents = Object.keys(view.agents).sort();

  // --- path_overlap: iki agent aynı depo-göreli yolu değiştirmiş -----------
  const byPath = new Map<string, string[]>();
  for (const agent of agents) {
    for (const path of changedPaths(view, agent)) {
      const list = byPath.get(path) ?? [];
      list.push(agent);
      byPath.set(path, list);
    }
  }

  /*
   * Aynı agent çiftinin çakıştığı yollar TEK bir çakışmada toplanıyor.
   *
   * Yol başına ayrı çakışma yazılsaydı, iki agent aynı 30 dosyaya dokunduğunda
   * ekranda 30 uyarı olurdu — okunamaz ve hepsi aynı şeyi söylüyor.
   */
  const byPair = new Map<string, { agents: string[]; paths: string[] }>();
  for (const [path, list] of byPath) {
    if (list.length < 2) continue;
    const sorted = [...list].sort();
    const key = sorted.join("+");
    const entry = byPair.get(key) ?? { agents: sorted, paths: [] };
    entry.paths.push(path);
    byPair.set(key, entry);
  }
  for (const { agents: pair, paths } of byPair.values()) {
    const sortedPaths = [...paths].sort();
    out.push({
      id: conflictId("path_overlap", pair, sortedPaths),
      kind: "path_overlap",
      agents: pair,
      paths: sortedPaths,
    });
  }

  /*
   * --- contracts_race: AYNI sözleşme dosyasına 60 sn içinde iki farklı agent
   *
   * Projeksiyon her dosya için her agent'ın son yazma anını tutuyor
   * (`lastWriteBy`). Pencere içinde yazmış agent'lar iki ya da daha fazlaysa
   * o dosyada yarış var: biri ötekinin yazdığını ezmiş olabilir. İkisi de
   * [şimdi - 60 sn, şimdi] aralığında olduğundan aralarındaki fark da 60 sn'yi
   * geçemez.
   *
   * 29 Eylül'e kadar projeksiyon yalnızca son yazanı biliyordu ve yarış FARKLI
   * dosyalar arasında aranıyordu: aynı dosyaya yarış hiç görülmüyor (gate:w7:agent
   * [11]), farklı dosyalara yazan iki agent ise yanlışlıkla yarış sayılıyordu.
   *
   * `path_overlap` gibi: aynı agent kümesinin yarıştığı dosyalar TEK çakışmada.
   * Silme de yazmadır.
   */
  const raceSets = new Map<string, { agents: string[]; paths: string[] }>();
  for (const [path, c] of Object.entries(view.contracts ?? {})) {
    const racing = Object.entries(c.lastWriteBy ?? {})
      .filter(([, at]) => {
        const t = Date.parse(at);
        return Number.isFinite(t) && now.getTime() - t <= CONTRACTS_RACE_WINDOW_MS;
      })
      .map(([agent]) => agent)
      .sort();
    if (racing.length < 2) continue;
    const key = racing.join("+");
    const entry = raceSets.get(key) ?? { agents: racing, paths: [] };
    entry.paths.push(path);
    raceSets.set(key, entry);
  }
  for (const entry of raceSets.values()) {
    const paths = [...entry.paths].sort();
    out.push({
      id: conflictId("contracts_race", entry.agents, paths),
      kind: "contracts_race",
      agents: entry.agents,
      paths,
    });
  }

  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Önceki ve şimdiki çakışma listesini karşılaştırır.
 *
 * `AgentManager` yalnızca farkı event olarak yazar: aynı çakışma için ikinci
 * bir `conflict.detected` yazılmaz.
 */
export function diffConflicts(
  previous: readonly Conflict[],
  current: readonly Conflict[],
): { detected: Conflict[]; cleared: string[] } {
  const before = new Set(previous.map((c) => c.id));
  const after = new Set(current.map((c) => c.id));
  return {
    detected: current.filter((c) => !before.has(c.id)),
    cleared: previous.filter((c) => !after.has(c.id)).map((c) => c.id),
  };
}
