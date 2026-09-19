import { useState } from "react";
import { sendMessage, startAgent } from "../lib/api.js";
import type { AgentStatus, AgentView } from "@agent-rooms/view";

/**
 * Gönderme alanı.
 *
 * Gönderdikten sonra UI ELLE GÜNCELLENMEZ: mesaj `message.queued` event'i
 * SSE'den gelince görünür. "Tek gerçek kaynak event log'dur" kuralının UI'daki
 * karşılığı bu — iyimser güncelleme yapsaydık log'da olmayan bir şey
 * gösterirdik.
 *
 * HAFTA 5: alan artık AGENT MEŞGULKEN DE AÇIK. Mesaj kuyruğa girer ve sırası
 * gelince koşar. Hafta 4'teki "Agent çalışıyor — bitmesini bekle" kilidi
 * kalktı; kilit, ikinci kişinin odaya girip hiçbir şey yapamamasının sebebiydi.
 */
export function Composer({
  roomId,
  agent,
  status,
  agentView,
  meId,
}: {
  roomId: string;
  agent: string;
  status: AgentStatus;
  agentView: AgentView | undefined;
  meId: string | null;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stopped = status === "stopped" || status === "failed";
  const running = agentView?.running ?? null;
  const queue = agentView?.queue ?? [];

  /**
   * Sıradaki yer: koşan mesaj 1'dir, kuyruktakiler onu takip eder. Sunucu da
   * aynı hesabı yapıyor (`position`); burada aynı projeksiyondan okunuyor ki
   * ekran ile yanıt birbirini tutsun.
   */
  const myNextPosition = queue.length + (running ? 1 : 0) + 1;
  const queueFull = queue.length >= 10;

  const submit = async (): Promise<void> => {
    const body = text.trim();
    if (body.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await sendMessage(roomId, agent, body);
      setText(""); // sadece BAŞARIDA temizle
    } catch (err) {
      const e = err as Error & { status?: number };
      setError(
        e.status === 429
          ? "Bu agent için kuyruk dolu (10). Bir kayıt iptal edilince yazabilirsin."
          : e.message,
      );
      // Metin KAYBOLMAZ: kullanıcı yazdığını tekrar yazmak zorunda kalmasın.
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ borderTop: "1px solid var(--rule)", padding: 10, background: "var(--paper)" }}>
      {error && <div style={{ color: "var(--fail)", fontSize: 12, marginBottom: 6 }}>{error}</div>}
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
          placeholder={
            queueFull
              ? "Kuyruk dolu — bir kayıt iptal edilince yazabilirsin"
              : `${agent} agent'ına görev yaz (Enter gönderir)`
          }
          disabled={busy || queueFull}
          style={{
            flex: 1,
            resize: "vertical",
            font: "inherit",
            padding: 8,
            border: "1px solid var(--rule)",
            borderRadius: 3,
            background: busy || queueFull ? "var(--canvas)" : "#fff",
            color: "var(--ink)",
          }}
        />
        {stopped ? (
          <button onClick={() => void startAgent(roomId, agent)}>Başlat</button>
        ) : (
          <button onClick={() => void submit()} disabled={busy || text.trim().length === 0}>
            Gönder
          </button>
        )}
      </div>

      {/**
       * Sıra 1 ve agent boşsa fazladan bir şey YAZMA: doğrudan çalışacak.
       * Kuyruk varsa kaçıncı olacağını ve şu an kimin mesajının koştuğunu söyle
       * — "Ayşe az önce yönerge verdi, sıradasın".
       */}
      {(running || queue.length > 0) && (
        <div style={{ color: "var(--ink-soft)", fontSize: 12, marginTop: 4 }}>
          Sırada {myNextPosition}. —{" "}
          {running
            ? `${running.user.id === meId ? "senin mesajın" : `${running.user.name}'in mesajı`} çalışıyor`
            : `${queue.length} mesaj bekliyor`}
        </div>
      )}
      {status === "starting" && (
        <div style={{ color: "var(--ink-soft)", fontSize: 12, marginTop: 4 }}>
          Agent başlıyor — mesajın kuyruğa girer, hazır olunca koşar.
        </div>
      )}
    </div>
  );
}
