import { describe, expect, it } from "vitest";
import type { StoredEvent } from "@agent-rooms/protocol";
import { project } from "../src/project.js";

/**
 * Hafta 7 — ODA DÜZEYİ event'ler projeksiyondan geçiyor mu.
 *
 * Bu dosya bir hatadan doğdu. `room.repo_initialized`, `conflict.detected` ve
 * `conflict.cleared` event'lerinin `agent` alanı YOK; projeksiyonda
 * `if (!agentName) continue` satırı onlara hiç sıra gelmemesine yol açıyordu.
 * Sonuç sessizdi: çakışma uyarısı oda görünümünde HİÇ görünmeyecekti.
 *
 * `detectConflicts`in kendi birim testleri bunu yakalayamazdı — orada
 * görünüm elle kuruluyor, event'lerden ÜRETİLMİYOR. Bu testler event'ten
 * ekrana giden yolun tamamını geçiriyor.
 */

const ROOM = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";

let seq = 0;
const ev = (type: string, payload: unknown): StoredEvent =>
  ({
    seq: (seq += 1),
    roomId: ROOM,
    sessionId: SESSION,
    ts: "2026-09-22T12:00:00.000Z",
    type,
    actor: { kind: "system" },
    payload,
  }) as unknown as StoredEvent;

describe("oda düzeyi event'ler agent filtresine takılmıyor", () => {
  it("room.repo_initialized taban commit'i taşır", () => {
    seq = 0;
    const view = project([
      ev("room.repo_initialized", { source: "empty", baseRef: "main", baseSha: "a".repeat(40) }),
    ]);
    expect(view.baseSha).toBe("a".repeat(40));
  });

  it("agent.workspace_ready branch'i agent'a yazar", () => {
    seq = 0;
    const view = project([
      ev("agent.workspace_ready", {
        agent: "backend",
        branch: "room-abc12345/backend",
        baseSha: "a".repeat(40),
      }),
    ]);
    expect(view.agents.backend?.branch).toBe("room-abc12345/backend");
  });

  it("conflict.detected açık çakışma listesine girer", () => {
    seq = 0;
    const view = project([
      ev("conflict.detected", {
        conflictId: "path_overlap|backend+frontend|src/shared.js",
        kind: "path_overlap",
        agents: ["backend", "frontend"],
        paths: ["src/shared.js"],
      }),
    ]);
    expect(view.conflicts).toHaveLength(1);
    expect(view.conflicts[0]).toMatchObject({
      kind: "path_overlap",
      agents: ["backend", "frontend"],
      paths: ["src/shared.js"],
    });
  });

  it("conflict.cleared listeden düşürür", () => {
    seq = 0;
    const id = "path_overlap|backend+frontend|src/shared.js";
    const view = project([
      ev("conflict.detected", {
        conflictId: id,
        kind: "path_overlap",
        agents: ["backend", "frontend"],
        paths: ["src/shared.js"],
      }),
      ev("conflict.cleared", { conflictId: id }),
    ]);
    expect(view.conflicts).toEqual([]);
  });

  it("aynı çakışma iki kez gelirse tek satır kalır", () => {
    seq = 0;
    const p = {
      conflictId: "path_overlap|backend+frontend|x",
      kind: "path_overlap",
      agents: ["backend", "frontend"],
      paths: ["x"],
    };
    const view = project([ev("conflict.detected", p), ev("conflict.detected", p)]);
    expect(view.conflicts).toHaveLength(1);
  });
});

describe("agent düzeyi Hafta 7 event'leri", () => {
  it("contract.changed sözleşme haritasına yazar, içerik taşımaz", () => {
    seq = 0;
    const view = project([
      ev("contract.changed", {
        agent: "backend",
        messageId: null,
        path: "api.md",
        sha256: "b".repeat(64),
        size: 42,
        deleted: false,
      }),
    ]);
    expect(view.contracts["api.md"]).toMatchObject({
      sha256: "b".repeat(64),
      size: 42,
      lastAgent: "backend",
      deleted: false,
    });
    expect(JSON.stringify(view.contracts)).not.toContain("content");
  });

  it("isolation.violation agent'a yazılır ve son 5 tutulur", () => {
    seq = 0;
    const events = [];
    for (let i = 0; i < 7; i += 1) {
      events.push(
        ev("isolation.violation", {
          agent: "frontend",
          path: "/room/worktrees/frontend",
          expected: "agent-frontend:wtr-frontend 750",
          actual: `agent-frontend:wtr-frontend 77${i}`,
          fixed: true,
        }),
      );
    }
    const view = project(events);
    const list = view.agents.frontend?.isolationViolations ?? [];
    expect(list).toHaveLength(5);
    // En eskiler düşmüş, en yeni durmalı.
    expect(list[list.length - 1]?.actual).toContain("776");
  });
});
