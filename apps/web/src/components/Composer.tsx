import { useState } from "react";
import { sendMessage, startAgent } from "../lib/api.js";
import type { AgentStatus } from "../model/project.js";

/**
 * Gönderme alanı.
 *
 * Gönderdikten sonra UI ELLE GÜNCELLENMEZ: mesaj `message.received` event'i
 * SSE'den gelince görünür. "Tek gerçek kaynak event log'dur" kuralının UI'daki
 * karşılığı bu — iyimser güncelleme yapsaydık log'da olmayan bir şey gösterirdik.
 *
 * Kuyruk, sürücü, kesme ve aktör etiketi Hafta 5'te. Bu hafta agent meşgulse
 * alan kilitlenir.
 */
export function Composer({
  roomId,
  agent,
  status,
}: {
  roomId: string;
  agent: string;
  status: AgentStatus;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const running = status === "busy";
  const stopped = status === "stopped" || status === "failed";
  const disabled = running || busy;

  const submit = async (): Promise<void> => {
    const body = text.trim();
    if (body.length === 0 || disabled) return;
    setBusy(true);
    setError(null);
    try {
      await sendMessage(roomId, agent, body);
      setText(""); // sadece BAŞARIDA temizle
    } catch (err) {
      const e = err as Error & { status?: number; body?: { status?: string } };
      setError(
        e.status === 409
          ? `Agent meşgul (${e.body?.status ?? "busy"}) — kuyruk Hafta 5'te`
          : e.message,
      );
      // Metin KAYBOLMAZ: kullanıcı yazdığını tekrar yazmak zorunda kalmasın.
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ borderTop: "1px solid var(--rule)", padding: 10, background: "var(--paper)" }}>
      {error && (
        <div style={{ color: "var(--fail)", fontSize: 12, marginBottom: 6 }}>{error}</div>
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={2}
          placeholder={running ? "Agent çalışıyor…" : `${agent} agent'ına görev yaz (Enter gönderir)`}
          disabled={disabled}
          style={{
            flex: 1,
            resize: "vertical",
            font: "inherit",
            padding: 8,
            border: "1px solid var(--rule)",
            borderRadius: 3,
            background: disabled ? "var(--canvas)" : "#fff",
            color: "var(--ink)",
          }}
        />
        {stopped ? (
          <button onClick={() => void startAgent(roomId, agent)}>Başlat</button>
        ) : (
          <button onClick={() => void submit()} disabled={disabled || text.trim().length === 0}>
            Gönder
          </button>
        )}
      </div>
      {running && (
        <div style={{ color: "var(--ink-soft)", fontSize: 12, marginTop: 4 }}>
          Agent çalışıyor — bitmesini bekle.
        </div>
      )}
    </div>
  );
}
