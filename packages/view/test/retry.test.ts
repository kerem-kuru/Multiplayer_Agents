import { describe, expect, it } from "vitest";
import type { StoredEvent } from "@agent-rooms/protocol";
import { project } from "../src/project.js";
import { retryLabel, summarizeTurn, toCard } from "../src/card.js";

/**
 * 24 Eylül elle testi: Google her isteğe 503 döndü, kart 4+ dakika sebepsiz
 * "çalışıyor" dedi. `turn.retrying` ekranda sebebi yazdırmalı ve model cevap
 * verince susmalı.
 */

const ROOM = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const MID = "33333333-3333-4333-8333-333333333333";

let seq = 0;
const ev = (type: string, payload: Record<string, unknown>, actor?: unknown): StoredEvent =>
  ({
    seq: ++seq,
    roomId: ROOM,
    sessionId: SESSION,
    ts: "2026-09-24T14:00:00.000Z",
    actor: actor ?? { kind: "agent", name: "frontend" },
    type,
    payload,
  }) as unknown as StoredEvent;

const start = (): StoredEvent[] => {
  seq = 0;
  return [
    ev("agent.starting", { agent: "frontend", resumeSessionId: null }, { kind: "system" }),
    ev("agent.ready", { agent: "frontend", runnerPid: 8 }, { kind: "system" }),
    ev("message.received", { agent: "frontend", messageId: MID, text: "index.html yaz" }, {
      kind: "human",
      id: "u1",
      name: "Kerem",
    }),
    ev("turn.started", { agent: "frontend", messageId: MID, sdkSessionId: "s", model: "m", tools: [] }),
  ];
};

const retry = (attempt: number, status: number | null = 503) =>
  ev("turn.retrying", {
    agent: "frontend",
    messageId: MID,
    provider: "Google",
    attempt,
    budget: 3,
    status,
    detail: "This model is currently experiencing high demand.",
  });

describe("turn.retrying", () => {
  it("kart 'çalışıyor' yerine sebebi yazar", () => {
    const view = project([...start(), retry(1), retry(2)]);
    const agent = view.agents.frontend!;
    expect(agent.turns[0]!.retry).toMatchObject({ attempt: 2, budget: 3, status: 503, active: true });
    const card = toCard("frontend", agent);
    expect(card.status).toBe("calisiyor");
    expect(card.line).toBe("Google yoğun (503) · 2/3. deneme");
  });

  it("model cevap verince bekleme biter, sayı Özet için kalır", () => {
    const view = project([
      ...start(),
      retry(1),
      ev("tool.call", { agent: "frontend", messageId: MID, toolUseId: "t1", tool: "write_file", input: {} }),
      ev("turn.completed", {
        agent: "frontend",
        messageId: MID,
        subtype: "success",
        numTurns: 1,
        durationMs: 10,
        costUsd: 0,
        usage: {},
      }),
    ]);
    const turn = view.agents.frontend!.turns[0]!;
    expect(turn.retry?.active).toBe(false);
    expect(summarizeTurn(turn).failedRequests).toBe(1);
  });

  it("bütçe dolunca kart sebebi Türkçe yazar", () => {
    const view = project([
      ...start(),
      retry(1),
      retry(2),
      retry(3),
      ev("turn.failed", {
        agent: "frontend",
        messageId: MID,
        reason: "retry_exhausted",
        error: "Google yanıt vermedi (503): 3 deneme başarısız",
      }),
    ]);
    const card = toCard("frontend", view.agents.frontend!);
    expect(card.line).toBe("sağlayıcı yanıt vermedi");
    expect(summarizeTurn(view.agents.frontend!.turns[0]!).failedRequests).toBe(3);
  });

  it("etiket durum koduna göre değişir", () => {
    const base = { provider: "Google", attempt: 1, budget: 3, detail: "", active: true };
    expect(retryLabel({ ...base, status: 429 })).toBe("Google kota/hız sınırı (429) · 1/3. deneme");
    expect(retryLabel({ ...base, status: 500 })).toBe("Google hata verdi (500) · 1/3. deneme");
    expect(retryLabel({ ...base, status: null })).toBe("Google bağlantı hatası · 1/3. deneme");
  });
});
