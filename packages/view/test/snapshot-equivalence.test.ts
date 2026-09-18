import { describe, expect, it } from "vitest";
import type { StoredEvent } from "@agent-rooms/protocol";
import { SNAPSHOT_VERSION, project } from "../src/project.js";

/**
 * SNAPSHOT DOĞRULUK TESTİ — Hafta 4'ün en önemli birim testi.
 *
 * `project(tüm event'ler)` ile `project(sonraki, snapshot.state)` DERİN EŞİT
 * olmalı. Eşit değilse hata snapshot'ta değil projeksiyondadır: saf veya
 * deterministik değildir. O durumda snapshot'ı değil projeksiyonu düzelt.
 */

const ROOM = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";

let seq = 0;
const ev = (type: string, payload: Record<string, unknown>): StoredEvent =>
  ({
    seq: ++seq,
    roomId: ROOM,
    sessionId: SESSION,
    ts: "2026-09-18T10:00:00.000Z",
    type,
    actor: { kind: "agent", name: "backend" },
    payload,
  }) as unknown as StoredEvent;

/** Üç turn'lük gerçekçi bir akış: turn'ler sınırın iki yanına düşsün. */
function buildEvents(): StoredEvent[] {
  seq = 0;
  const out: StoredEvent[] = [];
  for (const [i, mid] of ["m-1", "m-2", "m-3"].entries()) {
    if (i === 0) out.push(ev("agent.starting", { agent: "backend" }));
    if (i === 0) out.push(ev("agent.ready", { agent: "backend", runnerPid: 8 }));
    out.push(ev("message.received", { agent: "backend", messageId: mid, text: `görev ${i}` }));
    out.push(ev("turn.started", { agent: "backend", messageId: mid, sdkSessionId: `sdk-${i}` }));
    out.push(
      ev("tool.call", {
        agent: "backend",
        messageId: mid,
        toolUseId: `call-${i}`,
        tool: "Write",
        input: { file_path: `/room/worktrees/backend/f${i}.js` },
      }),
    );
    out.push(ev("file.changed", { agent: "backend", messageId: mid, path: `worktrees/backend/f${i}.js`, tool: "Write" }));
    out.push(
      ev("tool.result", {
        agent: "backend",
        messageId: mid,
        toolUseId: `call-${i}`,
        output: "tamam",
        isError: false,
        truncated: false,
      }),
    );
    out.push(ev("agent.text", { agent: "backend", messageId: mid, text: `bitti ${i}` }));
    out.push(
      ev("turn.completed", {
        agent: "backend",
        messageId: mid,
        subtype: "success",
        numTurns: 2,
        durationMs: 1000 + i,
        costUsd: 0,
      }),
    );
  }
  return out;
}

describe("snapshot eşdeğerliği", () => {
  const events = buildEvents();
  const full = project(events);

  it("sürüm sabiti var", () => {
    expect(SNAPSHOT_VERSION).toBeGreaterThanOrEqual(1);
  });

  it("her kesme noktasında snapshot + sonrası = tam replay", () => {
    // Turn ORTASINDA kesmek en kritik durum: yarım turn snapshot'a giriyor.
    for (let cut = 1; cut < events.length; cut++) {
      const snapshot = project(events.slice(0, cut));
      const incremental = project(events.slice(cut), snapshot);
      expect(incremental, `kesme noktası ${cut}`).toEqual(full);
    }
  });

  it("snapshot state'i JSON turu sonrası da aynı sonucu veriyor", () => {
    // Gerçekte snapshot JSONB olarak DB'ye gidip geri geliyor.
    const cut = 12;
    const snapshot = JSON.parse(JSON.stringify(project(events.slice(0, cut))));
    expect(project(events.slice(cut), snapshot)).toEqual(full);
  });

  it("snapshot'ın kapsadığı event tekrar gelirse sonuç değişmiyor", () => {
    const cut = 15;
    const snapshot = project(events.slice(0, cut));
    // Kesişimli aralık: snapshot'ın içindeki event'ler yeniden veriliyor.
    expect(project(events.slice(cut - 5), snapshot)).toEqual(full);
  });

  it("temel state DEĞİŞTİRİLMİYOR (saflık)", () => {
    const snapshot = project(events.slice(0, 10));
    const before = JSON.stringify(snapshot);
    project(events.slice(10), snapshot);
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it("aynı girdi iki kez → aynı çıktı (determinizm)", () => {
    expect(project(events)).toEqual(project(events));
  });
});
