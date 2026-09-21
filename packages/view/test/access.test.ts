import { beforeEach, describe, expect, it } from "vitest";
import type { StoredEvent } from "@agent-rooms/protocol";
import { project } from "../src/project.js";

/**
 * Yetki isteği projeksiyonu — Hafta 5'in borcu.
 *
 * İstekler ayrı bir tabloda DEĞİL: durum event log'dan türüyor. Bu testler
 * bunun gerçekten türediğini ölçüyor, sunucu ve DB olmadan.
 */

const ROOM = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const REQ = "44444444-4444-4444-8444-444444444444";
const AYSE = { id: "55555555-5555-4555-8555-555555555555", name: "Ayse" };
const SAHIP = { id: "66666666-6666-4666-8666-666666666666", name: "Kerem" };

let seq = 0;
const ev = (type: string, payload: Record<string, unknown>): StoredEvent =>
  ({
    seq: ++seq,
    roomId: ROOM,
    sessionId: SESSION,
    ts: "2026-09-21T20:00:00.000Z",
    actor: { kind: "human", ...AYSE },
    type,
    payload,
  }) as unknown as StoredEvent;

const requested = (note: string | null = null) =>
  ev("access.requested", { requestId: REQ, user: AYSE, role: "member", note });

const resolved = (decision: "granted" | "denied") =>
  ev("access.resolved", { requestId: REQ, decision, user: AYSE, by: SAHIP });

describe("yetki isteği projeksiyonu", () => {
  beforeEach(() => {
    seq = 0;
  });

  it("istek oda düzeyinde görünür — agent alanı olmayan event yutulmuyor", () => {
    // Eski projeksiyon `agent` alanı olmayan her event'i atlıyordu; bu event
    // türü oda düzeyinde ve o filtreden ÖNCE işlenmek zorunda.
    const v = project([requested("diff'e yorum bırakacağım")]);
    expect(v.access).toHaveLength(1);
    expect(v.access[0]!.state).toBe("pending");
    expect(v.access[0]!.user.name).toBe("Ayse");
    expect(v.access[0]!.note).toBe("diff'e yorum bırakacağım");
  });

  it("karar isteği kapatır ve kimin verdiğini saklar", () => {
    const v = project([requested(), resolved("granted")]);
    expect(v.access[0]!.state).toBe("granted");
    expect(v.access[0]!.by).toEqual(SAHIP);
  });

  it("ret de bir karardır — kayıt silinmiyor", () => {
    const v = project([requested(), resolved("denied")]);
    expect(v.access[0]!.state).toBe("denied");
  });

  it("aynı event iki kez gelirse durum değişmiyor", () => {
    const e = requested();
    const v = project([e, e, { ...e, seq: 99 } as StoredEvent]);
    expect(v.access).toHaveLength(1);
  });

  it("snapshot üzerine devam edince istekler kaybolmuyor", () => {
    const base = project([requested()]);
    const v = project([resolved("granted")], base);
    expect(v.access).toHaveLength(1);
    expect(v.access[0]!.state).toBe("granted");
  });

  it("access alanı olmayan ESKİ snapshot çökertmiyor", () => {
    // Sürüm 4'ten önceki snapshot'larda bu alan yok. Eski bir snapshot'la
    // karşılaşmak beklenen bir durum, çökme sebebi değil.
    const eski = { lastSeq: 0, agents: {} } as never;
    const v = project([requested()], eski);
    expect(v.access).toHaveLength(1);
  });

  it("karşılığı olmayan karar sessizce yutuluyor", () => {
    const v = project([resolved("granted")]);
    expect(v.access).toHaveLength(0);
  });
});
