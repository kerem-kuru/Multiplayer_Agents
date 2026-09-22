import { useEffect, useRef, useState } from "react";
import {
  consumeLoginToken,
  createRoom,
  listRooms,
  logout,
  me,
  type Me,
  type RoomSummary,
} from "./lib/api.js";
import { RoomPage } from "./components/RoomPage.js";
import { RoomView } from "./pages/RoomView.js";
import { Login } from "./pages/Login.js";
import { AcceptInvite } from "./pages/AcceptInvite.js";

/**
 * Uygulama kabuğu ve üç yol:
 *   /auth/callback?token=  → magic link'i tüket, sonra devam et
 *   /join?token=           → daveti kabul et, odaya gir
 *   /rooms/<id>                       → oda görünümü (kartlar)
 *   /rooms/<id>/agents/<ad>/<sekme>   → agent detayı
 *   /?room=<id>                       → eski yol, oda görünümüne yönlenir
 *
 * Yönlendirici yok: bu kadar yol için kütüphane eklemek, taşıdığı bakım yükü
 * kadar bile fayda vermezdi. Tarayıcı geri düğmesi `popstate` ile çalışıyor —
 * iki seviye arasında geri gitmek doğal olmalı (Hafta 7, Adım 14).
 */

export type DetailTab = "ozet" | "diff" | "terminal";

/** Adres çubuğundan seviye çıkarımı. */
export function parseRoute(pathname: string, search: string): {
  roomId: string | null;
  agent: string | null;
  tab: DetailTab;
} {
  const m = /^\/rooms\/([^/]+)(?:\/agents\/([^/]+)(?:\/([^/]+))?)?\/?$/.exec(pathname);
  if (m) {
    const tab = m[3];
    return {
      roomId: m[1] ?? null,
      agent: m[2] ?? null,
      tab: tab === "diff" || tab === "terminal" ? tab : "ozet",
    };
  }
  return {
    roomId: new URLSearchParams(search).get("room"),
    agent: null,
    tab: "ozet",
  };
}

type Phase = "loading" | "login" | "ready";

export function App() {
  const [user, setUser] = useState<Me | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [agent, setAgent] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>("ozet");
  const [roomId, setRoomId] = useState<string | null>(null);
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Girişten sonra dönülecek yer. */
  const [next, setNext] = useState<string | undefined>(undefined);

  /**
   * Açılış BİR KEZ koşar.
   *
   * React 18 StrictMode geliştirmede her effect'i iki kez çağırıyor. Magic
   * link TEK KULLANIMLIK olduğu için ikinci çağrı token'ı "zaten kullanılmış"
   * bulup 400 dönüyordu: giriş aslında başarılıyken ekranda hata kalıyordu.
   * Token tüketmek yan etkili bir iş; effect'in iki kez koşmasına dayanıklı
   * olması gerekiyor.
   */
  const bootstrapped = useRef(false);

  const loadRooms = (): void => {
    void listRooms()
      .then(setRooms)
      .catch((e: Error) => setError(e.message));
  };

  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    const params = new URLSearchParams(location.search);

    let loginError: string | null = null;

    void (async () => {
      // 1 — Magic link dönüşü: token'ı tüket, URL'i temizle.
      if (location.pathname === "/auth/callback") {
        const token = params.get("token");
        const target = params.get("next") ?? "/";
        if (token) {
          try {
            await consumeLoginToken(token);
          } catch (err) {
            // Başarısızlığı HEMEN gösterme: asıl ölçüt oturumun açılıp
            // açılmadığı. Aşağıdaki `me()` başarılıysa bu hata yanıltıcıdır.
            loginError = (err as Error).message;
          }
        }
        history.replaceState(null, "", target);
      }

      // 2 — Davet linki: oturum varsa kabul et, yoksa girişe yolla.
      const joinToken =
        location.pathname === "/join" ? new URLSearchParams(location.search).get("token") : null;
      if (joinToken) {
        setInviteToken(joinToken);
        setNext(`/join?token=${joinToken}`);
      }

      const route = parseRoute(location.pathname, location.search);
      if (route.roomId) {
        setRoomId(route.roomId);
        setAgent(route.agent);
        setTab(route.tab);
        // Eski `/?room=` yolunu yeni adrese tasi.
        if (location.pathname !== `/rooms/${route.roomId}`) {
          history.replaceState(null, "", `/rooms/${route.roomId}`);
        }
      }

      try {
        const current = await me();
        setUser(current);
        setPhase("ready");
        if (!joinToken) loadRooms();
      } catch {
        // Oturum yoksa VE giriş denemesi hata verdiyse sebebi göster.
        if (loginError) setError(loginError);
        setPhase("login");
      }
    })();
  }, []);

  const open = (id: string): void => {
    setInviteToken(null);
    setRoomId(id);
    setAgent(null);
    history.pushState(null, "", `/rooms/${id}`);
  };

  /** Karta tiklayinca: seviye 2. Geri dugmesi dogal calissin diye pushState. */
  const openAgent = (name: string): void => {
    if (!roomId) return;
    setAgent(name);
    setTab("ozet");
    history.pushState(null, "", `/rooms/${roomId}/agents/${name}/ozet`);
  };

  const changeTab = (next: DetailTab): void => {
    if (!roomId || !agent) return;
    setTab(next);
    history.replaceState(null, "", `/rooms/${roomId}/agents/${agent}/${next}`);
  };

  const backToRoom = (): void => {
    if (!roomId) return;
    setAgent(null);
    history.pushState(null, "", `/rooms/${roomId}`);
  };

  /*
   * Tarayici geri/ileri: iki seviye arasinda gezinme adres cubuguna yazildigi
   * icin geri dugmesi tek basina calisiyor; tek yapmamiz gereken durumu
   * adresten yeniden okumak.
   */
  useEffect(() => {
    const onPop = (): void => {
      const r = parseRoute(location.pathname, location.search);
      setRoomId(r.roomId);
      setAgent(r.agent);
      setTab(r.tab);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  if (phase === "loading") {
    return <p style={{ padding: 24, color: "var(--ink-soft)" }}>Yükleniyor…</p>;
  }

  if (phase === "login") return <Login next={next} notice={error} />;

  if (inviteToken) {
    return (
      <AcceptInvite
        token={inviteToken}
        onJoined={open}
        onNeedLogin={() => setPhase("login")}
      />
    );
  }

  if (roomId) {
    const toRoomList = (): void => {
      setRoomId(null);
      setAgent(null);
      history.pushState(null, "", "/");
      loadRooms();
    };

    // Seviye 2 — agent detayi.
    if (agent) {
      return (
        <RoomPage
          roomId={roomId}
          meId={user?.id ?? null}
          agentName={agent}
          tab={tab}
          onTabChange={changeTab}
          onBack={backToRoom}
        />
      );
    }

    // Seviye 1 — kart izgarasi. Ham cikti YOK.
    return (
      <RoomView
        roomId={roomId}
        meId={user?.id ?? null}
        onBack={toRoomList}
        onOpenAgent={openAgent}
      />
    );
  }

  return (
    <div style={{ padding: 24, maxWidth: 820, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <h1 style={{ fontSize: 20, margin: "0 0 4px" }}>Agent Odaları</h1>
        <span style={{ marginLeft: "auto", color: "var(--ink-soft)", fontSize: 13 }}>
          {user?.email}
        </span>
        <button
          onClick={() => {
            void logout().then(() => {
              setUser(null);
              setPhase("login");
            });
          }}
        >
          Çıkış
        </button>
      </div>
      <p style={{ color: "var(--ink-soft)", margin: "0 0 18px" }}>
        Bir odayı aç, agent'a görev ver, canlı izle.
      </p>

      {error && (
        <p style={{ color: "var(--fail)" }}>
          {/* "Sunucu kapalı" demek SADECE gerçekten ulaşılamadığında doğru;
              401 veya 400'ü de öyle göstermek yanlış yere baktırıyor. */}
          {error === "Failed to fetch" ? (
            <>
              Sunucuya ulaşılamadı — <code>npm run api</code> çalışıyor mu?
            </>
          ) : (
            error
          )}
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
          <p style={{ color: "var(--ink-soft)" }}>
            Henüz üye olduğun bir oda yok. Yeni bir tane aç ya da bir davet linki iste.
          </p>
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
