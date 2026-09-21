import type { CommentView } from "@agent-rooms/view";
import type { Draft } from "../lib/drafts.js";

/**
 * Satır yorumu — yazma kutusu ve yayımlanmış yorum satırı.
 *
 * İki kural burada görünür:
 *
 * 1. **Yazılmış metin ASLA silinmez.** Agent sen yazarken o satırı
 *    değiştirirse kutu kaybolmaz; üstünde uyarı çıkar ve gönderme yolu
 *    kapanır. Kaybolan bir kutu, kaybolan bir cümledir.
 * 2. **Çözme insan kararıdır.** Agent cevabında "uyguladım" diyebilir;
 *    kapatma düğmesi burada, insanda.
 */

const box: React.CSSProperties = {
  border: "1px solid var(--rule)",
  background: "var(--paper)",
  borderRadius: 3,
  padding: 8,
  margin: "4px 0 4px 28px",
  maxWidth: 720,
};

/**
 * KONTROLLÜ bileşen: yazılan metin üst katmanda durur.
 *
 * İçeride `useState` ile tutulsaydı, canlı bir `diff.updated` satırları
 * kaydırdığında React bu bileşeni söküp yeniden kurabilir ve yazılmış cümle
 * uçardı. "Yazılmış metin asla silinmez" kuralı bir davranış değil, bir
 * yerleşim kararı.
 */
export function CommentComposer({
  stale,
  body,
  onBodyChange,
  onDraft,
  onSendNow,
  onCancel,
  busy,
}: {
  /** Bu satırın metni sen yazarken DEĞİŞTİ. */
  stale: boolean;
  body: string;
  onBodyChange: (body: string) => void;
  onDraft: (body: string) => void;
  onSendNow: (body: string) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const empty = body.trim().length === 0;

  return (
    <div style={box}>
      {stale && (
        <div style={{ color: "var(--wait)", fontSize: 12, marginBottom: 6 }}>
          ⚠ Bu satır sen yazarken değişti. Yazdığın metin duruyor — göndermeden önce yorumu
          yeni satıra taşı (kutuyu kapat ve güncel satırda yeniden aç).
        </div>
      )}
      <textarea
        autoFocus
        value={body}
        onChange={(e) => onBodyChange(e.target.value)}
        rows={3}
        placeholder="bunu böl"
        style={{
          width: "100%",
          font: "inherit",
          fontFamily: "var(--sans)",
          padding: 6,
          border: "1px solid var(--rule)",
          borderRadius: 3,
          resize: "vertical",
        }}
      />
      <div style={{ display: "flex", gap: 6, marginTop: 6, alignItems: "center" }}>
        <button disabled={empty || busy || stale} onClick={() => onDraft(body)}>
          Taslağa ekle
        </button>
        {/* Hemen gönder = TEK YORUMLU inceleme. Ayrı bir yol değil, aynı yol. */}
        <button disabled={empty || busy || stale} onClick={() => onSendNow(body)}>
          Hemen gönder
        </button>
        <button onClick={onCancel}>Vazgeç</button>
        <span style={{ marginLeft: "auto", color: "var(--ink-soft)", fontSize: 11 }}>
          Taslaklar yalnızca sende durur
        </span>
      </div>
    </div>
  );
}

export function DraftRow({
  draft,
  stale,
  onRemove,
}: {
  draft: Draft;
  /** Taslağın çapası artık tutmuyor: satır metni değişti. */
  stale: boolean;
  onRemove: () => void;
}) {
  return (
    <div style={{ ...box, borderStyle: "dashed", borderColor: stale ? "var(--wait)" : "var(--rule)" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
        <strong style={{ fontSize: 12 }}>taslak</strong>
        <span style={{ flex: 1, whiteSpace: "pre-wrap" }}>{draft.body}</span>
        <button onClick={onRemove}>Sil</button>
      </div>
      {stale && (
        <div style={{ color: "var(--wait)", fontSize: 11, marginTop: 4 }}>
          ⚠ Bu satır sen yazdıktan sonra değişti — gönderilmeden önce silinmeli veya
          güncel satırda yeniden yazılmalı.
        </div>
      )}
    </div>
  );
}

/**
 * Yayımlanmış yorum.
 *
 * `moved` etiketi ÖNEMLİ: yorum yeni satırın altında görünüyor ama yazıldığı
 * satır o değildi. Etiketsiz göstermek, kullanıcıya "bu yorum hep buradaydı"
 * yalanını söylemek olurdu.
 */
export function PublishedComment({
  comment,
  canResolve,
  onToggle,
  busy,
  showAnchor,
}: {
  comment: CommentView;
  canResolve: boolean;
  onToggle: (resolved: boolean) => void;
  busy: boolean;
  /** Eskimiş bölümünde alıntılanan satırı da göster. */
  showAnchor: boolean;
}) {
  return (
    <div
      style={{
        ...box,
        opacity: comment.resolved ? 0.6 : 1,
        borderColor: comment.resolved ? "var(--rule)" : "var(--ink-soft)",
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <strong>{comment.author.name}</strong>
        <span style={{ color: "var(--ink-soft)", fontSize: 11 }}>
          {new Date(comment.at).toLocaleTimeString("tr-TR")}
        </span>
        {comment.anchor === "moved" && (
          <span style={{ color: "var(--wait)", fontSize: 11 }}>
            satır yer değiştirdi · yazıldığında {comment.line}. satırdı
          </span>
        )}
        {comment.anchor === "outdated" && (
          <span style={{ color: "var(--wait)", fontSize: 11 }}>eskimiş</span>
        )}
        {comment.resolved && (
          <span style={{ color: "var(--run)", fontSize: 11 }}>✓ çözüldü</span>
        )}
      </div>

      {showAnchor && (
        <div
          className="mono"
          style={{
            color: "var(--ink-soft)",
            fontSize: 12,
            margin: "4px 0",
            borderLeft: "2px solid var(--rule)",
            paddingLeft: 6,
            whiteSpace: "pre",
            overflowX: "auto",
          }}
        >
          {comment.path}:{comment.line}
          {comment.side === "old" ? " (silinen satır)" : ""} · {comment.lineText}
        </div>
      )}

      <div style={{ whiteSpace: "pre-wrap", marginTop: 4 }}>{comment.body}</div>

      {canResolve && (
        <div style={{ marginTop: 6 }}>
          <button disabled={busy} onClick={() => onToggle(!comment.resolved)}>
            {comment.resolved ? "Yeniden aç" : "Çöz"}
          </button>
        </div>
      )}
    </div>
  );
}
