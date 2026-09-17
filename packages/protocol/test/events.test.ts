import { describe, expect, it } from "vitest";
import {
  ALL_EVENT_TYPES,
  NewRoomEvent,
  PRESENTATION_ONLY,
  RoomEvent,
  parseEvent,
} from "../src/events.js";

const roomId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const base = {
  seq: 1,
  roomId,
  sessionId,
  ts: "2026-09-17T10:00:00.000Z",
  actor: { kind: "human", id: "u1", name: "Ali" },
} as const;

describe("event kataloğu", () => {
  it("bilinen bir event'i ayrıştırır", () => {
    const e = parseEvent({
      ...base,
      type: "agent.message",
      payload: { agent: "backend", text: "auth endpoint'i yaz", queuePosition: 0 },
    });
    expect(e.type).toBe("agent.message");
    expect(e.seq).toBe(1);
  });

  it("bilinmeyen event tipini reddeder", () => {
    expect(() => parseEvent({ ...base, type: "agent.telepathy", payload: {} })).toThrow();
  });

  it("bozuk payload'ı reddeder", () => {
    expect(() =>
      parseEvent({ ...base, type: "agent.spawned", payload: { agent: "Backend!" } }),
    ).toThrow();
  });

  it("seq 0 veya negatif olamaz", () => {
    expect(() =>
      parseEvent({ ...base, seq: 0, type: "turn.started", payload: { agent: "backend", turn: 1 } }),
    ).toThrow();
  });

  it("NewRoomEvent seq ve ts istemez — onları sunucu atar", () => {
    const parsed = NewRoomEvent.parse({
      roomId,
      sessionId,
      actor: { kind: "system" },
      type: "turn.started",
      payload: { agent: "frontend", turn: 3 },
    });
    expect(parsed).not.toHaveProperty("seq");
    expect(parsed).not.toHaveProperty("ts");
  });

  it("her tip union'da bir kez geçer", () => {
    expect(new Set(ALL_EVENT_TYPES).size).toBe(ALL_EVENT_TYPES.length);
    expect(ALL_EVENT_TYPES.length).toBe(RoomEvent.options.length);
  });

  it("ham çıktı sunum düzlemine ait olarak işaretli", () => {
    expect(PRESENTATION_ONLY.has("output.chunk")).toBe(true);
    expect(PRESENTATION_ONLY.has("tool.called")).toBe(false);
  });

  it("varsayılanlar uygulanır", () => {
    const e = parseEvent({
      ...base,
      type: "tool.called",
      payload: { agent: "backend", toolUseId: "t1", name: "bash", input: { cmd: "ls" } },
    });
    expect(e.type === "tool.called" && e.payload.risk).toBe("safe");
  });
});
