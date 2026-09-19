import { useEffect, useState } from "react";
import { createInvite, listInvites, revokeInvite, type Invite } from "../lib/api.js";

/**
 * Paylaşım — oda sahibine.
 *
 * Link ÇOK KULLANIMLIKTIR (ekibe tek link atılır), sürelidir ve iptal
 * edilebilir. Token yalnızca oluşturma yanıtında görünür; liste sadece
 * 8 karakterlik öneki gösterir — o önekle giriş yapılamaz.
 */
export function ShareDialog({ roomId, onClose }: { roomId: string; onClose: () => void }) {
  const [invites, setInvites] = useState<Invite[]>([]);
  /** Davet rolü. Varsayılan `member`: kuyruk geldi, ikinci kişi artık yazabilir. */
  const [role, setRole] = useState<"member" | "viewer">("member");
  const [fresh, setFresh] = useState<{ url: string; expiresAt: string; role: string } | null>(
    null,
  );
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = (): void => {
    void listInvites(roomId)
      .then(setInvites)
      .catch((e: Error) => setError(e.message));
  };
  useEffect(load, [roomId]);

  const create = async (): Promise<void> => {
    try {
      const inv = await createInvite(roomId, undefined, role);
      setFresh({ url: inv.url, expiresAt: inv.expiresAt, role: inv.role });
      setCopied(false);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const copy = async (): Promise<void> => {
    if (!fresh) return;
    try {
      await navigator.clipboard.writeText(fresh.url);
      setCopied(true);
    } catch {
      setError("Kopyalanamadı — bağlantıyı elle seçip kopyala.");
    }
  };

  return (
    <div
      role="dialog"
      aria-label="Odayı paylaş"
      style={{
        position: "absolute",
        right: 14,
        top: 46,
        width: 420,
        background: "var(--paper)",
        border: "1px solid var(--ink)",
        padding: 12,
        zIndex: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", marginBottom: 8 }}>
        <strong>Odayı paylaş</strong>
        <button onClick={onClose} style={{ marginLeft: "auto" }}>
          Kapat
        </button>
      </div>

      {/* Rol seçimi: iki radyo, iki cümle. Renk tek başına bilgi taşımaz. */}
      <div style={{ fontSize: 12, margin: "0 0 8px" }}>
        {(
          [
            ["member", "Katılımcı", "Agent'lara görev yazabilir, kuyruğa girer, sürücülüğü alabilir."],
            ["viewer", "İzleyici", "Sadece izler. Kuyruğu görür ama yazamaz."],
          ] as const
        ).map(([value, label, hint]) => (
          <label key={value} style={{ display: "block", padding: "2px 0" }}>
            <input
              type="radio"
              name="invite-role"
              checked={role === value}
              onChange={() => setRole(value)}
            />{" "}
            <strong>{label}</strong>{" "}
            <span style={{ color: "var(--ink-soft)" }}>— {hint}</span>
          </label>
        ))}
      </div>

      {fresh ? (
        <div style={{ marginBottom: 10 }}>
          <input
            readOnly
            value={fresh.url}
            onFocus={(e) => e.currentTarget.select()}
            className="mono"
            style={{
              width: "100%",
              font: "inherit",
              fontSize: 12,
              padding: 6,
              border: "1px solid var(--rule)",
              background: "#fff",
              color: "var(--ink)",
            }}
          />
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
            <button onClick={() => void copy()}>{copied ? "Kopyalandı" : "Kopyala"}</button>
            <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>
              {fresh.role === "viewer" ? "izleyici" : "katılımcı"} ·{" "}
              {new Date(fresh.expiresAt).toLocaleString("tr-TR")} tarihine kadar geçerli
            </span>
          </div>
        </div>
      ) : (
        <button onClick={() => void create()}>Paylaşım linki oluştur</button>
      )}

      {invites.length > 0 && (
        <div style={{ marginTop: 12, borderTop: "1px solid var(--rule)", paddingTop: 8 }}>
          <div style={{ fontSize: 12, color: "var(--ink-soft)", marginBottom: 4 }}>
            Oluşturulmuş linkler
          </div>
          {invites.map((inv) => (
            <div
              key={inv.prefix}
              style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 12, padding: "3px 0" }}
            >
              <span className="mono">{inv.prefix}…</span>
              <span style={{ color: "var(--ink-soft)" }}>
                {inv.role === "viewer" ? "izleyici" : "katılımcı"}
              </span>
              <span style={{ color: inv.active ? "var(--run)" : "var(--idle)" }}>
                {inv.revokedAt ? "iptal edildi" : inv.active ? "aktif" : "süresi doldu"}
              </span>
              <span style={{ color: "var(--ink-soft)" }}>
                {new Date(inv.expiresAt).toLocaleString("tr-TR")}
              </span>
              {inv.active && (
                <button
                  style={{ marginLeft: "auto" }}
                  onClick={() => {
                    void revokeInvite(roomId, inv.prefix).then(load);
                  }}
                >
                  İptal et
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {error && <p style={{ color: "var(--fail)", fontSize: 12 }}>{error}</p>}
    </div>
  );
}
