import type { StoredEvent } from "@agent-rooms/protocol";
import type { RoomView } from "@agent-rooms/view";

/** Dev proxy: /api → sunucu. CORS'la uğraşmamak için. */
const BASE = "/api";

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    // Kimlik ÇEREZDE: Hafta 4'ten itibaren sunucu istemcinin söylediği
    // kimliğe güvenmiyor. `credentials` aynı origin'de zaten varsayılan ama
    // açıkça yazmak niyeti belli ediyor.
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((body as { error?: string }).error ?? `HTTP ${res.status}`) as Error & {
      status?: number;
      body?: unknown;
    };
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body as T;
}

export interface RoomSummary {
  id: string;
  name: string;
  createdAt: string;
  agents: string[];
  session: { id: string; status: string; lastSeq: number } | null;
}

export interface AgentInfo {
  name: string;
  workspace: string;
  model: string;
  toolsAllow: string[];
  toolsDeny: string[];
  runtime: { status: string; lastError: string | null; restartCount: number } | null;
}

export interface EventsPage {
  sessionId: string;
  since: number;
  lastSeq: number;
  hasMore: boolean;
  events: StoredEvent[];
}

export const listRooms = (): Promise<RoomSummary[]> =>
  json<{ rooms: RoomSummary[] }>("/rooms").then((r) => r.rooms);

export const createRoom = (): Promise<{ room: { id: string } }> =>
  json<{ room: { id: string } }>("/rooms", { method: "POST", body: "{}" });

export const listAgents = (roomId: string): Promise<AgentInfo[]> =>
  json<{ agents: AgentInfo[] }>(`/rooms/${roomId}/agents`).then((r) => r.agents);

export const fetchEvents = (roomId: string, since: number, limit = 500): Promise<EventsPage> =>
  json<EventsPage>(`/rooms/${roomId}/events?since=${since}&limit=${limit}`);

/**
 * Snapshot — açılışta İLK çağrılan uç.
 *
 * `since=0` replay'i uzun odalarda saniyeler sürüyor; davet linkine tıklayan
 * kişi için hedef 3 saniyenin altı. Snapshot yoksa `state: null` döner ve
 * Hafta 3'teki tam replay yolu devreye girer.
 */
export interface SnapshotResponse {
  state: RoomView | null;
  seq: number;
  version: number;
}

export const fetchSnapshot = (roomId: string): Promise<SnapshotResponse> =>
  json<SnapshotResponse>(`/rooms/${roomId}/snapshot`);

export const startAgent = (roomId: string, agent: string): Promise<unknown> =>
  json(`/rooms/${roomId}/agents/${agent}/start`, { method: "POST" });

export const stopAgent = (roomId: string, agent: string): Promise<unknown> =>
  json(`/rooms/${roomId}/agents/${agent}/stop`, { method: "POST" });

export const sendMessage = (
  roomId: string,
  agent: string,
  text: string,
): Promise<{ messageId: string }> =>
  json<{ messageId: string }>(`/rooms/${roomId}/agents/${agent}/message`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });

export const sseUrl = (roomId: string, since: number): string =>
  `${BASE}/rooms/${roomId}/events?since=${since}`;

// --- Hafta 4: kimlik, davet, presence ---------------------------------------

export interface Me {
  id: string;
  email: string;
  name: string;
}

export const me = (): Promise<Me> => json<Me>("/auth/me");

export const requestLogin = (email: string, next?: string): Promise<{ devLink?: string }> =>
  json<{ devLink?: string }>("/auth/request", {
    method: "POST",
    body: JSON.stringify({ email, next }),
  });

/**
 * Magic link'i tüket. Çağrı AYNI ORIGIN'den (vite proxy) gider; çerez
 * bu yüzden arayüzün origin'ine yazılır. Doğrudan API adresine gitseydik
 * çerez 8787'ye yazılır ve arayüz onu göremezdi.
 */
export async function consumeLoginToken(token: string): Promise<void> {
  const res = await fetch(`/api/auth/callback?token=${encodeURIComponent(token)}`, {
    redirect: "manual",
    credentials: "same-origin",
  });
  // 302 (yönlendirme) veya opaqueredirect = başarılı; gezinmeyi biz yapıyoruz.
  if (res.type !== "opaqueredirect" && res.status >= 400) {
    throw new Error("bağlantı geçersiz veya süresi dolmuş");
  }
}

export const logout = (): Promise<unknown> => json("/auth/logout", { method: "POST" });

export interface RoomDetail {
  room: { id: string; name: string };
  role: "owner" | "viewer";
}

export const fetchRoom = (roomId: string): Promise<RoomDetail> =>
  json<RoomDetail>(`/rooms/${roomId}`);

export interface Invite {
  prefix: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  active: boolean;
}

export const createInvite = (
  roomId: string,
  expiresInHours?: number,
): Promise<{ url: string; prefix: string; expiresAt: string }> =>
  json(`/rooms/${roomId}/invites`, {
    method: "POST",
    body: JSON.stringify(expiresInHours ? { expiresInHours } : {}),
  });

export const listInvites = (roomId: string): Promise<Invite[]> =>
  json<{ invites: Invite[] }>(`/rooms/${roomId}/invites`).then((r) => r.invites);

export const revokeInvite = (roomId: string, prefix: string): Promise<unknown> =>
  json(`/rooms/${roomId}/invites/${prefix}`, { method: "DELETE" });

export const acceptInvite = (token: string): Promise<{ roomId: string; role: string }> =>
  json("/invites/accept", { method: "POST", body: JSON.stringify({ token }) });

export interface Person {
  userId: string;
  name: string;
  viewing: string | null;
  since: number;
}

/**
 * Bakış bildirimi. `connectionId` İLK SSE frame'inden (`hello`) gelir ve
 * geri yollanır: yoksa sunucu kullanıcının TÜM sekmelerinin bakışını
 * değiştirir ve üç sekme açan kişi hepsinde aynı agent'a bakıyor görünür.
 */
export const setPresence = (
  roomId: string,
  viewing: string | null,
  connectionId?: string | null,
): Promise<unknown> =>
  json(`/rooms/${roomId}/presence`, {
    method: "POST",
    body: JSON.stringify(connectionId ? { viewing, connectionId } : { viewing }),
  });
