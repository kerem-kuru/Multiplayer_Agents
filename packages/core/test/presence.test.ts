import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PRESENCE_DEBOUNCE_MS,
  joinPresence,
  leavePresence,
  listPresence,
  presenceConnectionCount,
  resetPresence,
  setViewing,
  subscribePresence,
} from "../src/presence.js";

/**
 * Presence bellekte durur ve event log'a YAZILMAZ — bu testlerin hiçbirinde
 * DB yok, olması da gerekmiyor. Yazılsaydı burada bir pool lazım olurdu.
 */

const ROOM = "oda-1";

afterEach(() => {
  resetPresence();
  vi.useRealTimers();
});

describe("presence", () => {
  it("bağlantı = varlık", () => {
    joinPresence(ROOM, "c1", { userId: "u1", name: "kerem" });
    expect(listPresence(ROOM)).toHaveLength(1);
    leavePresence(ROOM, "c1");
    expect(listPresence(ROOM)).toHaveLength(0);
  });

  it("aynı kullanıcının iki sekmesi TEK satır", () => {
    joinPresence(ROOM, "c1", { userId: "u1", name: "kerem" });
    joinPresence(ROOM, "c2", { userId: "u1", name: "kerem" });
    expect(listPresence(ROOM)).toHaveLength(1);
    expect(presenceConnectionCount()).toBe(2);

    // Bir sekme kapanınca kişi HÂLÂ odada.
    leavePresence(ROOM, "c1");
    expect(listPresence(ROOM)).toHaveLength(1);
  });

  it("viewing en son güncellenen sekmeden gelir", () => {
    joinPresence(ROOM, "c1", { userId: "u1", name: "kerem" });
    joinPresence(ROOM, "c2", { userId: "u1", name: "kerem" });
    setViewing(ROOM, "u1", "backend");
    expect(listPresence(ROOM)[0]!.viewing).toBe("backend");
  });

  it("iki kişi, ikisi de listede; sıralama giriş anına göre", () => {
    joinPresence(ROOM, "c1", { userId: "u1", name: "kerem" });
    joinPresence(ROOM, "c2", { userId: "u2", name: "ayse" });
    const people = listPresence(ROOM);
    expect(people.map((p) => p.name)).toEqual(["kerem", "ayse"]);
  });

  it("odalar birbirinden bağımsız", () => {
    joinPresence("a", "c1", { userId: "u1", name: "kerem" });
    joinPresence("b", "c2", { userId: "u2", name: "ayse" });
    expect(listPresence("a")).toHaveLength(1);
    expect(listPresence("b")).toHaveLength(1);
  });

  it("yayın 250 ms debounce ediliyor — art arda değişiklik tek frame", () => {
    vi.useFakeTimers();
    const frames: number[] = [];
    const stop = subscribePresence(ROOM, (people) => frames.push(people.length));

    joinPresence(ROOM, "c1", { userId: "u1", name: "kerem" });
    joinPresence(ROOM, "c2", { userId: "u2", name: "ayse" });
    setViewing(ROOM, "u1", "backend");
    expect(frames).toHaveLength(0); // henüz yayın yok

    vi.advanceTimersByTime(PRESENCE_DEBOUNCE_MS + 10);
    expect(frames).toEqual([2]); // üç değişiklik, TEK frame

    stop();
    joinPresence(ROOM, "c3", { userId: "u3", name: "mehmet" });
    vi.advanceTimersByTime(PRESENCE_DEBOUNCE_MS + 10);
    expect(frames).toEqual([2]); // abonelik bitti, yeni frame yok
  });

  it("bir dinleyicinin hatası diğerini etkilemiyor", () => {
    vi.useFakeTimers();
    const seen: number[] = [];
    subscribePresence(ROOM, () => {
      throw new Error("patladım");
    });
    subscribePresence(ROOM, (people) => seen.push(people.length));

    joinPresence(ROOM, "c1", { userId: "u1", name: "kerem" });
    vi.advanceTimersByTime(PRESENCE_DEBOUNCE_MS + 10);
    expect(seen).toEqual([1]);
  });

  it("olmayan bağlantıyı bırakmak sessiz", () => {
    expect(() => leavePresence(ROOM, "yok")).not.toThrow();
  });
});
