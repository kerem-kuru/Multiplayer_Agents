import { describe, expect, it, vi } from "vitest";
import { InProcessEventBus } from "../src/bus.js";
import type { StoredEvent } from "@agent-rooms/protocol";

const event = (seq: number): StoredEvent =>
  ({
    seq,
    roomId: "11111111-1111-4111-8111-111111111111",
    sessionId: "22222222-2222-4222-8222-222222222222",
    ts: "2026-09-17T10:00:00.000Z",
    actor: { kind: "system" },
    type: "debug.note",
    payload: { text: `n${seq}` },
  }) as StoredEvent;

const SID = "22222222-2222-4222-8222-222222222222";

describe("event bus", () => {
  it("iki abone de aynı yayını alır", () => {
    const bus = new InProcessEventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe(SID, a);
    bus.subscribe(SID, b);
    bus.publish(SID, event(1));
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it("abonelikten çıkan artık almaz", () => {
    const bus = new InProcessEventBus();
    const a = vi.fn();
    const off = bus.subscribe(SID, a);
    off();
    bus.publish(SID, event(1));
    expect(a).not.toHaveBeenCalled();
    expect(bus.subscriberCount(SID)).toBe(0);
  });

  it("bir abonenin hatası diğerini etkilemez", () => {
    // Tek bozuk bağlantı bütün izleyicileri düşürmemeli.
    const errors: unknown[] = [];
    const bus = new InProcessEventBus((e) => errors.push(e));
    bus.subscribe(SID, () => {
      throw new Error("bozuk abone");
    });
    const sağlam = vi.fn();
    bus.subscribe(SID, sağlam);
    bus.publish(SID, event(1));
    expect(sağlam).toHaveBeenCalledOnce();
    expect(errors).toHaveLength(1);
  });

  it("başka oturumun abonesi etkilenmez", () => {
    const bus = new InProcessEventBus();
    const other = vi.fn();
    bus.subscribe("33333333-3333-4333-8333-333333333333", other);
    bus.publish(SID, event(1));
    expect(other).not.toHaveBeenCalled();
  });

  it("aynı unsubscribe iki kez çağrılırsa başkasının aboneliğini silmez", () => {
    const bus = new InProcessEventBus();
    const off = bus.subscribe(SID, vi.fn());
    off();
    bus.subscribe(SID, vi.fn());
    off(); // ikinci çağrı
    expect(bus.subscriberCount(SID)).toBe(1);
  });
});
