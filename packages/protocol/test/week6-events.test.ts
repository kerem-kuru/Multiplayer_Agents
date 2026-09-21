import { describe, expect, it } from "vitest";
import { ALL_EVENT_TYPES, parseEvent } from "../src/events.js";
import { FileDiff } from "../src/diff.js";
import { RunnerCommand } from "../src/runner-protocol.js";

const roomId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const messageId = "33333333-3333-4333-8333-333333333333";
const commentId = "44444444-4444-4444-8444-444444444444";
const reviewId = "55555555-5555-4555-8555-555555555555";
const base = {
  seq: 7,
  roomId,
  sessionId,
  ts: "2026-09-21T10:00:00.000Z",
  actor: { kind: "system" },
} as const;

const user = { id: "66666666-6666-4666-8666-666666666666", name: "Ayse" };

const file = {
  path: "src/order.js",
  oldPath: null,
  status: "modified",
  patch: "@@ -1 +1 @@\n-a\n+b\n",
  additions: 1,
  deletions: 1,
  blobHash: "a".repeat(40),
  truncated: false,
  collapsedByDefault: false,
};

describe("Hafta 6 event'leri", () => {
  it("yeni tipler katalogda", () => {
    for (const t of [
      "checkpoint.created",
      "diff.updated",
      "comment.on_line",
      "review.submitted",
      "comment.resolved",
      "comment.reopened",
    ]) {
      expect(ALL_EVENT_TYPES).toContain(t);
    }
  });

  it("diff.updated en az bir dosya ister", () => {
    const ok = parseEvent({
      ...base,
      type: "diff.updated",
      payload: { agent: "backend", messageId, baseCheckpointId: "cp_abcdef123456", files: [file] },
    });
    expect(ok.type).toBe("diff.updated");

    // Boş bir diff.updated hiçbir şey söylemez ve log'u gürültüyle doldurur.
    expect(() =>
      parseEvent({
        ...base,
        type: "diff.updated",
        payload: { agent: "backend", messageId: null, baseCheckpointId: "cp_abcdef123456", files: [] },
      }),
    ).toThrow();
  });

  it("checkpoint kimliği biçimi doğrulanıyor", () => {
    expect(() =>
      parseEvent({
        ...base,
        type: "diff.updated",
        payload: { agent: "backend", messageId: null, baseCheckpointId: "rastgele", files: [file] },
      }),
    ).toThrow();
  });

  it("checkpoint.created turn checkpoint'inde messageId dolu, by null", () => {
    const e = parseEvent({
      ...base,
      type: "checkpoint.created",
      payload: {
        agent: "backend",
        checkpointId: "cp_abcdef123456",
        kind: "turn",
        label: "Ayse'nin mesajindan sonra",
        commitSha: "b".repeat(40),
        treeSha: "c".repeat(40),
        messageId,
        by: null,
        becomesBase: false,
      },
    });
    expect(e.type).toBe("checkpoint.created");
  });

  it("comment.on_line çapayı satır metniyle birlikte taşır", () => {
    const e = parseEvent({
      ...base,
      actor: { kind: "human", ...user },
      type: "comment.on_line",
      payload: {
        agent: "backend",
        commentId,
        reviewId,
        author: user,
        path: "src/order.js",
        side: "new",
        line: 12,
        lineText: "function processOrder(o) {",
        body: "bunu böl",
        baseCheckpointId: "cp_abcdef123456",
        diffSeq: 5,
      },
    });
    expect(e.payload).toMatchObject({ side: "new", line: 12 });
  });

  it("review.submitted en az bir yorum kimliği ister", () => {
    expect(() =>
      parseEvent({
        ...base,
        type: "review.submitted",
        payload: { agent: "backend", reviewId, author: user, commentIds: [], messageId },
      }),
    ).toThrow();
  });

  it("message.queued reviewId'siz de geçerli", () => {
    const duz = parseEvent({
      ...base,
      actor: { kind: "human", ...user },
      type: "message.queued",
      payload: { agent: "backend", messageId, text: "merhaba", user },
    });
    expect(duz.type).toBe("message.queued");

    const inceleme = parseEvent({
      ...base,
      actor: { kind: "human", ...user },
      type: "message.queued",
      payload: { agent: "backend", messageId, text: "…", user, reviewId },
    });
    expect((inceleme.payload as { reviewId?: string }).reviewId).toBe(reviewId);
  });

  it("FileDiff clean dosyada patch taşımaz", () => {
    const clean = FileDiff.parse({
      ...file,
      status: "clean",
      patch: null,
      blobHash: null,
      additions: 0,
      deletions: 0,
    });
    expect(clean.status).toBe("clean");
  });
});

describe("runner protokolü", () => {
  it("set_base komutu taban ve ağaç taşır", () => {
    const cmd = RunnerCommand.parse({
      kind: "set_base",
      checkpointId: "cp_abcdef123456",
      treeSha: "d".repeat(40),
    });
    expect(cmd.kind).toBe("set_base");
  });

  it("eksik alanlı set_base reddedilir", () => {
    expect(() => RunnerCommand.parse({ kind: "set_base", checkpointId: "cp_x" })).toThrow();
  });
});
