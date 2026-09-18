import { useState } from "react";
import { requestLogin } from "../lib/api.js";

/**
 * Giriş — tek alan.
 *
 * Şifre yok: e-postaya bağlantı gider. Geliştirme modunda (AUTH_DEV_MODE)
 * bağlantı ekranda da görünür; üretimde görünmez çünkü sunucu onu yanıta
 * koymaz — bu ayrım sunucuda, burada değil.
 */
export function Login({ next, notice }: { next?: string; notice?: string | null }) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [devLink, setDevLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (!email.includes("@") || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await requestLogin(email.trim(), next);
      setSent(true);
      setDevLink(res.devLink ?? null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 420, margin: "80px auto", padding: "0 16px" }}>
      <h1 style={{ fontSize: 20, margin: "0 0 4px" }}>Agent Odaları</h1>
      <p style={{ color: "var(--ink-soft)", margin: "0 0 20px" }}>
        E-postanı yaz, giriş bağlantısı gönderelim.
      </p>

      {sent ? (
        <div>
          <p>
            <strong>{email}</strong> adresine bir bağlantı gönderdik. Bağlantı 15 dakika
            geçerli ve bir kez kullanılabilir.
          </p>
          {devLink && (
            <p style={{ fontSize: 12, color: "var(--ink-soft)" }}>
              Geliştirme modu — bağlantı: <a href={devLink}>{devLink}</a>
            </p>
          )}
          <button onClick={() => setSent(false)}>Başka bir adres dene</button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8 }}>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
            placeholder="sen@ornek.com"
            autoFocus
            style={{
              flex: 1,
              font: "inherit",
              padding: 8,
              border: "1px solid var(--rule)",
              borderRadius: 3,
              background: "#fff",
              color: "var(--ink)",
            }}
          />
          <button onClick={() => void submit()} disabled={busy || !email.includes("@")}>
            {busy ? "Gönderiliyor…" : "Bağlantı gönder"}
          </button>
        </div>
      )}

      {(error || notice) && (
        <p style={{ color: "var(--fail)", fontSize: 13 }}>{error ?? notice}</p>
      )}
    </div>
  );
}
