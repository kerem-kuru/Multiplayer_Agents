import { describe, expect, it } from "vitest";
import type { StoredEvent } from "@agent-rooms/protocol";
import { modelMismatch, project } from "../src/project.js";

/**
 * Protokol 8: istenen (`turn.started.model`) ve GERÇEKTE çalışan
 * (`turn.completed.models`) model ayrı tutulur.
 *
 * 3 Ekim: Gemini CLI `-m gemini-3.8-flash` alıp istekleri `3.5-flash`'a
 * gönderiyordu. Üç gate koşumu yanlış modelle yapıldı, ekran hiçbir şey demedi.
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
    ts: "2026-10-03T00:00:00.000Z",
    actor: actor ?? { kind: "agent", name: "frontend" },
    type,
    payload,
  }) as unknown as StoredEvent;

const turn = (requested: string, models?: string[]): StoredEvent[] => {
  seq = 0;
  return [
    ev("message.received", { agent: "frontend", messageId: MID, text: "x" }, { kind: "human", id: "u", name: "K" }),
    ev("turn.started", { agent: "frontend", messageId: MID, sdkSessionId: "s", model: requested, tools: [] }),
    ev("turn.completed", {
      agent: "frontend",
      messageId: MID,
      subtype: "success",
      numTurns: 1,
      durationMs: 1,
      costUsd: 0,
      usage: {},
      ...(models ? { models } : {}),
    }),
  ];
};

const modelOf = (events: StoredEvent[]) => project(events).agents.frontend!.turns[0]!.model;

describe("istenen ve çalışan model", () => {
  it("CLI modeli değiştirdi → fark", () => {
    const m = modelOf(turn("gemini-3.8-flash", ["gemini-3.5-flash"]));
    expect(m).toEqual({ requested: "gemini-3.8-flash", actual: ["gemini-3.5-flash"] });
    expect(modelMismatch(m)).toEqual({ requested: "gemini-3.8-flash", actual: ["gemini-3.5-flash"] });
  });

  it("aynı model → fark yok", () => {
    expect(modelMismatch(modelOf(turn("gemini-3.1-flash-lite", ["gemini-3.1-flash-lite"])))).toBeNull();
  });

  it("yardımcı model de raporda → istenen listede olduğu sürece fark yok", () => {
    expect(
      modelMismatch(modelOf(turn("claude-sonnet-5-5", ["claude-sonnet-5-5", "claude-haiku-4-5-20251001"]))),
    ).toBeNull();
  });

  it("auto istek değil → fark sayılmaz", () => {
    expect(modelMismatch(modelOf(turn("auto", ["gemini-3.5-flash"])))).toBeNull();
  });

  it("eski log (models yok) → bilinmiyor, fark iddia edilmez", () => {
    const m = modelOf(turn("gemini-3.8-flash"));
    expect(m.actual).toBeNull();
    expect(modelMismatch(m)).toBeNull();
  });

  it("turn sürerken çalışan model bilinmiyor", () => {
    const m = modelOf(turn("gemini-3.8-flash", ["gemini-3.5-flash"]).slice(0, 2));
    expect(m).toEqual({ requested: "gemini-3.8-flash", actual: null });
    expect(modelMismatch(m)).toBeNull();
  });
});
