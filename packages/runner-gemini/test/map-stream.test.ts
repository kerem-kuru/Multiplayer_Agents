import { describe, expect, it } from "vitest";
import { NewRoomEvent, roomRelativePath } from "@agent-rooms/protocol";
import {
  createRetryTracker,
  geminiIncludeDirectories,
  mapStreamLine,
  resolveGeminiTools,
  type MapContext,
} from "../src/map-stream.js";

/**
 * Gerçek Gemini CLI çıktısıyla ölçülmüş satırlar (docs/runtime-gemini.md).
 * API çağrısı yok — anahtarsız koşar.
 */

/** Satır sonu: test dosyasında kaçış dizisi yerine sabit. */
const NEWLINE = String.fromCharCode(10);

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

  it("çıktı UYDURULMAZ: Gemini metni vermiyorsa output boş kalır", () => {
    // Bir zamanlar status ("success") output diye yazılıyordu ve terminalde
    // programın çıktısıymış gibi görünüyordu. Bilmediğimizi söylemek doğrusu.
    const e = mapStreamLine(
      { type: "tool_result", tool_id: "t1", status: "success" },
      ctx(),
    ).events[0]!;
    expect(e.type === "tool.result" && e.payload.output).toBe("");
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

  /**
   * Hafta 4 borcu: başarısız turn `turn.completed · subtype:"error"` olarak
   * yazılıyordu ve SEBEP hiçbir yerde durmuyordu. Ekranda `bitti · error`
   * görünüyor, nedeni (kota 429) yalnızca sunucu logunda kalıyordu.
   */
  it("başarısız result → turn.failed ve sebep taşınır", () => {
    const r = mapStreamLine(
      { type: "result", status: "error", stats: { duration_ms: 12 } },
      { ...ctx(), errorTail: "ApiError: 429 RESOURCE_EXHAUSTED quota exceeded" },
    );
    expect(r.finished).toEqual({ ok: false });
    const e = r.events[0]!;
    expect(e.type).toBe("turn.failed");
    if (e.type !== "turn.failed") throw new Error("turn.failed bekleniyordu");
    expect(e.payload.reason).toBe("sdk_error");
    expect(e.payload.error).toContain("429");
    assertWritable(r.events);
  });

  it("sebep bilinmiyorsa uydurulmaz, durum adı yazılır", () => {
    const r = mapStreamLine({ type: "result", status: "cancelled" }, ctx());
    const e = r.events[0]!;
    if (e.type !== "turn.failed") throw new Error("turn.failed bekleniyordu");
    expect(e.payload.error).toContain("cancelled");
    assertWritable(r.events);
  });

  /**
   * Gerçekte oldu: kota dolunca ekranda
   * "sync file:///opt/runner/gemini/.../bundle/gemini-XXX.js:11868:26" yazdı.
   * Sebep (429 + kota) yığın izinin ORTASINDAydı ve UI ilk satırı gösteriyor.
   */
  it("kota hatasında SEBEP başa geliyor, yığın izi arkada kalıyor", async () => {
    const { summarizeGeminiError } = await import("../src/map-stream.js");
    const tail = [
      "sync file:///opt/runner/gemini/node_modules/@google/gemini-cli/bundle/gemini-LUNNHKPJ.js:11868:26",
      "    at async main (file:///opt/runner/gemini/.../gemini-LUNNHKPJ.js:17295:5) {",
      "  cause: {",
      "    code: 429,",
      "    message: 'You exceeded your current quota, please check your plan and billing details.'",
      "  }",
    ].join(NEWLINE);

    expect(summarizeGeminiError(tail)).toContain("429");

    const r = mapStreamLine({ type: "result", status: "error" }, { ...ctx(), errorTail: tail });
    const e = r.events[0]!;
    if (e.type !== "turn.failed") throw new Error("turn.failed bekleniyordu");
    // Ekranda ilk 160 karakter görünüyor: sebep O ARALIKTA olmalı.
    expect(e.payload.error.slice(0, 160)).toContain("429");
    // Yığın izi atılmadı: hata ayıklamak için payload'da duruyor.
    expect(e.payload.error).toContain("gemini-LUNNHKPJ.js");
    assertWritable(r.events);
  });

  it("sebep satırı yoksa ilk satıra düşüyor", async () => {
    const { summarizeGeminiError } = await import("../src/map-stream.js");
    expect(summarizeGeminiError(`bir sey patladi${NEWLINE}ikinci satir`)).toBe("bir sey patladi");
    expect(summarizeGeminiError("")).toBe("");
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

describe("geminiIncludeDirectories", () => {
  it("contracts her zaman calisma alaninda (24 Eylul: 'Path not in workspace')", () => {
    expect(geminiIncludeDirectories({ contracts: "/room/contracts", readable: [] })).toEqual([
      "/room/contracts",
    ]);
  });

  it("readable oda kokune gore mutlak yola cevrilir, tekrarlar dusuluyor", () => {
    expect(
      geminiIncludeDirectories({
        contracts: "/room/contracts",
        readable: ["worktrees/frontend", "/room/contracts", "worktrees/frontend/"],
      }),
    ).toEqual(["/room/contracts", "/room/worktrees/frontend"]);
  });
});

describe("createRetryTracker", () => {
  /** Gemini CLI 0.60.0 stderr'i — sahte 503 sunucusuyla ölçüldü (24 Eylül). */
  const RETRYING =
    'Attempt 1 failed with status 503. Retrying with backoff... _ApiError: {"error":{"code":503}}';
  const MAXED =
    "Attempt 2 failed: This model is currently experiencing high demand. Please try again later.. Max attempts reached";

  it("iki satır biçimini de sayar, stack trace ekrana gitmez", () => {
    const t = createRetryTracker(3);
    const out = t.feed([RETRYING, "    at throwErrorIfNotOK (file:///x.js:1:1)", "  status: 503", MAXED, ""].join(NEWLINE));
    expect(out).toEqual([
      { attempt: 1, budget: 3, total: 1, totalCap: 9, status: 503, detail: "", waitMs: null, exhausted: false },
      {
        attempt: 2,
        budget: 3,
        total: 2,
        totalCap: 9,
        status: 503,
        detail: "This model is currently experiencing high demand. Please try again later",
        waitMs: null,
        exhausted: false,
      },
    ]);
  });

  it("CLI sayacı sıfırlasa da (model fallback) sayı artmaya devam eder ve bütçe dolar", () => {
    const t = createRetryTracker(3);
    t.feed(RETRYING + NEWLINE + MAXED + NEWLINE);
    // Fallback sonrası CLI yeniden "Attempt 1" diyor — kota yine düşüyor.
    const [third] = t.feed(RETRYING + NEWLINE);
    expect(third).toMatchObject({ attempt: 3, exhausted: true });
  });

  it("satır ortasından bölünen parçayı birleştirir", () => {
    const t = createRetryTracker(3);
    expect(t.feed("Attempt 1 failed with sta")).toEqual([]);
    expect(t.feed("tus 429. Retrying with backoff..." + NEWLINE)).toMatchObject([
      { attempt: 1, status: 429 },
    ]);
  });

  it("model yanıt verince art arda sayaç sıfırlanır, ilerleyen turn ölmez (25 Eylül)", () => {
    // Ölçülen olay: 503, 503, model araç çağırdı, dakikalar sonra tek 503 → turn öldü.
    const t = createRetryTracker(3);
    t.feed(RETRYING + NEWLINE + RETRYING + NEWLINE);
    t.success();
    const [third] = t.feed(RETRYING + NEWLINE);
    expect(third).toMatchObject({ attempt: 1, total: 3, exhausted: false });
  });

  it("dalgalı sağlayıcıda toplam üst sınır dolunca durur", () => {
    const t = createRetryTracker(3);
    const all = [];
    for (let i = 0; i < 4; i += 1) {
      all.push(...t.feed(RETRYING + NEWLINE + RETRYING + NEWLINE));
      t.success();
    }
    // Hiçbir an art arda 3'e ulaşmadı; 9. başarısız istekte toplam sınır doldu.
    expect(all.map((s) => s.exhausted)).toEqual([false, false, false, false, false, false, false, false]);
    const [ninth] = t.feed(RETRYING + NEWLINE);
    expect(ninth).toMatchObject({ attempt: 1, total: 9, totalCap: 9, exhausted: true });
  });

  it("ağ hatasında durum kodu yok", () => {
    const [s] = createRetryTracker(3).feed("Attempt 1 failed: fetch failed" + NEWLINE);
    expect(s).toMatchObject({ status: null, detail: "fetch failed" });
  });

  /** 29 Eylül gerçek koşumu (server.log) — 3.5-flash ücretsiz katman, dakikada 5 istek. */
  const quota = (n: number, ms: number): string =>
    [
      `Attempt ${n} failed: You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.`,
      "* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 5, model: gemini-3.5-flash",
      "Please retry in 59.146378666s.",
      `Suggested retry after 59s.. Retrying after ${ms}ms...`,
      "",
    ].join(NEWLINE);

  it("bekleme süreli 429 art arda sayılmaz, süre taşınır (29 Eylül)", () => {
    const t = createRetryTracker(3);
    const out = [...t.feed(quota(1, 6771)), ...t.feed(quota(2, 70547)), ...t.feed(quota(3, 70000))];
    expect(out.map((s) => [s.attempt, s.total, s.status, s.waitMs, s.exhausted])).toEqual([
      [0, 1, 429, 6771, false],
      [0, 2, 429, 70547, false],
      [0, 3, 429, 70000, false],
    ]);
    expect(out[0]!.detail).toMatch(/^You exceeded your current quota/);
  });

  it("bekleme süreli 429 araya girse de art arda 503 sayımı sürer", () => {
    const t = createRetryTracker(3);
    const out = [...t.feed(RETRYING + NEWLINE + quota(2, 6771)), ...t.feed(RETRYING + NEWLINE)];
    expect(out.map((s) => [s.attempt, s.waitMs])).toEqual([
      [1, null],
      [1, 6771],
      [2, null],
    ]);
  });

  it("bekleme süreli 429 toplam sınıra girer — sonsuza gitmez", () => {
    const t = createRetryTracker(3);
    const out = [];
    for (let i = 1; i <= 9; i += 1) out.push(...t.feed(quota(i, 60000)));
    expect(out.at(-1)).toMatchObject({ attempt: 0, total: 9, exhausted: true });
  });

  it("süre satırı parçalar arasında bölünse de bulunur", () => {
    const t = createRetryTracker(3);
    const text = quota(1, 6771);
    const cut = text.indexOf("Retrying after") + 5;
    expect(t.feed(text.slice(0, cut))).toEqual([]);
    expect(t.feed(text.slice(cut))).toMatchObject([{ attempt: 0, waitMs: 6771 }]);
  });

  it("süre gelmeden yeni deneme gelirse kota satırı temkinle sayılır", () => {
    const t = createRetryTracker(3);
    const out = t.feed(
      "Attempt 1 failed: You exceeded your current quota" + NEWLINE + RETRYING + NEWLINE,
    );
    expect(out.map((s) => [s.attempt, s.status, s.waitMs])).toEqual([
      [1, 429, null],
      [2, 503, null],
    ]);
  });

  it("süresiz 429 (backoff) ve 'Max attempts reached' eskisi gibi sayılır", () => {
    const t = createRetryTracker(3);
    const out = t.feed(
      "Attempt 1 failed with status 429. Retrying with backoff..." +
        NEWLINE +
        "Attempt 2 failed: You exceeded your current quota. Max attempts reached" +
        NEWLINE,
    );
    expect(out.map((s) => [s.attempt, s.status, s.waitMs])).toEqual([
      [1, 429, null],
      [2, 429, null],
    ]);
  });

  it("turn.retrying event'i şemadan geçer — attempt 0 ve waitMs ile", () => {
    const e = {
      ...base,
      actor: { kind: "agent", name: "backend" },
      type: "turn.retrying",
      payload: {
        agent: "backend",
        messageId: base.messageId,
        provider: "Google",
        attempt: 0,
        budget: 3,
        status: 429,
        detail: "You exceeded your current quota",
        waitMs: 70547,
      },
    };
    expect(() => NewRoomEvent.parse(e)).not.toThrow();
  });
});
