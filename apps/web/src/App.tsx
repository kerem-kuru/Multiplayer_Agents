import { useEffect, useState } from "react";
import { createRoom, listRooms, type RoomSummary } from "./lib/api.js";
import { RoomPage } from "./components/RoomPage.js";

export function App() {
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [roomId, setRoomId] = useState<string | null>(
    () => new URLSearchParams(location.search).get("room"),
  );
  const [error, setError] = useState<string | null>(null);

  const load = (): void => {
    void listRooms()
      .then(setRooms)
      .catch((e: Error) => setError(e.message));
  };

  useEffect(load, []);

  const open = (id: string): void => {
    setRoomId(id);
    history.replaceState(null, "", `?room=${id}`);
  };

  if (roomId) {
    return (
      <RoomPage
        roomId={roomId}
        onBack={() => {
          setRoomId(null);
          history.replaceState(null, "", location.pathname);
          load();
        }}
      />
    );
  }

  return (
    <div style={{ padding: 24, maxWidth: 820, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, margin: "0 0 4px" }}>Agent Odaları</h1>
      <p style={{ color: "var(--ink-soft)", margin: "0 0 18px" }}>
        Bir odayı aç, agent'a görev ver, canlı izle.
      </p>

      {error && (
        <p style={{ color: "var(--fail)" }}>
          Sunucuya ulaşılamadı: {error} — <code>npm run api</code> çalışıyor mu?
        </p>
      )}

      <button
        onClick={() => {
          void createRoom()
            .then((r) => open(r.room.id))
            .catch((e: Error) => setError(e.message));
        }}
      >
        Yeni oda aç
      </button>

      <div style={{ marginTop: 18 }}>
        {rooms.length === 0 && !error && (
          <p style={{ color: "var(--ink-soft)" }}>Henüz oda yok.</p>
        )}
        {rooms.map((r) => (
          <button
            key={r.id}
            onClick={() => open(r.id)}
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              padding: 10,
              marginBottom: 6,
              background: "var(--paper)",
            }}
          >
            <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
              <strong>{r.name}</strong>
              <span className="mono" style={{ color: "var(--ink-soft)", fontSize: 12 }}>
                {r.id.slice(0, 8)}
              </span>
              <span style={{ marginLeft: "auto", color: "var(--ink-soft)", fontSize: 12 }}>
                {r.agents.join(", ")} · seq {r.session?.lastSeq ?? 0}
              </span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
