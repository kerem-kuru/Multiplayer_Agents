import type { Draft } from "../lib/drafts.js";

/**
 * İnceleme tepsisi — en az bir taslak varsa ekranın altında sabit çubuk.
 *
 * Beş satıra yorum yazan biri beş turn beklemez: "Yorumları gönder (n)" hepsini
 * TEK inceleme olarak yollar. Hafta 5'in "mesajlar birleştirilmez" kuralı
 * bozulmuyor — birleştirilen şey aynı kişinin aynı incelemesi.
 */
export function ReviewTray({
  drafts,
  staleCount,
  position,
  busy,
  error,
  onSubmit,
  onClear,
}: {
  drafts: Draft[];
  /** Çapası tutmayan taslak sayısı — gönderimi engeller. */
  staleCount: number;
  /** Gönderildikten sonra kuyruktaki yer. */
  position: number | null;
  busy: boolean;
  error: string | null;
  onSubmit: () => void;
  onClear: () => void;
}) {
  // Boş tepsi HİÇ görünmez: boş bir çubuk "bozuk mu?" sorusu doğurur.
  if (drafts.length === 0 && position === null && error === null) return null;

  return (
    <div
      style={{
        position: "sticky",
        bottom: 0,
        display: "flex",
        gap: 10,
        alignItems: "center",
        flexWrap: "wrap",
        padding: "8px 12px",
        borderTop: "1px solid var(--ink)",
        background: "var(--paper)",
      }}
    >
      {drafts.length > 0 && (
        <>
          <strong>{drafts.length} taslak yorum</strong>
          <span style={{ color: "var(--ink-soft)", fontSize: 12 }}>
            yalnızca sende duruyor · gönderilince tek bir turn olur
          </span>
          {staleCount > 0 && (
            <span style={{ color: "var(--wait)", fontSize: 12 }}>
              ⚠ {staleCount} taslağın satırı değişti — göndermeden önce düzelt
            </span>
          )}
          <span style={{ marginLeft: "auto" }} />
          <button onClick={onClear} disabled={busy}>
            Taslakları temizle
          </button>
          <button onClick={onSubmit} disabled={busy || staleCount > 0}>
            Yorumları gönder ({drafts.length})
          </button>
        </>
      )}

      {/* Kuyruk konumu Hafta 5'teki gibi: istemci "sıram geldi mi" diye kendi
          karar vermiyor, sunucunun bildirdiği sayıyı gösteriyor. */}
      {position !== null && drafts.length === 0 && (
        <span style={{ color: "var(--ink-soft)" }}>
          İnceleme gönderildi · kuyrukta {position}. sırada
        </span>
      )}
      {error && <span style={{ color: "var(--fail)" }}>{error}</span>}
    </div>
  );
}
