import { describe, expect, it } from "vitest";
import type { StoredEvent } from "@agent-rooms/protocol";
import { project } from "../src/project.js";

/**
 * Projeksiyon saf olduğu için burada ne sunucu ne tarayıcı gerekiyor.
 * Dokümanın istediği altı senaryo + idempotanlık.
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
    ts: "2026-09-17T10:00:00.000Z",
    actor: actor ?? { kind: "agent", name: "backend" },
    type,
    payload,
  }) as unknown as StoredEvent;

const reset = () => {
  seq = 0;
};

const fullTurn = (): StoredEvent[] => {
  reset();
  return [
    ev("agent.starting", { agent: "backend", resumeSessionId: null }, { kind: "system" }),
    ev("agent.ready", { agent: "backend", runnerPid: 8 }, { kind: "system" }),
    ev("message.received", { agent: "backend", messageId: MID, text: "hello.js yaz" }, {
      kind: "human",
      id: "u1",
      name: "Kerem",
    }),
    ev("turn.started", { agent: "backend", messageId: MID, sdkSessionId: "s1", model: "m", tools: [] }),
    ev("agent.text", { agent: "backend", messageId: MID, text: "yazıyorum" }),
    ev("tool.call", {
      agent: "backend",
      messageId: MID,
      toolUseId: "t1",
      tool: "Write",
      input: { file_path: "hello.js" },
      truncated: false,
    }),
    ev("file.changed", { agent: "backend", messageId: MID, path: "worktrees/backend/hello.js", tool: "Write" }),
    ev("tool.result", {
      agent: "backend",
      messageId: MID,
      toolUseId: "t1",
      isError: false,
      output: "ok",
      truncated: false,
    }),
    ev("turn.completed", {
      agent: "backend",
      messageId: MID,
      subtype: "success",
      numTurns: 2,
      durationMs: 1200,
      costUsd: 0.01,
    }),
  ];
};

describe("projeksiyon", () => {
  it("tam bir başarılı turn", () => {
    const v = project(fullTurn());
    const a = v.agents.backend!;
    expect(a.status).toBe("idle");
    expect(a.turns).toHaveLength(1);
    const t = a.turns[0]!;
    expect(t.prompt).toBe("hello.js yaz");
    expect(t.actor).toBe("Kerem");
    expect(t.sdkSessionId).toBe("s1");
    expect(t.outcome).toMatchObject({ kind: "completed", subtype: "success", costUsd: 0.01 });
    const tool = t.items.find((i) => i.kind === "tool")!;
    expect(tool.kind === "tool" && tool.tool).toBe("Write");
    expect(tool.kind === "tool" && tool.result?.output).toBe("ok");
    // file.changed turn'ün son tool item'ına bağlanır.
    expect(tool.kind === "tool" && tool.files).toEqual(["worktrees/backend/hello.js"]);
  });

  it("yarım turn running kalır", () => {
    const v = project(fullTurn().slice(0, 6));
    const t = v.agents.backend!.turns[0]!;
    expect(t.outcome).toEqual({ kind: "running" });
    expect(v.agents.backend!.status).toBe("busy");
  });

  it("turn.failed", () => {
    reset();
    const v = project([
      ev("message.received", { agent: "backend", messageId: MID, text: "x" }),
      ev("turn.failed", { agent: "backend", messageId: MID, reason: "crash", error: "runner öldü" }),
    ]);
    expect(v.agents.backend!.turns[0]!.outcome).toMatchObject({ kind: "failed", reason: "crash" });
    expect(v.agents.backend!.status).toBe("idle");
  });

  it("eşleşen tool.call'u olmayan tool.result DÜŞÜRÜLMEZ", () => {
    reset();
    const v = project([
      ev("message.received", { agent: "backend", messageId: MID, text: "x" }),
      ev("tool.result", {
        agent: "backend",
        messageId: MID,
        toolUseId: "yetim",
        isError: true,
        output: "hata",
        truncated: false,
      }),
    ]);
    const items = v.agents.backend!.turns[0]!.items;
    expect(items).toHaveLength(1);
    expect(items[0]!.kind === "tool" && items[0]!.tool).toBe("unknown");
    expect(items[0]!.kind === "tool" && items[0]!.result?.isError).toBe(true);
  });

  it("aynı event iki kez verilirse sonuç değişmez", () => {
    const events = fullTurn();
    const once = project(events);
    const twice = project([...events, ...events]);
    expect(twice).toEqual(once);
  });

  it("sırası bozuk gelen event'ler seq'e göre düzeltilir", () => {
    const events = fullTurn();
    const shuffled = [...events].reverse();
    expect(project(shuffled)).toEqual(project(events));
  });

  it("bilinmeyen event tipi UI'ı çökertmez", () => {
    reset();
    const v = project([
      ev("message.received", { agent: "backend", messageId: MID, text: "x" }),
      ev("gelecekte.eklenecek", { agent: "backend", messageId: MID, foo: 1 }),
    ]);
    expect(v.agents.backend!.turns).toHaveLength(1);
  });

  it("reddedilen tool görünür kalır", () => {
    reset();
    const v = project([
      ev("message.received", { agent: "backend", messageId: MID, text: "x" }),
      ev("tool.denied", { agent: "backend", messageId: MID, tool: "Bash", reason: "kapalı" }),
    ]);
    const item = v.agents.backend!.turns[0]!.items[0]!;
    expect(item.kind).toBe("denied");
    expect(item.kind === "denied" && item.tool).toBe("Bash");
  });

  it("agent sayısı sabit değil — kaç agent varsa o kadar anahtar", () => {
    reset();
    const v = project([
      ev("agent.ready", { agent: "frontend", runnerPid: 1 }, { kind: "system" }),
      ev("agent.ready", { agent: "backend", runnerPid: 2 }, { kind: "system" }),
      ev("agent.ready", { agent: "security", runnerPid: 3 }, { kind: "system" }),
    ]);
    expect(Object.keys(v.agents).sort()).toEqual(["backend", "frontend", "security"]);
  });

  // --- Hafta 5: kuyruk, sürücü, kesme -------------------------------------

  const AYSE = { kind: "human", id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", name: "Ayse" };
  const ALI = { kind: "human", id: "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb", name: "Ali" };
  const M2 = "44444444-4444-4444-8444-444444444444";

  it("kuyruk: queued sırayla girer, received kuyruktan çıkarır", () => {
    reset();
    const v = project([
      ev("message.queued", { agent: "backend", messageId: MID, text: "bir", user: { id: AYSE.id, name: AYSE.name } }, AYSE),
      ev("message.queued", { agent: "backend", messageId: M2, text: "iki", user: { id: ALI.id, name: ALI.name } }, ALI),
    ]);
    const a = v.agents.backend!;
    expect(a.queue.map((q) => q.user.name)).toEqual(["Ayse", "Ali"]);
    expect(a.running).toBe(null);

    const v2 = project([
      ev("message.received", { agent: "backend", messageId: MID, text: "bir" }, AYSE),
    ], v);
    const b = v2.agents.backend!;
    // Kuyruktan çıktı ve koşuyor: kim yazdıysa o görünüyor.
    expect(b.queue.map((q) => q.messageId)).toEqual([M2]);
    expect(b.running).toEqual({ messageId: MID, user: { id: AYSE.id, name: "Ayse" } });
  });

  it("iptal edilen mesaj kuyruktan çıkar ve running olmaz", () => {
    reset();
    const v = project([
      ev("message.queued", { agent: "backend", messageId: MID, text: "bir", user: { id: AYSE.id, name: AYSE.name } }, AYSE),
      ev("message.cancelled", { agent: "backend", messageId: MID, by: { id: AYSE.id, name: AYSE.name }, reason: "user" }, AYSE),
    ]);
    expect(v.agents.backend!.queue).toHaveLength(0);
    expect(v.agents.backend!.running).toBe(null);
  });

  it("aynı queued event iki kez gelirse kuyruk iki satır olmaz", () => {
    reset();
    const one = ev("message.queued", { agent: "backend", messageId: MID, text: "bir", user: { id: AYSE.id, name: AYSE.name } }, AYSE);
    expect(project([one, { ...one }]).agents.backend!.queue).toHaveLength(1);
  });

  it("sürücü: claim → handoff → release", () => {
    reset();
    const claimed = project([
      ev("driver.claimed", { agent: "backend", user: { id: AYSE.id, name: AYSE.name } }, AYSE),
    ]);
    expect(claimed.agents.backend!.driver?.name).toBe("Ayse");

    const handed = project([
      ev("driver.handed_off", { agent: "backend", from: { id: AYSE.id, name: AYSE.name }, to: { id: ALI.id, name: ALI.name } }, AYSE),
    ], claimed);
    expect(handed.agents.backend!.driver?.name).toBe("Ali");

    const released = project([
      ev("driver.released", { agent: "backend", user: { id: ALI.id, name: ALI.name }, reason: "manual" }, ALI),
    ], handed);
    expect(released.agents.backend!.driver).toBe(null);
  });

  it("kesme: requested dolu, applied temizler", () => {
    reset();
    const requested = project([
      ev("message.received", { agent: "backend", messageId: MID, text: "uzun is" }, AYSE),
      ev("interrupt.requested", { agent: "backend", messageId: MID, by: { id: AYSE.id, name: AYSE.name } }, AYSE),
    ]);
    // "Kesme kuyruğa alındı" durumu: istek var, uygulanma yok.
    expect(requested.agents.backend!.interrupt?.requestedBy.name).toBe("Ayse");

    const applied = project([
      ev("interrupt.applied", { agent: "backend", messageId: MID, mode: "abort" }, { kind: "system" }),
    ], requested);
    expect(applied.agents.backend!.interrupt).toBe(null);
  });

  it("turn kapanınca running boşalır", () => {
    reset();
    const v = project([
      ev("message.received", { agent: "backend", messageId: MID, text: "is" }, AYSE),
      ev("turn.failed", { agent: "backend", messageId: MID, reason: "interrupted", error: "kesildi" }, { kind: "system" }),
    ]);
    expect(v.agents.backend!.running).toBe(null);
    expect(v.agents.backend!.turns[0]!.outcome).toMatchObject({ reason: "interrupted" });
  });

  it("çökme durumu willRestart'a göre ayrışır", () => {
    reset();
    const crashed = project([
      ev("agent.crashed", { agent: "backend", exitCode: 137, error: "e", willRestart: true, restartCount: 1 }, { kind: "system" }),
    ]);
    expect(crashed.agents.backend!.status).toBe("crashed");
    reset();
    const failed = project([
      ev("agent.crashed", { agent: "backend", exitCode: 1, error: "e", willRestart: false, restartCount: 3 }, { kind: "system" }),
    ]);
    expect(failed.agents.backend!.status).toBe("failed");
  });
});
