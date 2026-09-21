import { useState } from "react";
import type { CommentView, TurnItem, TurnView } from "@agent-rooms/view";
import { formatTool, stripAnsi } from "../model/format-tool.js";

/**
 * Küratörlü akış — kağıt malzemesi.
 *
 * Birbirinin aynı yuvarlak kartlar yerine: solda ince bir dikey ray, her turn
 * rayda bir blok, tool çağrıları rayın içinde girintili tek satırlar.
 * Kapalı haldeyken çıktı HİÇ render edilmez — 500 event'lik bir turn'de
 * DOM'u şişirir ve UI donar.
 */

const dur = (ms: number): string => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} sn`);

/** Renk tek başına bilgi taşımaz: her durumun yanında bir kelime yazar. */
function Outcome({ turn }: { turn: TurnView }) {
  const o = turn.outcome;
  if (o.kind === "running") {
    return <span style={{ color: "var(--run)" }}>● çalışıyor</span>;
  }
  if (o.kind === "failed") {
    /**
     * SEBEP EKRANDA YAZAR.
     *
     * Hafta 4 dogfood'unda `● bitti · error · 0 ms` görüldü ve nedeni
     * (Gemini kotası 429) yalnızca sunucu logunda kaldı: ekrana bakan kişi
     * ürünün bozuk olduğunu sandı. Hata metni artık event log'da taşınıyor,
     * burada da gösteriliyor — uzunsa kırpılır, tamamı title'da durur.
     * (HTML boşlukları zaten tek boşluğa indirir; ayrı temizlik gerekmez.)
     */
    return (
      <span style={{ color: "var(--fail)" }} title={o.error}>
        ● başarısız · {o.reason}
        {o.error ? ` · ${o.error.slice(0, 160)}` : ""}
      </span>
    );
  }
  const cost = o.costUsd > 0 ? ` · $${o.costUsd.toFixed(4)}` : "";
  // Turn bitti ama BAŞARIYLA bitmedi: "tamamlandı" demek yanıltıcı olur.
  if (o.subtype && o.subtype !== "success") {
    return (
      <span style={{ color: "var(--fail)" }}>
        ● bitti · {o.subtype} · {dur(o.durationMs)}
        {cost}
      </span>
    );
  }
  return (
    <span style={{ color: "var(--ink-soft)" }}>
      ● tamamlandı · {dur(o.durationMs)}
      {cost}
    </span>
  );
}

function ToolRow({
  item,
  onOpenFile,
}: {
  item: Extract<TurnItem, { kind: "tool" }>;
  /** Hafta 6: dosyaya tıklayınca Diff sekmesinde o dosyaya gidilir. */
  onOpenFile?: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const failed = item.result?.isError === true;
  const pending = item.result === null;

  return (
    <div style={{ borderBottom: "1px solid var(--rule)" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          display: "flex",
          gap: 8,
          alignItems: "baseline",
          width: "100%",
          textAlign: "left",
          border: "none",
          background: "transparent",
          padding: "5px 0",
        }}
      >
        <span
          style={{ color: failed ? "var(--fail)" : pending ? "var(--wait)" : "var(--run)", width: 10 }}
        >
          {failed ? "✗" : pending ? "…" : "✓"}
        </span>
        <span className="mono" style={{ fontWeight: 600, minWidth: 130 }}>
          {item.tool}
        </span>
        <span
          className="mono"
          style={{
            color: "var(--ink-soft)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
        >
          {formatTool(item.tool, item.input)}
        </span>
        {item.files.length > 0 && (
          <span style={{ color: "var(--run)", fontSize: 11 }}>
            {item.files.length} dosya
          </span>
        )}
      </button>

      {open && (
        <div style={{ padding: "0 0 8px 18px", fontSize: 12 }}>
          <div style={{ color: "var(--ink-soft)", marginBottom: 2 }}>girdi</div>
          <pre
            className="mono"
            style={{
              margin: 0,
              padding: 6,
              background: "var(--paper)",
              border: "1px solid var(--rule)",
              maxHeight: 220,
              overflow: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {typeof item.input === "string" ? item.input : JSON.stringify(item.input, null, 2)}
          </pre>
          {item.files.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <span style={{ color: "var(--ink-soft)" }}>değişen dosyalar: </span>
              {item.files.map((f, i) => (
                <span key={f}>
                  {i > 0 && ", "}
                  {/* Diff'e geçiş: aynı dosyayı iki sekmede elle aramak
                      "beraber çalışma" iddiasını ilk kıran şey olurdu. */}
                  <button
                    className="mono"
                    onClick={() => onOpenFile?.(f)}
                    disabled={!onOpenFile}
                    style={{
                      border: "none",
                      background: "transparent",
                      padding: 0,
                      color: onOpenFile ? "var(--run)" : "inherit",
                      textDecoration: onOpenFile ? "underline" : "none",
                      cursor: onOpenFile ? "pointer" : "default",
                    }}
                    title={onOpenFile ? "Diff sekmesinde göster" : undefined}
                  >
                    {f}
                  </button>
                </span>
              ))}
            </div>
          )}
          {item.result && (
            <>
              <div style={{ color: "var(--ink-soft)", margin: "6px 0 2px" }}>
                çıktı{item.result.truncated && " · sunucuda 16 KB'a kırpıldı"}
              </div>
              <pre
                className="mono"
                style={{
                  margin: 0,
                  padding: 6,
                  background: "var(--paper)",
                  border: "1px solid var(--rule)",
                  maxHeight: 260,
                  overflow: "auto",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  color: item.result.isError ? "var(--fail)" : undefined,
                }}
              >
                {/* Akış düz metindir: ANSI burada temizlenir, terminalde değil. */}
                {stripAnsi(item.result.output) || "(çıktı yok)"}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Item({ item, onOpenFile }: { item: TurnItem; onOpenFile?: (path: string) => void }) {
  if (item.kind === "text") {
    return (
      <div style={{ padding: "5px 0", borderBottom: "1px solid var(--rule)" }}>{item.text}</div>
    );
  }
  if (item.kind === "denied") {
    return (
      <div
        style={{
          padding: "5px 0",
          borderBottom: "1px solid var(--rule)",
          color: "var(--fail)",
        }}
      >
        ✗ <span className="mono">{item.tool}</span> reddedildi · {item.reason}
      </div>
    );
  }
  return <ToolRow item={item} onOpenFile={onOpenFile} />;
}

export function ActivityFeed({
  turns,
  canWrite = true,
  onOpenFile,
  comments = [],
  onOpenReview,
}: {
  turns: TurnView[];
  canWrite?: boolean;
  onOpenFile?: (path: string) => void;
  /** Hafta 6: inceleme turn'ünün başlığında kaç yorum olduğunu yazmak için. */
  comments?: CommentView[];
  onOpenReview?: (reviewId: string) => void;
}) {
  if (turns.length === 0) {
    return (
      <p style={{ color: "var(--ink-soft)", padding: 16 }}>
        {/* İzleyiciye "aşağıdan bir şey yaz" demek yanlış yönlendirme olurdu:
            yazma alanı onda yok. */}
        {canWrite ? "Henüz görev yok. Aşağıdan bir şey yaz." : "Henüz görev yok."}
      </p>
    );
  }

  return (
    <div style={{ padding: "8px 16px 24px", maxWidth: 900 }}>
      {turns.map((turn) => (
        <section key={turn.messageId} style={{ margin: "0 0 22px" }}>
          <header
            style={{
              display: "flex",
              gap: 10,
              alignItems: "baseline",
              paddingBottom: 6,
              borderBottom: "1px solid var(--ink)",
            }}
          >
            {/*
              İNCELEME TURN'Ü: başlıkta on iki satırlık ham prompt yerine
              "Ayşe'nin 3 yorumluk incelemesi" yazar. Ham metin title'da durur;
              tıklayınca Diff sekmesinde yorumlara gidilir.
            */}
            {turn.reviewId ? (
              <button
                onClick={() => onOpenReview?.(turn.reviewId!)}
                disabled={!onOpenReview}
                title={turn.prompt}
                style={{
                  border: "none",
                  background: "transparent",
                  padding: 0,
                  font: "inherit",
                  fontSize: 15,
                  fontWeight: 700,
                  color: onOpenReview ? "var(--run)" : "inherit",
                  textDecoration: onOpenReview ? "underline" : "none",
                  cursor: onOpenReview ? "pointer" : "default",
                }}
              >
                {turn.actor}'nin{" "}
                {comments.filter((c) => c.reviewId === turn.reviewId).length || "?"} yorumluk
                incelemesi
              </button>
            ) : (
              <strong style={{ fontSize: 15 }}>{turn.prompt}</strong>
            )}
            <span style={{ color: "var(--ink-soft)", fontSize: 12 }}>{turn.actor}</span>
            <span style={{ marginLeft: "auto", fontSize: 12 }}>
              <Outcome turn={turn} />
            </span>
          </header>
          {/* Soldaki ince ray: turn'ün içindekiler buraya girintilenir. */}
          <div style={{ borderLeft: "1px solid var(--rule)", paddingLeft: 12, marginLeft: 3 }}>
            {turn.items.map((item) => (
              <Item key={`${item.kind}-${item.seq}`} item={item} onOpenFile={onOpenFile} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
