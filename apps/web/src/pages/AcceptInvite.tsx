import { useEffect, useState } from "react";
import { acceptInvite } from "../lib/api.js";

/**
 * Davet kabulü — `/join?token=...`.
 *
 * Oturum yoksa sunucu 401 döner; kullanıcı giriş sayfasına `next` ile
 * yollanır ve girişten sonra buraya geri döner. Süresi dolmuş veya iptal
 * edilmiş bağlantıda NE OLDUĞU ve NE YAPILACAĞI yazar.
 */
export function AcceptInvite({
  token,
  onJoined,
  onNeedLogin,
}: {
  token: string;
  onJoined: (roomId: string) => void;
  onNeedLogin: () => void;
}) {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void acceptInvite(token)
      .then((r) => {
        if (!cancelled) onJoined(r.roomId);
      })
      .catch((err: Error & { status?: number }) => {
        if (cancelled) return;
        if (err.status === 401) {
          onNeedLogin();
          return;
        }
        setError(
          err.status === 400
            ? "Bu davet bağlantısının süresi dolmuş veya iptal edilmiş. Oda sahibinden yeni bir bağlantı iste."
            : err.message,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <div style={{ maxWidth: 460, margin: "80px auto", padding: "0 16px" }}>
      {error ? (
        <>
          <h1 style={{ fontSize: 18, margin: "0 0 8px" }}>Odaya girilemedi</h1>
          <p style={{ color: "var(--fail)" }}>{error}</p>
        </>
      ) : (
        <p style={{ color: "var(--ink-soft)" }}>Odaya katılıyorsun…</p>
      )}
    </div>
  );
}
