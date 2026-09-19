import { useState } from "react";
import type { AgentView } from "@agent-rooms/view";
import { cancelQueued } from "../lib/api.js";

/**
 * Kuyruk — Composer'ın üstünde.
 *
 * Sıra SUNUCUDAN gelir: bu liste `message.queued` / `message.received` /
 * `message.cancelled` event'lerinin projeksiyonudur. İstemci "sıram geldi mi"
 * diye kendi karar vermez.
 *
 * Kuyruk boşsa ve koşan mesaj yoksa liste HİÇ görünmez — boş bir kutu
 * "bozuk mu?" sorusu doğurur.
 */
export function QueueList({
  roomId,
  agentView,
  meId,
  canCancelOthers,
}: {
  roomId: string;
  agentView: AgentView | undefined;
  meId: string | null;
  /** Sürücü veya oda sahibi: başkasının kaydını da iptal edebilir. */
  canCancelOthers: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const running = agentView?.running ?? null;
  const queue = agentView?.queue ?? [];
  if (!running && queue.length === 0) return null;

  const cancel = async (messageId: string): Promise<void> => {
    setBusy(messageId);
    setError(null);
    try {
      await cancelQueued(roomId, messageId);
      // Ekran ELLE güncellenmez: `message.cancelled` event'i SSE'den gelince
      // satır kaybolur. Tek gerçek kaynak event log.
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const firstLine = (text: string): string => {
    const line = text.split("\n")[0] ?? "";
    return line.length > 90 ? `${line.slice(0, 90)}…` : line;
  };

  return (
    <div
      style={{
        borderTop: "1px solid var(--rule)",
        background: "var(--paper)",
        padding: "6px 10px 0",
        fontSize: 12,
      }}
    >
      <div style={{ color: "var(--ink-soft)", marginBottom: 4 }}>
        Kuyruk · {queue.length} bekleyen
      </div>

      {error && <div style={{ color: "var(--fail)", marginBottom: 4 }}>{error}</div>}

      {/* Koşan mesaj en üstte ve AYRI işaretli: kelimeyle, renkle değil. */}
      {running && (
        <div style={{ display: "flex", gap: 8, padding: "2px 0", alignItems: "baseline" }}>
          <span style={{ color: "var(--run)" }}>▶ çalışıyor</span>
          <strong>{running.user.name}</strong>
          <span style={{ color: "var(--ink-soft)", flex: 1, minWidth: 0 }}>
            {/* Koşan mesajın metni turn'ün kendisinde; burada sahibi yeter. */}
          </span>
          <span style={{ color: "var(--ink-soft)" }}>iptal edilemez — kesme gerekir</span>
        </div>
      )}

      {queue.map((q, i) => {
        const mine = q.user.id === meId;
        return (
          <div
            key={q.messageId}
            style={{ display: "flex", gap: 8, padding: "2px 0", alignItems: "baseline" }}
          >
            <span style={{ color: "var(--ink-soft)" }}>{i + (running ? 2 : 1)}.</span>
            <strong>{mine ? "sen" : q.user.name}</strong>
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
              {firstLine(q.text)}
            </span>
            <span style={{ color: "var(--ink-soft)" }}>
              {new Date(q.queuedAt).toLocaleTimeString("tr-TR")}
            </span>
            {(mine || canCancelOthers) && (
              <button disabled={busy === q.messageId} onClick={() => void cancel(q.messageId)}>
                İptal
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
