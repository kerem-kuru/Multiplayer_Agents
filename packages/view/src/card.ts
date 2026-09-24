import { formatTool, stripAnsi } from "./format-tool.js";
import type { AgentView, ConflictView, RoomView, TurnView } from "./project.js";

/**
 * Hafta 7, Adım 12 — agent kartı.
 *
 * Oda görünümünün TEK veri kaynağı. Saf: `AgentView` girer, kart çıkar.
 *
 * **"Oda görünümünde ham çıktı yok" kuralı burada uygulanıyor.** Kartın tek
 * satırı asla tool SONUCU, patch metni ya da terminal çıktısı taşımaz. Kural
 * bileşende değil burada duruyor çünkü bileşen değişir, kural değişmez — ve
 * burada test edilebiliyor.
 *
 * Bu satır Hafta 8'de oda defterinin `status` alanıyla değişecek; imza aynı
 * kalsın.
 */

export type CardStatus =
  | "calisiyor"
  | "sirada"
  | "bosta"
  | "durdu"
  | "coktu"
  | "basarisiz";

export interface AgentCard {
  name: string;
  status: CardStatus;
  /** Ekranda görünen kelime. */
  statusLabel: string;
  /** Tek satır, ≤ 100 karakter, ANSI temiz, satır sonu yok. HAM ÇIKTI DEĞİL. */
  line: string;
  lineKind: "tool" | "summary" | "status";
  queueLength: number;
  driver: string | null;
  openComments: number;
  changedFiles: number;
  /** Bu agent'ın dahil olduğu açık çakışma sayısı. */
  conflicts: number;
  /** Okunmamış hesabı için: DİKKAT GEREKTİREN son event'in sırası. */
  lastActivitySeq: number;
}

export const CARD_LINE_MAX = 100;

const LABELS: Record<CardStatus, string> = {
  calisiyor: "çalışıyor",
  sirada: "sırada",
  bosta: "boşta",
  durdu: "durdu",
  coktu: "çöktü",
  basarisiz: "başarısız",
};

/**
 * Turn başarısızlığının sebebi → Türkçe tek kelime.
 *
 * Ham `subtype` ekrana basılmaz: "error_max_turns" kullanıcıya bir şey
 * söylemiyor.
 */
const FAIL_REASONS: Record<string, string> = {
  interrupted: "kesildi",
  crashed: "çöktü",
  error: "hata verdi",
  error_max_turns: "turn sınırına takıldı",
  error_max_budget: "bütçe sınırına takıldı",
  timeout: "zaman aşımına uğradı",
  server_restart: "sunucu yeniden başladı",
  retry_exhausted: "sağlayıcı yanıt vermedi",
};

/**
 * Başarısız sağlayıcı isteğinin tek satırı: "Google yoğun (503) · 2/3. deneme".
 *
 * 24 Eylül: kullanıcı 4+ dakika "çalışıyor" gördü, sebep (503) sunucu
 * logundaydı. Kart ve akış aynı cümleyi kullansın diye tek yerde.
 */
export function retryLabel(retry: NonNullable<TurnView["retry"]>): string {
  const who = retry.provider || "sağlayıcı";
  const what =
    retry.status === 503
      ? `${who} yoğun (503)`
      : retry.status === 429
        ? `${who} kota/hız sınırı (429)`
        : retry.status !== null
          ? `${who} hata verdi (${retry.status})`
          : `${who} bağlantı hatası`;
  return `${what} · ${retry.attempt}/${retry.budget}. deneme`;
}

/** Tek satıra indirger: ANSI temizlenir, satır sonları boşluğa döner, kırpılır. */
export function oneLine(text: string, max = CARD_LINE_MAX): string {
  const flat = stripAnsi(text).replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  // Kırpma sınırı karakter; kelime ortasında kesmek okunabilirliği bozmuyor
  // ama üç nokta olmadan kesmek "metin bitti mi" sorusunu bırakırdı.
  return `${flat.slice(0, max - 1)}…`;
}

/** İlk cümle — nokta/soru/ünlemde biter, yoksa tamamı. */
export function firstSentence(text: string): string {
  const flat = stripAnsi(text).replace(/\s+/g, " ").trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(flat);
  return (m?.[1] ?? flat).trim();
}

const lastTurn = (agent: AgentView): TurnView | null =>
  agent.turns.length > 0 ? (agent.turns[agent.turns.length - 1] ?? null) : null;

/** Koşan turn'deki SON tool çağrısı. Sonucu değil, çağrıyı. */
function lastToolCall(turn: TurnView | null): { tool: string; input: unknown } | null {
  if (!turn) return null;
  for (let i = turn.items.length - 1; i >= 0; i -= 1) {
    const item = turn.items[i];
    if (item?.kind === "tool") return { tool: item.tool, input: item.input };
  }
  return null;
}

function statusOf(agent: AgentView): CardStatus {
  switch (agent.status) {
    case "busy":
      return "calisiyor";
    case "idle":
      return agent.queue.length > 0 ? "sirada" : "bosta";
    case "crashed":
      return "coktu";
    case "failed":
      return "basarisiz";
    default:
      return "durdu";
  }
}

/**
 * Dikkat gerektiren son event'in sırası.
 *
 * Her `tool.call` sayılsaydı okunmamış işareti hiç sönmezdi: koşan bir agent
 * saniyede birkaç tool çağırıyor. Sayılanlar: turn'ün bitişi, çökme, çakışma
 * ve inceleme — yani insanın BAKMASI gereken anlar.
 */
function attentionSeq(agent: AgentView, conflicts: ConflictView[]): number {
  let seq = 0;
  for (const t of agent.turns) {
    if (t.outcome.kind === "running") continue;
    for (const item of t.items) seq = Math.max(seq, item.seq);
  }
  for (const v of agent.isolationViolations) void v;
  // Çakışmaların kendi seq'i projeksiyonda tutulmuyor; kart açık çakışma
  // SAYISINI gösteriyor ve sayı değişince zaten yeni bir event gelmiş oluyor.
  void conflicts;
  return seq;
}

export function toCard(
  name: string,
  agent: AgentView,
  room?: Pick<RoomView, "conflicts">,
): AgentCard {
  const status = statusOf(agent);
  const turn = lastTurn(agent);
  const conflicts = (room?.conflicts ?? []).filter((c) => c.agents.includes(name));

  let line = LABELS[status];
  let lineKind: AgentCard["lineKind"] = "status";

  if (status === "calisiyor") {
    /*
     * Çalışırken: son tool ÇAĞRISININ özeti — sonucu ASLA.
     *
     * Tool sonucu ham çıktıdır (bir `npm test` çıktısının ilk satırı,
     * bir dosyanın içeriği). Oda görünümüne ham çıktı girmez.
     */
    const call = lastToolCall(turn);
    if (turn?.outcome.kind === "running" && turn.retry?.active) {
      // Sağlayıcıyı bekliyor: son tool çağrısı değil, NEDEN beklediği.
      line = oneLine(retryLabel(turn.retry));
      lineKind = "status";
    } else if (call) {
      line = oneLine(`${call.tool} · ${formatTool(call.tool, call.input)}`);
      lineKind = "tool";
    }
  } else if (turn && turn.outcome.kind === "failed") {
    const reason = (turn.outcome as { reason?: string }).reason ?? "";
    line = FAIL_REASONS[reason] ?? "başarısız oldu";
    lineKind = "status";
  } else if (turn && turn.outcome.kind === "completed") {
    // Son metnin İLK CÜMLESİ — tamamı değil. Agent bazen on satır yazıyor.
    const texts = turn.items.filter((i) => i.kind === "text");
    const last = texts[texts.length - 1];
    if (last && last.kind === "text" && last.text.trim()) {
      line = oneLine(firstSentence(last.text));
      lineKind = "summary";
    }
  }

  const changedFiles = Object.values(agent.diff?.files ?? {}).filter(
    (f) => (f as { status?: string }).status !== "clean",
  ).length;

  const openComments = (agent.comments ?? []).filter(
    (c) => (c as { status?: string }).status !== "resolved",
  ).length;

  return {
    name,
    status,
    statusLabel: LABELS[status],
    line,
    lineKind,
    queueLength: agent.queue.length,
    driver: agent.driver?.name ?? null,
    openComments,
    changedFiles,
    conflicts: conflicts.length,
    lastActivitySeq: attentionSeq(agent, conflicts),
  };
}

/** Oda görünümünün kart listesi — sıra config'teki sıra değil, ad sırası. */
export function toCards(view: RoomView): AgentCard[] {
  return Object.keys(view.agents)
    .sort()
    .map((name) => toCard(name, view.agents[name]!, view));
}

/**
 * Agent detayı, Özet sekmesi (Adım 14): KAPALI bir turn'ün tek satırı.
 *
 * "kim istedi · ilk satır · sonuç · değişen dosya sayısı · süre" — kim ve
 * sonuç/süre zaten TurnView'da; burada türetilen iki şey var. Tool çıktısı
 * buraya da girmez: özet satırı akışın kapalı hâlidir, terminalin değil.
 */
export interface TurnSummary {
  /** İsteğin ilk dolu satırı, tek satıra indirilmiş. */
  firstLine: string;
  /** Turn boyunca değişen FARKLI dosya sayısı (aynı dosyaya iki yazım = 1). */
  changedFiles: number;
  /** Başarısız sağlayıcı isteği sayısı — her biri kotadan düştü. */
  failedRequests: number;
}

export function summarizeTurn(turn: TurnView): TurnSummary {
  const first = turn.prompt.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  const files = new Set<string>();
  for (const item of turn.items) {
    if (item.kind === "tool") for (const f of item.files) files.add(f);
  }
  return {
    firstLine: oneLine(first),
    changedFiles: files.size,
    failedRequests: turn.retry?.attempt ?? 0,
  };
}
