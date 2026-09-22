import { useEffect, useState } from "react";
import { toCards } from "@agent-rooms/view";
import { AgentCard } from "../components/AgentCard.js";
import { PresenceBar } from "../components/PresenceBar.js";
import { fetchReads } from "../lib/api.js";
import { useEventStream } from "../lib/useEventStream.js";

/**
 * Hafta 7, Adım 14 — oda görünümü (seviye 1).
 *
 * **BU SAYFADA HAM ÇIKTI YOKTUR.** Terminal yok, patch yok, tool sonucu yok.
 * Bileşen ağacında `TerminalView` ve `DiffFile` İMPORT EDİLMEZ — bunun testi
 * var (`gate:w7`, kontrol 17). Kart satırını `toCard` süzüyor.
 *
 * Kart sayısı `agents.map()` ile geliyor: üçüncü agent eklemek YAML'a bir blok,
 * koda hiçbir şey.
 */

const CONNECTION_LABEL: Record<string, string> = {
  live: "canlı",
  loading: "bağlanıyor",
  offline: "bağlantı yok",
};

export function RoomView({
  roomId,
  meId,
  onBack,
  onOpenAgent,
}: {
  roomId: string;
  meId: string | null;
  onBack: () => void;
  onOpenAgent: (agent: string) => void;
}) {
  const { view, connection, lastSeq, people, reconnect } = useEventStream(roomId);
  const [reads, setReads] = useState<Record<string, number>>({});

  useEffect(() => {
    let alive = true;
    void fetchReads(roomId)
      .then((r) => {
        if (alive) setReads(r);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [roomId, lastSeq]);

  const cards = toCards(view);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "8px 12px",
          borderBottom: "1px solid var(--ink)",
          background: "var(--paper)",
        }}
      >
        <button onClick={onBack}>← odalar</button>
        <strong className="mono">{roomId.slice(0, 8)}</strong>
        <span style={{ marginLeft: "auto" }}>
          <PresenceBar people={people} meId={meId} />
        </span>
        <span style={{ color: "var(--ink-soft)", fontSize: 12 }}>
          seq {lastSeq} · {CONNECTION_LABEL[connection] ?? connection}
        </span>
        {connection === "offline" && <button onClick={reconnect}>Yeniden bağlan</button>}
      </header>

      {/*
        Açık çakışma varsa TEK satır uyarı. Ayrıntı agent detayında; burada
        amaç "iki agent aynı dosyaya dokunuyor" bilgisini bir bakışta vermek.
      */}
      {view.conflicts.length > 0 && (
        <div
          role="status"
          style={{
            padding: "6px 12px",
            borderBottom: "1px solid var(--rule)",
            background: "var(--warn-bg, #fdf6e3)",
            fontSize: 13,
          }}
        >
          {view.conflicts.map((c) => (
            <div key={c.id}>
              {c.agents.join(" ve ")} aynı dosyayı değiştiriyor: {c.paths.slice(0, 3).join(", ")}
              {c.paths.length > 3 ? ` (+${c.paths.length - 3})` : ""}
            </div>
          ))}
        </div>
      )}

      <main
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 12,
          display: "grid",
          gap: 10,
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          alignContent: "start",
        }}
      >
        {cards.length === 0 && (
          <p style={{ color: "var(--ink-soft)" }}>
            Bu odada henüz agent yok ya da durum henüz yüklenmedi.
          </p>
        )}
        {cards.map((card) => (
          <AgentCard
            key={card.name}
            card={card}
            /*
             * Okunmamış: DİKKAT GEREKTİREN son event bu kullanıcının gördüğü
             * sıradan büyükse. Her tool çağrısı sayılsaydı işaret hiç sönmezdi.
             */
            unread={card.lastActivitySeq > (reads[card.name] ?? 0)}
            watchers={people
              .filter((p) => p.viewing === card.name && p.userId !== meId)
              .map((p) => p.name)}
            onOpen={() => onOpenAgent(card.name)}
          />
        ))}
      </main>
    </div>
  );
}
