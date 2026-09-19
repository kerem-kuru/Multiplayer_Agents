import { useState } from "react";
import type { AgentView } from "@agent-rooms/view";
import {
  claimDriver,
  fetchDriver,
  handoffDriver,
  interruptAgent,
  releaseDriver,
  type DriverInfo,
} from "../lib/api.js";

/**
 * Sürücü işareti — agent başlığının yanında.
 *
 * Üç durum, üçü de KELİMEYLE yazar (renk tek başına bilgi taşımaz):
 *   sürücü yok       → "Sürücü yok" + "Sürücülüğü al"
 *   sürücü sensin    → "Sürücü: sen" + "Devret"
 *   sürücü başkası   → "Sürücü: Ayşe" (talep akışı YOK; devir sürücüden çıkar)
 *
 * DEVİR İKİ TIK: "Devret" → kişi seç. Üçüncü adım, onay diyaloğu yok.
 *
 * Kesme düğmesi yalnızca SÜRÜCÜYE ve yalnızca koşan bir turn varken görünür.
 * Basınca "kesme istendi" durumu yazar — `interrupt.applied` gelince kaybolur.
 * Uzun bir bash komutunun ortasında anlık durma sözü verilmiyor.
 */
export function DriverBadge({
  roomId,
  agent,
  agentView,
  meId,
  canDrive,
}: {
  roomId: string;
  agent: string;
  agentView: AgentView | undefined;
  meId: string | null;
  /** `member`+ — izleyici sürücü olamaz. */
  canDrive: boolean;
}) {
  const [picking, setPicking] = useState<DriverInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Sürücü ve koşan turn PROJEKSİYONDAN gelir: ayrı bir istekle sorsaydık
   * ekran event log'dan sapardı. Sürüm (iyimser kilit) yalnızca devir anında
   * sunucudan alınır.
   */
  const driver = agentView?.driver ?? null;
  const running = agentView?.running ?? null;
  const interrupt = agentView?.interrupt ?? null;
  const iAmDriver = driver?.id === meId && meId !== null;

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 12 }}>
      {driver ? (
        <span>
          Sürücü: <strong>{iAmDriver ? "sen" : driver.name}</strong>
        </span>
      ) : (
        <span style={{ color: "var(--ink-soft)" }}>Sürücü yok</span>
      )}

      {canDrive && !driver && (
        <button
          disabled={busy}
          onClick={() => void run(() => claimDriver(roomId, agent))}
        >
          Sürücülüğü al
        </button>
      )}

      {canDrive && iAmDriver && (
        <>
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                // Devir listesi ve sürüm SUNUCUDAN: kimin devralabileceğine
                // sunucu karar verir (izleyici olamaz).
                setPicking(await fetchDriver(roomId, agent));
              })
            }
          >
            Devret
          </button>
          <button disabled={busy} onClick={() => void run(() => releaseDriver(roomId, agent))}>
            Bırak
          </button>
        </>
      )}

      {/* Kesme: sadece sürücüye ve sadece koşan turn varken. */}
      {iAmDriver && running && !interrupt && (
        <button disabled={busy} onClick={() => void run(() => interruptAgent(roomId, agent))}>
          Kes
        </button>
      )}
      {interrupt && (
        <span style={{ color: "var(--wait)" }}>
          Kesme istendi — agent şu an bir komutu bitiriyor
        </span>
      )}

      {picking && (
        <span
          style={{
            display: "inline-flex",
            gap: 4,
            alignItems: "center",
            border: "1px solid var(--ink)",
            background: "var(--paper)",
            padding: "2px 6px",
          }}
        >
          {picking.candidates.length === 0 ? (
            <span style={{ color: "var(--ink-soft)" }}>Devredilecek katılımcı yok</span>
          ) : (
            picking.candidates.map((cand) => (
              <button
                key={cand.userId}
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await handoffDriver(roomId, agent, cand.userId, picking.version);
                    setPicking(null);
                  })
                }
              >
                {cand.name}
              </button>
            ))
          )}
          <button onClick={() => setPicking(null)}>vazgeç</button>
        </span>
      )}

      {error && <span style={{ color: "var(--fail)" }}>{error}</span>}
    </span>
  );
}
