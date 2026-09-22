import type { AgentCard as Card } from "@agent-rooms/view";

/**
 * Hafta 7, Adım 14 — agent kartı.
 *
 * Kartlar birbirinin aynı gri kutular değil: durum SOL KENARDAKİ ince bir
 * şeritle ve yanında YAZILI kelimeyle gösteriliyor. Renk tek başına bilgi
 * taşımaz (Hafta 3 kuralı) — şeridi görmeyen de kelimeyi okur.
 *
 * Kartta ham çıktı yok; `card.line` zaten `toCard` tarafından süzülüyor.
 */

const STRIPE: Record<Card["status"], string> = {
  calisiyor: "var(--ok, #2f6f4f)",
  sirada: "var(--warn, #8a6d1f)",
  bosta: "var(--rule)",
  durdu: "var(--rule)",
  coktu: "var(--bad, #a33)",
  basarisiz: "var(--bad, #a33)",
};

/** Bakan kişilerin baş harfleri — en fazla 3, sonrası "+N". */
function Watchers({ names }: { names: string[] }) {
  if (names.length === 0) return null;
  const shown = names.slice(0, 3);
  const rest = names.length - shown.length;
  return (
    <span
      style={{ fontSize: 11, color: "var(--ink-soft)", display: "flex", gap: 3 }}
      title={`şu an bakanlar: ${names.join(", ")}`}
    >
      {shown.map((n) => (
        <span
          key={n}
          aria-hidden="true"
          style={{
            border: "1px solid var(--rule)",
            borderRadius: "50%",
            width: 18,
            height: 18,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {n.slice(0, 1).toLocaleUpperCase("tr")}
        </span>
      ))}
      {rest > 0 && <span aria-hidden="true">+{rest}</span>}
      <span className="sr-only">şu an bakanlar: {names.join(", ")}</span>
    </span>
  );
}

export function AgentCard({
  card,
  unread,
  watchers,
  onOpen,
}: {
  card: Card;
  unread: boolean;
  watchers: string[];
  onOpen: () => void;
}) {
  /** Alt satır: yalnızca SIFIR OLMAYANLAR. Hepsini basmak gürültü olurdu. */
  const counts = [
    card.queueLength > 0 ? `${card.queueLength} sırada` : null,
    card.changedFiles > 0 ? `${card.changedFiles} dosya` : null,
    card.openComments > 0 ? `${card.openComments} açık yorum` : null,
    card.conflicts > 0 ? `${card.conflicts} çakışma` : null,
  ].filter(Boolean) as string[];

  return (
    // Tüm kart TEK tıklanabilir hedef, klavyeyle odaklanabilir, Enter ile açılır.
    <button
      onClick={onOpen}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "10px 12px 10px 14px",
        border: "1px solid var(--rule)",
        borderLeft: `4px solid ${STRIPE[card.status]}`,
        background: "var(--paper)",
        cursor: "pointer",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <strong>{card.name}</strong>
        {unread && (
          <>
            <span
              aria-hidden="true"
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: "var(--ink)",
                display: "inline-block",
              }}
            />
            {/* Ekran okuyucu noktayı görmez. */}
            <span className="sr-only">yeni etkinlik</span>
          </>
        )}
        <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>{card.statusLabel}</span>
        {card.driver && (
          <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>· sürücü {card.driver}</span>
        )}
        <span style={{ marginLeft: "auto" }}>
          <Watchers names={watchers} />
        </span>
      </div>

      <div
        className={card.lineKind === "tool" ? "mono" : undefined}
        style={{
          marginTop: 6,
          fontSize: 13,
          color: card.lineKind === "status" ? "var(--ink-soft)" : "var(--ink)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {card.line}
      </div>

      {counts.length > 0 && (
        <div style={{ marginTop: 6, fontSize: 12, color: "var(--ink-soft)" }}>
          {counts.join(" · ")}
        </div>
      )}
    </button>
  );
}
