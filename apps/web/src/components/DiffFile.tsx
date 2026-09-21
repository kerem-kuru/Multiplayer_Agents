import { useEffect, useRef, useState } from "react";
import type { CommentSide, FileDiff } from "@agent-rooms/protocol";
import type { CommentView } from "@agent-rooms/view";
import { parsePatch, type PatchLine } from "@agent-rooms/view";
import type { Draft } from "../lib/drafts.js";
import { CommentComposer, DraftRow, PublishedComment } from "./LineComment.js";

/**
 * Tek dosyanın diff'i — katlanabilir blok.
 *
 * KATLANMIŞ DOSYANIN PATCH'İ DOM'A BASILMAZ (Hafta 3 kuralı). 40 dosyalık bir
 * diff'te hepsini birden çizmek UI'ı dondurur; kapalı blok yalnızca başlık.
 *
 * Renk TEK BAŞINA bilgi taşımaz: ekleme/silme zemininin yanında işaret
 * sütununda `+` / `−` karakteri de var.
 */

const STATUS_LABEL: Record<string, string> = {
  added: "Eklendi",
  modified: "Değişti",
  deleted: "Silindi",
  renamed: "Yeniden adlandırıldı",
  binary: "İkili",
  clean: "Temiz",
};

const LINE_BG: Record<PatchLine["kind"], string> = {
  add: "rgba(47, 111, 106, 0.10)",
  del: "rgba(163, 46, 46, 0.10)",
  context: "transparent",
};

const MARK: Record<PatchLine["kind"], string> = { add: "+", del: "−", context: " " };

const num: React.CSSProperties = {
  width: 44,
  textAlign: "right",
  paddingRight: 8,
  color: "var(--ink-soft)",
  userSelect: "none",
  flex: "0 0 auto",
};

/** Açık yorum kutusu — durumu DiffView tutuyor (metin sökülmede kaybolmasın). */
export interface Composing {
  path: string;
  side: CommentSide;
  line: number;
  /** Kutu AÇILDIĞI ANDAKİ satır metni — eskime bununla ölçülüyor. */
  lineText: string;
  body: string;
}

export interface DiffFileProps {
  file: FileDiff;
  /** Bu dosyaya ait yayımlanmış yorumlar. */
  comments: CommentView[];
  drafts: Draft[];
  canComment: boolean;
  canResolve: boolean;
  /** Son yayımdan sonra değişti mi — başlık kısa süre vurgulanır. */
  highlighted: boolean;
  /** Yorum kutusunun bağlanacağı `diff.updated` seq'i. */
  diffSeq: number;
  /** Bu dosyada açık kutu varsa. */
  composing: Composing | null;
  onCompose: (c: Composing | null) => void;
  onComposeBody: (body: string) => void;
  /** Taslağın çapası hâlâ tutuyor mu — DiffView güncel patch'e bakarak hesaplıyor. */
  isDraftStale: (d: Draft) => boolean;
  onAddDraft: (d: Omit<Draft, "id">) => void;
  onSendNow: (d: Omit<Draft, "id">) => void;
  onRemoveDraft: (id: string) => void;
  onToggleResolved: (commentId: string, resolved: boolean) => void;
  busy: boolean;
}

export function DiffFile({
  file,
  comments,
  drafts,
  canComment,
  canResolve,
  highlighted,
  diffSeq,
  composing,
  onCompose,
  onComposeBody,
  isDraftStale,
  onAddDraft,
  onSendNow,
  onRemoveDraft,
  onToggleResolved,
  busy,
}: DiffFileProps) {
  const [open, setOpen] = useState(!file.collapsedByDefault);
  const ref = useRef<HTMLDivElement | null>(null);

  // Kapalı başlayan bir dosyaya "o dosyaya git" ile gelindiğinde açılmalı.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onOpenRequest = (): void => setOpen(true);
    el.addEventListener("rooms:open-file", onOpenRequest);
    return () => el.removeEventListener("rooms:open-file", onOpenRequest);
  }, []);

  const lines = open ? parsePatch(file.patch) : [];
  const openComments = comments.filter((c) => !c.resolved);
  /** Çapası tutmayan yorumlar satırların arasında değil, dosyanın altında. */
  const outdated = comments.filter((c) => c.anchor === "outdated");
  const anchored = comments.filter((c) => c.anchor !== "outdated");

  const lineKey = (side: CommentSide, line: number): string => `${side}:${line}`;

  /** Bu satırda görünmesi gereken yayımlanmış yorumlar. `moved` ise YENİ satırda. */
  const commentsAt = (side: CommentSide, line: number): CommentView[] =>
    anchored.filter(
      (c) => c.side === side && (c.anchor === "moved" ? c.currentLine : c.line) === line,
    );

  const draftsAt = (side: CommentSide, line: number): Draft[] =>
    drafts.filter((d) => d.side === side && d.line === line);

  /** Açık kutu bu dosyaya ait ama denk geldiği satır diff'ten düşmüş mü. */
  const orphanComposer =
    open &&
    composing !== null &&
    composing.path === file.path &&
    !lines.some(
      (l) =>
        (l.kind === "del" ? "old" : "new") === composing.side &&
        (l.kind === "del" ? l.oldLine : l.newLine) === composing.line,
    );

  return (
    <div
      ref={ref}
      data-diff-file={file.path}
      style={{
        border: "1px solid var(--rule)",
        borderRadius: 3,
        marginBottom: 10,
        background: "var(--paper)",
        overflow: "hidden",
      }}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          display: "flex",
          gap: 10,
          alignItems: "baseline",
          width: "100%",
          textAlign: "left",
          border: "none",
          borderRadius: 0,
          background: highlighted ? "rgba(176, 106, 0, 0.12)" : "transparent",
          padding: "6px 10px",
          borderBottom: open ? "1px solid var(--rule)" : "none",
          // `prefers-reduced-motion` açıkken geçiş tokens.css'te zaten kapalı.
          transition: "background 600ms ease-out",
        }}
      >
        <span style={{ width: 10, color: "var(--ink-soft)" }}>{open ? "▾" : "▸"}</span>
        <span className="mono" style={{ fontWeight: 600 }}>
          {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        <span style={{ color: "var(--ink-soft)", fontSize: 12 }}>
          {STATUS_LABEL[file.status] ?? file.status}
        </span>
        <span className="mono" style={{ fontSize: 12 }}>
          <span style={{ color: "var(--run)" }}>+{file.additions}</span>{" "}
          <span style={{ color: "var(--fail)" }}>−{file.deletions}</span>
        </span>
        {openComments.length > 0 && (
          <span style={{ color: "var(--ink-soft)", fontSize: 12 }}>
            💬 {openComments.length} açık yorum
          </span>
        )}
        {file.collapsedByDefault && !open && (
          <span style={{ color: "var(--ink-soft)", fontSize: 11 }}>
            üretilmiş dosya — kapalı başladı
          </span>
        )}
      </button>

      {open && file.status === "binary" && (
        <div style={{ padding: 10, color: "var(--ink-soft)" }}>
          İkili dosya — satır bazlı diff yok, yorum bırakılamaz.
        </div>
      )}

      {open && file.patch !== null && (
        <div className="mono" style={{ fontSize: 12, overflowX: "auto" }}>
          {lines.map((l, i) => {
            const side: CommentSide = l.kind === "del" ? "old" : "new";
            const lineNo = side === "old" ? l.oldLine : l.newLine;
            const key = lineNo === null ? null : lineKey(side, lineNo);
            /** Açık kutu TAM BU satırda mı. */
            const here =
              composing !== null &&
              composing.path === file.path &&
              composing.side === side &&
              composing.line === lineNo;
            return (
              <div key={i}>
                <div
                  style={{
                    display: "flex",
                    background: LINE_BG[l.kind],
                    alignItems: "baseline",
                    minHeight: 18,
                  }}
                >
                  <span style={num}>{l.oldLine ?? ""}</span>
                  <span style={num}>{l.newLine ?? ""}</span>
                  {/* İşaret sütunu: renk tek başına bilgi taşımasın. */}
                  <span style={{ width: 14, color: "var(--ink-soft)", flex: "0 0 auto" }}>
                    {MARK[l.kind]}
                  </span>
                  {canComment && key !== null && (
                    <button
                      aria-label={`${lineNo}. satıra yorum ekle`}
                      title="Bu satıra yorum bırak"
                      onClick={() =>
                        onCompose(
                          here
                            ? null
                            : { path: file.path, side, line: lineNo!, lineText: l.text, body: "" },
                        )
                      }
                      style={{
                        border: "none",
                        background: "transparent",
                        padding: "0 4px",
                        color: here ? "var(--ink)" : "var(--ink-soft)",
                        flex: "0 0 auto",
                      }}
                    >
                      +
                    </button>
                  )}
                  <span style={{ whiteSpace: "pre", paddingRight: 10 }}>{l.text}</span>
                </div>

                {key !== null &&
                  draftsAt(side, lineNo!).map((d) => (
                    <DraftRow
                      key={d.id}
                      draft={d}
                      stale={isDraftStale(d)}
                      onRemove={() => onRemoveDraft(d.id)}
                    />
                  ))}

                {key !== null &&
                  commentsAt(side, lineNo!).map((c) => (
                    <PublishedComment
                      key={c.commentId}
                      comment={c}
                      canResolve={canResolve}
                      busy={busy}
                      showAnchor={false}
                      onToggle={(r) => onToggleResolved(c.commentId, r)}
                    />
                  ))}

                {here && (
                  <CommentComposer
                    busy={busy}
                    body={composing!.body}
                    onBodyChange={onComposeBody}
                    /**
                     * Satır metni sen yazarken DEĞİŞTİ: kutu kalır, metin
                     * kalır, gönderme kapanır. Sunucu zaten reddederdi
                     * (çapa doğrulaması); burada sebep GÖRÜNÜR oluyor.
                     */
                    stale={composing!.lineText !== l.text}
                    onCancel={() => onCompose(null)}
                    onDraft={(body) => {
                      onAddDraft({ path: file.path, side, line: lineNo!, lineText: l.text, body, diffSeq });
                      onCompose(null);
                    }}
                    onSendNow={(body) => {
                      onSendNow({ path: file.path, side, line: lineNo!, lineText: l.text, body, diffSeq });
                      onCompose(null);
                    }}
                  />
                )}
              </div>
            );
          })}

          {/*
            KUTU ARTIK HİÇBİR SATIRA DENK GELMİYOR: agent yazarken o satırı
            tamamen kaldırdı. Kutuyu düşürmek yazılmış cümleyi silmek olurdu;
            dosyanın altında, uyarıyla duruyor.
          */}
          {orphanComposer && (
            <div style={{ padding: "4px 0" }}>
              <div style={{ color: "var(--wait)", fontSize: 12, padding: "0 10px" }}>
                {composing!.line}. satır artık diff'te yok — yazdığın metin aşağıda duruyor.
              </div>
              <CommentComposer
                busy={busy}
                stale
                body={composing!.body}
                onBodyChange={onComposeBody}
                onCancel={() => onCompose(null)}
                onDraft={() => undefined}
                onSendNow={() => undefined}
              />
            </div>
          )}

          {file.truncated && (
            <div style={{ padding: "6px 10px", color: "var(--wait)" }}>
              Bu dosyanın diff'i 32 KB'da kırpıldı.
            </div>
          )}
        </div>
      )}

      {open && outdated.length > 0 && (
        <div style={{ borderTop: "1px solid var(--rule)", padding: "6px 10px" }}>
          <div style={{ color: "var(--ink-soft)", fontSize: 12, marginBottom: 4 }}>
            Eskimiş yorumlar — yazıldıkları satır değişti
          </div>
          {outdated.map((c) => (
            <PublishedComment
              key={c.commentId}
              comment={c}
              canResolve={canResolve}
              busy={busy}
              showAnchor
              onToggle={(r) => onToggleResolved(c.commentId, r)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
