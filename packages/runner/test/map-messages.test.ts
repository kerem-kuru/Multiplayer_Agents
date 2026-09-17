import { describe, expect, it } from "vitest";
import { NewRoomEvent } from "@agent-rooms/protocol";
import { mapMessage, type MapContext } from "../src/map-messages.js";

/**
 * Örnek SDK mesajlarıyla dönüşüm testleri. Gerçek API çağrısı yok — bu yüzden
 * anahtarsız da koşar.
 */

const ctx: MapContext = {
  roomId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  agent: "backend",
  messageId: "33333333-3333-4333-8333-333333333333",
};

/** Üretilen her event gerçekten log'a yazılabilir olmalı. */
const assertWritable = (events: unknown[]) => {
  for (const e of events) expect(() => NewRoomEvent.parse(e)).not.toThrow();
};

describe("SDK mesajı → event", () => {
  it("system/init → turn.started, SDK oturum kimliğini döndürür", () => {
    const r = mapMessage(
      {
        type: "system",
        subtype: "init",
        session_id: "sdk-abc",
        model: "claude-haiku-4-5-20251001",
        tools: ["Read", "Write", "Bash"],
        cwd: "/room/worktrees/backend",
      },
      ctx,
    );
    expect(r.sdkSessionId).toBe("sdk-abc");
    expect(r.events).toHaveLength(1);
    const e = r.events[0]!;
    expect(e.type).toBe("turn.started");
    expect(e.type === "turn.started" && e.payload.tools).toEqual(["Read", "Write", "Bash"]);
    assertWritable(r.events);
  });

  it("assistant text → agent.text", () => {
    const r = mapMessage(
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "text", text: "dosyayı yazıyorum" }] },
      },
      ctx,
    );
    expect(r.events).toHaveLength(1);
    expect(r.events[0]!.type).toBe("agent.text");
    assertWritable(r.events);
  });

  it("assistant tool_use → tool.call", () => {
    const r = mapMessage(
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          content: [
            { type: "text", text: "şimdi yazıyorum" },
            { type: "tool_use", id: "tu_1", name: "Write", input: { file_path: "hello.js" } },
          ],
        },
      },
      ctx,
    );
    expect(r.events.map((e) => e.type)).toEqual(["agent.text", "tool.call"]);
    const call = r.events[1]!;
    expect(call.type === "tool.call" && call.payload.tool).toBe("Write");
    expect(call.type === "tool.call" && call.payload.truncated).toBe(false);
    assertWritable(r.events);
  });

  it("user tool_result → tool.result, blok dizisi birleştirilir", () => {
    const r = mapMessage(
      {
        type: "user",
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_1",
              is_error: false,
              content: [{ type: "text", text: "merhaba " }, { type: "text", text: "oda" }],
            },
          ],
        },
      },
      ctx,
    );
    expect(r.events).toHaveLength(1);
    const e = r.events[0]!;
    expect(e.type === "tool.result" && e.payload.output).toBe("merhaba oda");
    expect(e.type === "tool.result" && e.payload.toolUseId).toBe("tu_1");
    assertWritable(r.events);
  });

  it("result → turn.completed", () => {
    const r = mapMessage(
      {
        type: "result",
        subtype: "success",
        num_turns: 3,
        duration_ms: 4210,
        total_cost_usd: 0.0123,
        usage: { input_tokens: 100, output_tokens: 20 },
      },
      ctx,
    );
    expect(r.events).toHaveLength(1);
    const e = r.events[0]!;
    expect(e.type === "turn.completed" && e.payload.subtype).toBe("success");
    expect(e.type === "turn.completed" && e.payload.costUsd).toBeCloseTo(0.0123);
    assertWritable(r.events);
  });

  it("subagent çıktısı yok sayılır — Hafta 2'de kapalı", () => {
    const r = mapMessage(
      {
        type: "assistant",
        parent_tool_use_id: "tu_parent",
        message: { content: [{ type: "text", text: "alt görev" }] },
      },
      ctx,
    );
    expect(r.events).toEqual([]);
  });

  it("bilinmeyen mesaj tipi sessizce atlanır — SDK birleşimi ~38 üyeli", () => {
    for (const msg of [
      { type: "status" },
      { type: "compact_boundary" },
      { type: "system", subtype: "get_context_usage" },
      null,
      "metin",
    ]) {
      expect(mapMessage(msg, ctx).events).toEqual([]);
    }
  });

  it("16 KB'ı aşan tool çıktısı kırpılır ve işaretlenir", () => {
    const r = mapMessage(
      {
        type: "user",
        parent_tool_use_id: null,
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tu_2", is_error: false, content: "x".repeat(20000) },
          ],
        },
      },
      ctx,
    );
    const e = r.events[0]!;
    expect(e.type === "tool.result" && e.payload.truncated).toBe(true);
    expect(e.type === "tool.result" && e.payload.output.length).toBeLessThanOrEqual(16 * 1024);
    assertWritable(r.events);
  });
});
