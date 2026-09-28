import { describe, expect, it } from "vitest";
import { NewRoomEvent } from "../src/events.js";

/**
 * `contract.changed` — silinen dosyanın hash'i yok.
 *
 * 29 Eylül'e kadar `sha256` her durumda dolu isteniyordu; izleyicinin silme
 * event'i (`sha256: ""`) runner'ın kendi doğrulamasında düşüyor ve silme
 * log'a hiç girmiyordu.
 */

const event = (sha256: string, deleted: boolean) => ({
  roomId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  actor: { kind: "agent", name: "backend" },
  type: "contract.changed",
  payload: { agent: "backend", messageId: null, path: "api.md", sha256, size: 0, deleted },
});

describe("contract.changed sha256", () => {
  it("silinmiş dosyada boş sha256 geçer", () => {
    expect(NewRoomEvent.safeParse(event("", true)).success).toBe(true);
  });

  it("değişen dosyada dolu sha256 geçer", () => {
    expect(NewRoomEvent.safeParse(event("a".repeat(64), false)).success).toBe(true);
  });

  it("değişen dosyada boş sha256 geçmez", () => {
    expect(NewRoomEvent.safeParse(event("", false)).success).toBe(false);
  });

  it("silinmiş dosyada hash geçmez — iki durum karışmasın", () => {
    expect(NewRoomEvent.safeParse(event("a".repeat(64), true)).success).toBe(false);
  });
});
