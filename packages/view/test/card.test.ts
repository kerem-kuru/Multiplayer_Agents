import { describe, expect, it } from "vitest";
import { CARD_LINE_MAX, firstSentence, oneLine, summarizeTurn, toCard, toCards } from "../src/card.js";
import type { AgentView, RoomView, TurnView } from "../src/project.js";

/**
 * Hafta 7, Adım 12 — kart modeli.
 *
 * En önemli iddia: **ham çıktı kartın satırına SIZMAZ.** Tool sonucu, patch
 * metni ve terminal çıktısı oda görünümüne girmez. Kural bileşende değil bu
 * saf fonksiyonda duruyor, böylece test edilebiliyor.
 */

const ESC = String.fromCharCode(27);

function agent(over: Partial<AgentView> = {}): AgentView {
  return {
    status: "idle",
    lastError: null,
    branch: "room-abc12345/backend",
    isolationViolations: [],
    turns: [],
    queue: [],
    running: null,
    driver: null,
    interrupt: null,
    diff: { base: null, files: {}, lastSeq: 0 },
    checkpoints: [],
    comments: [],
    ...over,
  } as AgentView;
}

function turn(over: Partial<TurnView> = {}): TurnView {
  return {
    messageId: "33333333-3333-4333-8333-333333333333",
    prompt: "iş",
    reviewId: null,
    actor: "Kerem",
    startedAt: "2026-09-22T12:00:00.000Z",
    sdkSessionId: null,
    items: [],
    outcome: { kind: "running" },
    ...over,
  } as TurnView;
}

const toolItem = (tool: string, input: unknown, result?: unknown) => ({
  kind: "tool" as const,
  seq: 10,
  toolUseId: "t1",
  tool,
  input,
  truncated: false,
  result: (result ?? null) as never,
  files: [],
});

describe("durumlar", () => {
  it("boşta", () => {
    expect(toCard("backend", agent())).toMatchObject({
      status: "bosta",
      statusLabel: "boşta",
      line: "boşta",
      lineKind: "status",
    });
  });

  it("kuyrukta mesaj varsa 'sırada'", () => {
    const c = toCard(
      "backend",
      agent({ queue: [{ messageId: "m", user: { id: "u", name: "Ayse" }, text: "x" }] as never }),
    );
    expect(c.status).toBe("sirada");
    expect(c.queueLength).toBe(1);
  });

  it("durdu / çöktü / başarısız", () => {
    expect(toCard("b", agent({ status: "stopped" as never })).status).toBe("durdu");
    expect(toCard("b", agent({ status: "crashed" as never })).status).toBe("coktu");
    expect(toCard("b", agent({ status: "failed" as never })).status).toBe("basarisiz");
  });
});

describe("çalışırken: son tool ÇAĞRISI, sonucu değil", () => {
  it("Bash komutunu özetler", () => {
    const c = toCard(
      "backend",
      agent({
        status: "busy" as never,
        turns: [turn({ items: [toolItem("Bash", { command: "npm test" })] })],
      }),
    );
    expect(c.line).toBe("Bash · npm test");
    expect(c.lineKind).toBe("tool");
  });

  it("HAM TOOL SONUCU satıra SIZMAZ", () => {
    const rawOutput = "FAIL src/order.test.js\n  ● beklenmeyen hata\n    at Object.<anonymous>";
    const c = toCard(
      "backend",
      agent({
        status: "busy" as never,
        turns: [
          turn({
            items: [
              toolItem("Bash", { command: "npm test" }, { output: rawOutput, isError: true }),
            ],
          }),
        ],
      }),
    );
    expect(c.line).toBe("Bash · npm test");
    expect(c.line).not.toContain("FAIL");
    expect(c.line).not.toContain("beklenmeyen");
  });

  it("dosya düzenlemesi oda-göreli yol gösterir", () => {
    const c = toCard(
      "backend",
      agent({
        status: "busy" as never,
        turns: [turn({ items: [toolItem("Edit", { file_path: "/room/worktrees/backend/src/a.js" })] })],
      }),
    );
    expect(c.line).toContain("src/a.js");
    expect(c.line).not.toContain("/room/");
  });
});

describe("boştayken: son metnin İLK CÜMLESİ", () => {
  it("ilk cümleyi alır", () => {
    const c = toCard(
      "backend",
      agent({
        turns: [
          turn({
            outcome: { kind: "completed", subtype: "success", numTurns: 1, durationMs: 1, costUsd: 0 },
            items: [
              { kind: "text", seq: 11, text: "index.html dosyasını oluşturdum. Ayrıca stil ekledim." },
            ] as never,
          }),
        ],
      }),
    );
    expect(c.line).toBe("index.html dosyasını oluşturdum.");
    expect(c.lineKind).toBe("summary");
  });

  it("100 karakterde kırpılır", () => {
    const uzun = "a".repeat(400);
    const c = toCard(
      "backend",
      agent({
        turns: [
          turn({
            outcome: { kind: "completed", subtype: "success", numTurns: 1, durationMs: 1, costUsd: 0 },
            items: [{ kind: "text", seq: 11, text: uzun }] as never,
          }),
        ],
      }),
    );
    expect(c.line.length).toBeLessThanOrEqual(CARD_LINE_MAX);
    expect(c.line.endsWith("…")).toBe(true);
  });

  it("satır sonları ve ANSI temizlenir", () => {
    const kirli = `${ESC}[31mkirmizi${ESC}[0m metin\nikinci satir`;
    const c = toCard(
      "backend",
      agent({
        turns: [
          turn({
            outcome: { kind: "completed", subtype: "success", numTurns: 1, durationMs: 1, costUsd: 0 },
            items: [{ kind: "text", seq: 11, text: kirli }] as never,
          }),
        ],
      }),
    );
    expect(c.line).not.toContain(ESC);
    expect(c.line).not.toContain("\n");
    expect(c.line).toContain("kirmizi metin");
  });
});

describe("başarısız turn: Türkçe sebep", () => {
  it("kesildi", () => {
    const c = toCard(
      "backend",
      agent({ turns: [turn({ outcome: { kind: "failed", reason: "interrupted", error: "x" } })] }),
    );
    expect(c.line).toBe("kesildi");
  });

  it("çöktü", () => {
    const c = toCard(
      "backend",
      agent({ turns: [turn({ outcome: { kind: "failed", reason: "crashed", error: "x" } })] }),
    );
    expect(c.line).toBe("çöktü");
  });

  it("bilinmeyen sebep ham subtype basmaz", () => {
    const c = toCard(
      "backend",
      agent({ turns: [turn({ outcome: { kind: "failed", reason: "error_wat_42", error: "x" } })] }),
    );
    expect(c.line).toBe("başarısız oldu");
    expect(c.line).not.toContain("error_wat_42");
  });
});

describe("sayılar", () => {
  it("değişen dosya, açık yorum ve çakışma sayılır", () => {
    const view = {
      lastSeq: 9,
      access: [],
      baseSha: null,
      contracts: {},
      conflicts: [
        { id: "c1", kind: "path_overlap" as const, agents: ["backend", "frontend"], paths: ["x"] },
        { id: "c2", kind: "path_overlap" as const, agents: ["frontend", "security"], paths: ["y"] },
      ],
      agents: {
        backend: agent({
          diff: {
            base: null,
            lastSeq: 0,
            files: { "a.js": { status: "modified" }, "b.js": { status: "clean" } },
          } as never,
          comments: [{ status: "open" }, { status: "resolved" }] as never,
        }),
      },
    } as unknown as RoomView;

    const c = toCard("backend", view.agents.backend!, view);
    // "clean" dosya geri alinmis demek — degisen sayilmaz.
    expect(c.changedFiles).toBe(1);
    expect(c.openComments).toBe(1);
    // Yalnizca backend'in dahil oldugu cakisma.
    expect(c.conflicts).toBe(1);
  });

  it("toCards kart sayısını agents.map gibi üretir", () => {
    const view = {
      lastSeq: 0,
      access: [],
      baseSha: null,
      contracts: {},
      conflicts: [],
      agents: { frontend: agent(), backend: agent(), security: agent() },
    } as unknown as RoomView;
    expect(toCards(view).map((c) => c.name)).toEqual(["backend", "frontend", "security"]);
  });
});

describe("yardımcılar", () => {
  it("oneLine boşlukları sadeleştirir", () => {
    expect(oneLine("  a\n\n  b  ")).toBe("a b");
  });

  it("firstSentence soru işaretinde de biter", () => {
    expect(firstSentence("Bunu yapayım mı? Sonra devam ederim.")).toBe("Bunu yapayım mı?");
  });

  it("noktası olmayan metin olduğu gibi döner", () => {
    expect(firstSentence("nokta yok")).toBe("nokta yok");
  });
});

describe("Özet sekmesi: kapalı turn satırı", () => {
  it("ilk dolu satırı alır ve tek satıra indirir", () => {
    const t = turn({ prompt: "\n  api ucunu yaz\nayrıntı: şu şu" });
    expect(summarizeTurn(t).firstLine).toBe("api ucunu yaz");
  });

  it("uzun ilk satır kart sınırında kırpılır", () => {
    const t = turn({ prompt: "x".repeat(300) });
    expect(summarizeTurn(t).firstLine.length).toBe(CARD_LINE_MAX);
  });

  it("aynı dosyaya iki yazım tek dosya sayılır", () => {
    const a = { ...toolItem("Edit", { file_path: "a.js" }), files: ["a.js"] };
    const b = { ...toolItem("Write", { file_path: "a.js" }), seq: 11, files: ["a.js", "b.js"] };
    const t = turn({ items: [a, b, toolItem("Bash", { command: "ls" })] });
    expect(summarizeTurn(t).changedFiles).toBe(2);
  });
});
