import type { StoredEvent } from "@agent-rooms/protocol";

/** Dev proxy: /api → sunucu. CORS'la uğraşmamak için. */
const BASE = "/api";

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-user-id": "local",
      ...(init?.headers ?? {}),
    },
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
