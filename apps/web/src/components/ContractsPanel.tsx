import { useEffect, useState } from "react";
import type { ContractView } from "@agent-rooms/view";
import { fetchContract } from "../lib/api.js";

/**
 * Oda defteri: `contracts/` altındaki dosyalar.
 *
 * Projenin tezi "agent'lar birbirine mesaj atmaz, ortak deftere yazar";
 * defteri insanların göremediği bir oda bu tezi ölçemez. Dogfood'un ilk
 * sorusu da tam bu: sözleşme gerçekten kullanıldı mı, alanlar tuttu mu?
 *
 * Liste event log'dan (`view.contracts`: yol, boyut, son yazan, zaman).
 * İçerik event log'da YOK — tıklanınca `GET /rooms/:id/contracts/*`'tan,
 * redaction'dan geçmiş hâliyle çekiliyor. Oda görünümünde ham çıktı yok
 * kuralı (kontrol 17) bu yüzden bozulmuyor: varsayılan hâl kapalı, içerik
 * ancak açıkça istenince geliyor. Sözleşme de ham tool çıktısı değil,
 * agent'ların bilerek paylaştığı belge.
 *
 * Açık bir dosyanın sha256'sı değişince içerik yeniden çekiliyor: bakarken
 * backend ucu değiştirirse eski metni göstermek bu panelin en kötü hatası olurdu.
 */
export function ContractsPanel({
  roomId,
  contracts,
}: {
  roomId: string;
  contracts: Record<string, ContractView>;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const paths = Object.keys(contracts).sort();
  const live = paths.filter((p) => !contracts[p]!.deleted).length;

  return (
    <section
      aria-label="Sözleşmeler"
      style={{
        borderBottom: "1px solid var(--rule)",
        background: "var(--paper)",
        padding: "6px 12px",
        fontSize: 13,
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
        <strong>Sözleşmeler</strong>
        <span style={{ color: "var(--ink-soft)", fontSize: 12 }}>
          {paths.length === 0
            ? "contracts/ boş — agent'lar henüz ortak deftere bir şey yazmadı"
            : `${live} dosya · agent'ların ortak defteri (contracts/)`}
        </span>
      </div>

      {paths.length > 0 && (
        <ul style={{ listStyle: "none", margin: "4px 0 0", padding: 0 }}>
          {paths.map((p) => {
            const c = contracts[p]!;
            const isOpen = open === p;
            return (
              <li key={p} style={{ marginTop: 2 }}>
                <button
                  aria-expanded={isOpen}
                  disabled={c.deleted}
                  onClick={() => setOpen(isOpen ? null : p)}
                  style={{
                    border: "none",
                    background: "transparent",
                    padding: "2px 0",
                    display: "flex",
                    gap: 8,
                    width: "100%",
                    textAlign: "left",
                  }}
                >
                  <span aria-hidden="true">{c.deleted ? "·" : isOpen ? "▾" : "▸"}</span>
                  <span
                    className="mono"
                    style={{ textDecoration: c.deleted ? "line-through" : undefined }}
                  >
                    {p}
                  </span>
                  <span style={{ color: "var(--ink-soft)" }}>
                    {c.deleted ? "silindi" : formatSize(c.size)} · {c.lastAgent} ·{" "}
                    {formatTime(c.at)}
                  </span>
                </button>
                {isOpen && !c.deleted && (
                  <ContractBody roomId={roomId} path={p} sha256={c.sha256} />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ContractBody({ roomId, path, sha256 }: { roomId: string; path: string; sha256: string }) {
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "ok"; content: string } | { kind: "error"; message: string }
  >({ kind: "loading" });

  useEffect(() => {
    let alive = true;
    setState((s) => (s.kind === "ok" ? s : { kind: "loading" }));
    fetchContract(roomId, path)
      .then((r) => alive && setState({ kind: "ok", content: r.content }))
      .catch((e: Error & { status?: number }) => {
        if (!alive) return;
        // Sebep ekranda yazar (Hafta 4 dersi): "yüklenemedi" değil, NEDEN.
        const message =
          e.status === 409
            ? "Oda çalışmıyor — içerik ancak oda ayaktayken okunabiliyor."
            : e.status === 404
              ? "Dosya artık yok (silinmiş ya da taşınmış olabilir)."
              : e.message;
        setState({ kind: "error", message });
      });
    return () => {
      alive = false;
    };
  }, [roomId, path, sha256]);

  if (state.kind === "loading") {
    return <div style={{ color: "var(--ink-soft)", padding: "4px 18px" }}>yükleniyor…</div>;
  }
  if (state.kind === "error") {
    return <div style={{ color: "var(--fail)", padding: "4px 18px" }}>{state.message}</div>;
  }
  return (
    <pre
      className="mono"
      style={{
        margin: "4px 0 6px 18px",
        padding: 8,
        maxHeight: 320,
        overflow: "auto",
        background: "#fff",
        border: "1px solid var(--rule)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        fontSize: 12,
      }}
    >
      {state.content === "" ? "(boş dosya)" : state.content}
    </pre>
  );
}

function formatSize(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
}
