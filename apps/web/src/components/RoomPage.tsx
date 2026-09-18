import { useEffect, useState } from "react";
import {
  fetchRoom,
  listAgents,
  setPresence,
  startAgent,
  stopAgent,
  type AgentInfo,
} from "../lib/api.js";
import { useEventStream, type Connection } from "../lib/useEventStream.js";
import type { AgentStatus } from "@agent-rooms/view";
import { ActivityFeed } from "./ActivityFeed.js";
import { TerminalView } from "./TerminalView.js";
import { Composer } from "./Composer.js";
import { PresenceBar } from "./PresenceBar.js";
import { ShareDialog } from "./ShareDialog.js";

/** Renk tek başına bilgi taşımaz — her durumun yanında kelimesi yazar. */
const STATUS_COLOR: Record<string, string> = {
  busy: "var(--run)",
  idle: "var(--ink-soft)",
  starting: "var(--wait)",
  crashed: "var(--wait)",
  failed: "var(--fail)",
  stopped: "var(--idle)",
};

const CONNECTION_LABEL: Record<Connection, string> = {
  loading: "yükleniyor",
  live: "canlı",
  reconnecting: "yeniden bağlanıyor",
  offline: "bağlantı yok",
};

export function RoomPage({
  roomId,
  onBack,
  meId,
}: {
  roomId: string;
  onBack: () => void;
  meId: string | null;
}) {
  const { view, connection, lastSeq, people, reconnect } = useEventStream(roomId);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<"feed" | "terminal">("feed");
  /**
   * Rol SUNUCUDAN gelir. UI'ın düğme gizlemesi yetki değildir — sunucu zaten
   * 403 döner; buradaki amaç kullanıcıyı boşuna denemekten kurtarmak.
   */
  const [role, setRole] = useState<"owner" | "viewer" | null>(null);
  const [sharing, setSharing] = useState(false);
  const canWrite = role === "owner";

  useEffect(() => {
    let alive = true;
    void fetchRoom(roomId)
      .then((r) => {
        if (alive) setRole(r.role);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [roomId]);

  // Bakılan agent değişince odadakilere bildir. Presence event log'a yazılmaz.
  useEffect(() => {
    if (!selected) return;
    void setPresence(roomId, selected).catch(() => undefined);
  }, [roomId, selected]);

  // Agent listesi config'ten gelir; sayı hiçbir yerde sabit değil.
  useEffect(() => {
    let alive = true;
    const load = (): void => {
      void listAgents(roomId).then((a) => {
        if (!alive) return;
        setAgents(a);
        setSelected((cur) => cur ?? a[0]?.name ?? null);
      });
    };
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [roomId]);

  const agentView = selected ? view.agents[selected] : undefined;
  const turns = agentView?.turns ?? [];
  // Durum event log'dan türer; runtime tablosu yedek.
  const status: AgentStatus =
    agentView?.status ??
    ((agents.find((a) => a.name === selected)?.runtime?.status as AgentStatus) ?? "stopped");

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <header
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          padding: "8px 14px",
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
          seq {lastSeq} · {CONNECTION_LABEL[connection]}
        </span>
        {canWrite && <button onClick={() => setSharing((v) => !v)}>Paylaş</button>}
        {connection === "offline" && <button onClick={reconnect}>Yeniden bağlan</button>}
      </header>

      {sharing && <ShareDialog roomId={roomId} onClose={() => setSharing(false)} />}

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* AgentBar — her zaman agents.map() */}
        <nav
          style={{
            width: 190,
            borderRight: "1px solid var(--rule)",
            padding: 8,
            background: "var(--paper)",
            overflowY: "auto",
          }}
        >
          {agents.map((a) => {
            const st = view.agents[a.name]?.status ?? a.runtime?.status ?? "stopped";
            const active = a.name === selected;
            return (
              <button
                key={a.name}
                onClick={() => setSelected(a.name)}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  marginBottom: 4,
                  border: "1px solid",
                  borderColor: active ? "var(--ink)" : "var(--rule)",
                  background: active ? "#fff" : "transparent",
                }}
              >
                <div style={{ fontWeight: 600 }}>{a.name}</div>
                <div style={{ fontSize: 11, color: STATUS_COLOR[st] ?? "var(--ink-soft)" }}>
                  ● {st}
                  {/* Kim bu agent'a bakıyor — renk değil, isim. */}
                  {people.some((p) => p.viewing === a.name && p.userId !== meId) && (
                    <span style={{ color: "var(--ink-soft)" }}>
                      {" · "}
                      {people
                        .filter((p) => p.viewing === a.name && p.userId !== meId)
                        .map((p) => p.name)
                        .join(", ")}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
          {selected && canWrite && (
            <div style={{ marginTop: 10, display: "flex", gap: 4 }}>
              <button onClick={() => void startAgent(roomId, selected)}>başlat</button>
              <button onClick={() => void stopAgent(roomId, selected)}>durdur</button>
            </div>
          )}
        </nav>

        <main style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div style={{ display: "flex", gap: 4, padding: "6px 14px 0" }}>
            {(["feed", "terminal"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                style={{
                  borderBottom: tab === t ? "2px solid var(--ink)" : "1px solid var(--rule)",
                  background: tab === t ? "#fff" : "transparent",
                }}
              >
                {t === "feed" ? "Etkinlik" : "Terminal"}
              </button>
            ))}
          </div>

          <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
            {tab === "feed" ? <ActivityFeed turns={turns} canWrite={canWrite} /> : null}
            {/* Terminal DOM'da kalır: unmount olursa geçmiş kaybolur. */}
            <div style={{ height: "100%", display: tab === "terminal" ? "block" : "none" }}>
              <TerminalView turns={turns} visible={tab === "terminal"} />
            </div>
          </div>

          {selected && canWrite && <Composer roomId={roomId} agent={selected} status={status} />}
          {selected && role === "viewer" && (
            /* Gizlemek değil, YERİNE koymak: boşluk bırakmak "bozuk mu?"
               sorusunu doğurur. Yazma yetkisi Hafta 5'in işi. */
            <div
              style={{
                borderTop: "1px solid var(--rule)",
                padding: 10,
                background: "var(--paper)",
                color: "var(--ink-soft)",
                fontSize: 13,
              }}
            >
              Bu odayı izliyorsun. Görev vermek için oda sahibinden yetki iste.
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
