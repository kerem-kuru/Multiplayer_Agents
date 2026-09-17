import { describe, expect, it } from "vitest";
import { NewRoomEvent, roomRelativePath } from "@agent-rooms/protocol";
import { mapStreamLine, resolveGeminiTools, type MapContext } from "../src/map-stream.js";

/**
 * Gerçek Gemini CLI çıktısıyla ölçülmüş satırlar (docs/runtime-gemini.md).
 * API çağrısı yok — anahtarsız koşar.
 */

const base = {
  roomId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  agent: "backend",
  messageId: "33333333-3333-4333-8333-333333333333",
};
const ctx = (allow: string[] = ["write_file", "run_shell_command"]): MapContext => ({
  ...base,
  allowedTools: new Set(allow),
});

const assertWritable = (events: unknown[]) => {
  for (const e of events) expect(() => NewRoomEvent.parse(e)).not.toThrow();
};

describe("Gemini stream-json → event", () => {
  it("init → turn.started, tool listesi boş (Gemini vermiyor)", () => {
    const r = mapStreamLine(
      { type: "init", session_id: "gem-1", model: "auto" },
      ctx(),
    );
    expect(r.sdkSessionId).toBe("gem-1");
    const e = r.events[0]!;
    expect(e.type).toBe("turn.started");
    expect(e.type === "turn.started" && e.payload.tools).toEqual([]);
    assertWritable(r.events);
  });

  it("assistant message → agent.text, user message yok sayılır", () => {
    expect(
      mapStreamLine({ type: "message", role: "user", content: "görev" }, ctx()).events,
    ).toEqual([]);
    const r = mapStreamLine(
      { type: "message", role: "assistant", content: "yazıyorum", delta: true },
      ctx(),
    );
    expect(r.events[0]!.type).toBe("agent.text");
    assertWritable(r.events);
  });

  it("tool_use → tool.call + file.changed (oda-göreli yol)", () => {
    const r = mapStreamLine(
      {
        type: "tool_use",
        tool_name: "write_file",
        tool_id: "write_file__call_1",
        parameters: { file_path: "/room/worktrees/backend/hello.js", content: "x" },
      },
      ctx(),
    );
    expect(r.events.map((e) => e.type)).toEqual(["tool.call", "file.changed"]);
    const fc = r.events[1]!;
    // Mutlak yol event log'a girmez: iki koşum ortamı aynı biçimi vermeli.
    expect(fc.type === "file.changed" && fc.payload.path).toBe("worktrees/backend/hello.js");
    assertWritable(r.events);
  });

  it("izin dışı tool SAPTANIR (engellenmez)", () => {
    const r = mapStreamLine(
      { type: "tool_use", tool_name: "run_shell_command", tool_id: "t1", parameters: {} },
      ctx(["write_file"]),
    );
    expect(r.events[0]!.type).toBe("tool.denied");
    expect(r.events[1]!.type).toBe("tool.call");
    assertWritable(r.events);
  });

  it("Gemini'nin iç bakım tool'ları ihlal sayılmaz", () => {
    // update_topic oturum başlığını günceller; dosya/kabuk işi değil.
    for (const tool of ["update_topic", "write_todos"]) {
      const r = mapStreamLine(
        { type: "tool_use", tool_name: tool, tool_id: "t", parameters: {} },
        ctx(["write_file"]),
      );
      expect(r.events.map((e) => e.type)).toEqual(["tool.call"]);
    }
  });

  it("tool_result → tool.result, status'tan isError", () => {
    const ok = mapStreamLine(
      { type: "tool_result", tool_id: "t1", status: "success" },
      ctx(),
    ).events[0]!;
    expect(ok.type === "tool.result" && ok.payload.isError).toBe(false);

    const bad = mapStreamLine(
      { type: "tool_result", tool_id: "t2", status: "error" },
      ctx(),
    ).events[0]!;
    expect(bad.type === "tool.result" && bad.payload.isError).toBe(true);
  });

  it("result → turn.completed, maliyet bilinmiyor", () => {
    const r = mapStreamLine(
      {
        type: "result",
        status: "success",
        stats: { duration_ms: 11729, total_tokens: 25889, tool_calls: 1 },
      },
      ctx(),
    );
    expect(r.finished).toEqual({ ok: true });
    const e = r.events[0]!;
    expect(e.type === "turn.completed" && e.payload.durationMs).toBe(11729);
    // Gemini USD maliyet vermiyor — 0 "bilmiyoruz" demek.
    expect(e.type === "turn.completed" && e.payload.costUsd).toBe(0);
    assertWritable(r.events);
  });

  it("bilinmeyen satır tipi sessizce atlanır", () => {
    for (const l of [{ type: "thought" }, {}, null, "metin"]) {
      expect(mapStreamLine(l, ctx()).events).toEqual([]);
    }
  });
});

describe("Gemini tool eşlemesi", () => {
  it("soyut adlar Gemini tool adlarına çözülür", () => {
    const r = resolveGeminiTools({ toolsAllow: ["read", "edit"], toolsDeny: [] });
    expect(r.allow).toContain("read_file");
    expect(r.allow).toContain("grep");
    expect(r.allow).toContain("write_file");
    expect(r.allow).not.toContain("run_shell_command");
  });

  it("deny kazanır ve subagent her zaman kapalı", () => {
    const r = resolveGeminiTools({ toolsAllow: ["bash", "edit"], toolsDeny: ["bash"] });
    expect(r.allow).not.toContain("run_shell_command");
    expect(r.allow).toContain("write_file");
    expect(r.deny).toContain("task");
  });
});

describe("oda-göreli yol", () => {
  it("/room önekini atar, diğerlerine dokunmaz", () => {
    expect(roomRelativePath("/room/worktrees/backend/a.js")).toBe("worktrees/backend/a.js");
    expect(roomRelativePath("/room")).toBe("");
    expect(roomRelativePath("/baska/yer.js")).toBe("/baska/yer.js");
  });
});
