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
const messageId = "33333333-3333-4333-8333-333333333333";
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
      type: "message.received",
      payload: { agent: "backend", messageId, text: "auth endpoint'i yaz" },
    });
    expect(e.type).toBe("message.received");
    expect(e.seq).toBe(1);
  });

  it("bilinmeyen event tipini reddeder", () => {
    expect(() => parseEvent({ ...base, type: "agent.telepathy", payload: {} })).toThrow();
  });

  it("bozuk payload'ı reddeder", () => {
    expect(() =>
      parseEvent({ ...base, type: "agent.ready", payload: { agent: "Backend!", runnerPid: 1 } }),
    ).toThrow();
  });

  it("seq 0 veya negatif olamaz", () => {
    expect(() =>
      parseEvent({
        ...base,
        seq: 0,
        type: "agent.ready",
        payload: { agent: "backend", runnerPid: 12 },
      }),
    ).toThrow();
  });

  it("NewRoomEvent seq ve ts istemez — onları sunucu atar", () => {
    const parsed = NewRoomEvent.parse({
      roomId,
      sessionId,
      actor: { kind: "system" },
      type: "agent.starting",
      payload: { agent: "frontend", resumeSessionId: null },
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
    expect(PRESENTATION_ONLY.has("tool.call")).toBe(false);
  });

  it("turn içi event messageId olmadan reddedilir", () => {
    // Hangi mesaja ait olduğu belli olmayan bir turn event'i log'u okunamaz kılar.
    expect(() =>
      parseEvent({
        ...base,
        type: "agent.text",
        payload: { agent: "backend", text: "merhaba" },
      }),
    ).toThrow();
  });

  it("tool.call kırpma bayrağı taşır", () => {
    const e = parseEvent({
      ...base,
      type: "tool.call",
      payload: {
        agent: "backend",
        messageId,
        toolUseId: "t1",
        tool: "Bash",
        input: { command: "ls" },
        truncated: false,
      },
    });
    expect(e.type === "tool.call" && e.payload.truncated).toBe(false);
  });
});

describe("sağlayıcı bağımsızlığı", () => {
  it("sağlayıcı değişkenlerini toplar, ilgisizleri almaz", async () => {
    const { collectProviderEnv } = await import("../src/runtime.js");
    const env = collectProviderEnv({
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_ACCESS_KEY_ID: "AKIA...",
      AWS_REGION: "eu-central-1",
      ANTHROPIC_VERTEX_PROJECT_ID: "p1",
      PATH: "/usr/bin",
      DATABASE_URL: "postgres://x",
      EMPTY: "",
    });
    expect(Object.keys(env).sort()).toEqual([
      "ANTHROPIC_VERTEX_PROJECT_ID",
      "AWS_ACCESS_KEY_ID",
      "AWS_REGION",
      "CLAUDE_CODE_USE_BEDROCK",
    ]);
    // Sır taşımayan ama alakasız değişkenler container'a sızmamalı.
    expect(env).not.toHaveProperty("DATABASE_URL");
  });

  it("sağlayıcı seçiliyse API anahtarı zorunlu değil", async () => {
    const { hasProviderBackend } = await import("../src/runtime.js");
    expect(hasProviderBackend({ CLAUDE_CODE_USE_BEDROCK: "1" })).toBe(true);
    expect(hasProviderBackend({ ANTHROPIC_BASE_URL: "https://gw.local" })).toBe(true);
    expect(hasProviderBackend({ ANTHROPIC_API_KEY: "sk-ant-x" })).toBe(false);
    expect(hasProviderBackend({})).toBe(false);
  });

  /**
   * Gemini'de sistem prompt'u veren bayrak yok; rol prompt'u `GEMINI.md`
   * üzerinden gidiyor. Bu testin ölçtüğü şey dosyanın İÇERİĞİ: rol prompt'u,
   * çok kişili oda notu ve kurulum doğrulama satırı üçü birden orada mı.
   */
  it("GEMINI.md rol prompt'unu, çok kişili notu ve doğrulama satırını taşır", async () => {
    const { geminiContextFile, MULTIPLAYER_PROMPT_NOTE, SETUP_PROBE_ANSWER, SETUP_PROBE_QUESTION } =
      await import("../src/prompts.js");
    const text = geminiContextFile({
      name: "backend",
      systemPrompt: "Sen bu odanin backend gelistiricisisin.",
    });
    expect(text).toContain("Sen bu odanin backend gelistiricisisin.");
    expect(text).toContain(MULTIPLAYER_PROMPT_NOTE);
    expect(text).toContain(SETUP_PROBE_QUESTION);
    expect(text).toContain(`${SETUP_PROBE_ANSWER} backend`);
    // Üretilmiş dosya olduğu dosyanın kendisinde yazıyor: elle düzenleyen
    // kişi değişikliğinin kalıcı olmadığını görmeli.
    expect(text).toContain("ÜRETİLMİŞ DOSYA");
  });

  it("çok kişili oda notu Claude yolunda rol prompt'unun YANINA ekleniyor", async () => {
    const { appendMultiplayerNote, MULTIPLAYER_PROMPT_NOTE } = await import("../src/prompts.js");
    const merged = appendMultiplayerNote("Rol metni.");
    expect(merged.startsWith("Rol metni.")).toBe(true);
    expect(merged).toContain(MULTIPLAYER_PROMPT_NOTE);
    // Rol prompt'u boşsa yalnızca not kalır; boş satırlarla başlamaz.
    expect(appendMultiplayerNote("   ")).toBe(MULTIPLAYER_PROMPT_NOTE);
  });

  it("rol YAML'ı koşum ortamını taşır, varsayılanı claude", async () => {
    const { AgentConfig } = await import("../src/room-config.js");
    const a = AgentConfig.parse({
      name: "backend",
      systemPrompt: "x",
      workspace: "worktrees/backend",
    });
    expect(a.runtime).toBe("claude");
    expect(() =>
      AgentConfig.parse({
        name: "backend",
        systemPrompt: "x",
        workspace: "worktrees/backend",
        runtime: "uydurma",
      }),
    ).toThrow();
  });
});
