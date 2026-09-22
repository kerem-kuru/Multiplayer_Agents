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
   * --- contracts_race: aynı sözleşme dosyasına 60 sn içinde iki farklı agent
   *
   * Projeksiyon dosya başına YALNIZCA son yazanı tutuyor. Yani burada
   * görebileceğimiz şey "son yazan X, ve bu yazma penceresi içinde" — ikinci
   * agent'ı bilmek için turn'lere bakmak gerekirdi. Bunun yerine: bir sözleşme
   * dosyasına son yazan agent ile o dosyayı DEĞİŞTİRMİŞ görünen başka bir agent
   * varsa (diff'inde ya da daha önce yazmışsa) yarış sayılır.
   *
   * Pratikte ikinci agent'ı bulmanın güvenilir yolu, aynı pencerede başka bir
   * sözleşme yazımı olup olmadığına bakmak: `contracts/` altında 60 sn içinde
   * iki FARKLI agent yazmışsa, o dosyalar için yarış vardır.
   */
  const recent: Array<{ path: string; agent: string; at: number }> = [];
  for (const [path, c] of Object.entries(view.contracts ?? {})) {
    const at = Date.parse(c.at);
    if (!Number.isFinite(at)) continue;
    if (now.getTime() - at > CONTRACTS_RACE_WINDOW_MS) continue;
    recent.push({ path, agent: c.lastAgent, at });
  }

  const racePairs = new Map<string, { agents: Set<string>; paths: Set<string> }>();
  for (let i = 0; i < recent.length; i += 1) {
    for (let j = i + 1; j < recent.length; j += 1) {
      const a = recent[i]!;
      const b = recent[j]!;
      if (a.agent === b.agent) continue;
      if (Math.abs(a.at - b.at) > CONTRACTS_RACE_WINDOW_MS) continue;
      const pair = [a.agent, b.agent].sort();
      const key = pair.join("+");
      const entry = racePairs.get(key) ?? { agents: new Set(pair), paths: new Set<string>() };
      entry.paths.add(a.path);
      entry.paths.add(b.path);
      racePairs.set(key, entry);
    }
  }
  for (const entry of racePairs.values()) {
    const pair = [...entry.agents].sort();
    const paths = [...entry.paths].sort();
    out.push({
      id: conflictId("contracts_race", pair, paths),
      kind: "contracts_race",
      agents: pair,
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
