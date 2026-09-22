import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NewRoomEvent } from "@agent-rooms/protocol";
import { ContractsWatcher } from "../src/contracts.js";

/**
 * Hafta 7, Adım 7 — `contracts/` takibi.
 *
 * Gerçek dosya sistemiyle, geçici klasörde. Ölçülen şey: ilk tarama taban
 * kuruyor mu, değişiklik yakalanıyor mu, içerik event'e SIZMIYOR mu.
 */

const ROOM = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";

let dir: string;
let events: NewRoomEvent[];
let watcher: ContractsWatcher;

const write = async (rel: string, body: string): Promise<void> => {
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body);
};

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "contracts-"));
  events = [];
  watcher = new ContractsWatcher({
    root: dir,
    roomId: ROOM,
    sessionId: SESSION,
    agent: "backend",
    emit: (e) => events.push(e),
  });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

/** Aynı mtime'a düşmesin diye: damga (boyut, mtime) ile karşılaştırılıyor. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 12));

describe("ilk tarama taban kurar", () => {
  it("agent başlamadan önce var olan dosyalar yayımlanmaz", async () => {
    await write("api.md", "v1\n");
    await watcher.scan(null);
    expect(events).toEqual([]);
  });
});

describe("değişiklik yakalanır", () => {
  it("yeni dosya contract.changed üretir", async () => {
    await watcher.scan(null);
    await write("api.md", "v1\n");
    await watcher.scan("33333333-3333-4333-8333-333333333333");

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("contract.changed");
    expect(events[0]!.payload).toMatchObject({
      agent: "backend",
      path: "api.md",
      deleted: false,
      size: 3,
    });
  });

  it("içerik değişince yayımlanır", async () => {
    await write("api.md", "v1\n");
    await watcher.scan(null);
    await tick();
    await write("api.md", "v2 daha uzun\n");
    await watcher.scan(null);

    expect(events).toHaveLength(1);
    expect((events[0]!.payload as { path: string }).path).toBe("api.md");
  });

  it("dosya silinince deleted: true", async () => {
    await write("api.md", "v1\n");
    await watcher.scan(null);
    await fs.rm(path.join(dir, "api.md"));
    await watcher.scan(null);

    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ path: "api.md", deleted: true, size: 0 });
  });

  it("alt klasör göreli yolla görünür", async () => {
    await watcher.scan(null);
    await write("v1/orders.md", "x\n");
    await watcher.scan(null);
    expect((events[0]!.payload as { path: string }).path).toBe("v1/orders.md");
  });

  it("değişmeyen dosya tekrar yayımlanmaz", async () => {
    await write("api.md", "v1\n");
    await watcher.scan(null);
    await watcher.scan(null);
    await watcher.scan(null);
    expect(events).toEqual([]);
  });
});

describe("içerik event'e GİRMEZ", () => {
  it("payload yalnızca hash ve boyut taşır", async () => {
    await watcher.scan(null);
    await write("api.md", "GIZLI-SOZLESME-METNI\n");
    await watcher.scan(null);

    const payload = events[0]!.payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      "agent",
      "deleted",
      "messageId",
      "path",
      "sha256",
      "size",
    ]);
    expect(JSON.stringify(payload)).not.toContain("GIZLI");
    expect(payload.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("onToolPath", () => {
  it("contracts dışındaki yolu yok sayar", async () => {
    await watcher.scan(null);
    await write("api.md", "v1\n");
    // Worktree'deki bir dosya: tarama TETİKLENMEMELİ.
    await watcher.onToolPath("/room/worktrees/backend/src/order.js", null);
    expect(events).toEqual([]);
  });

  it("contracts altındaki yolda tarama yapar", async () => {
    await watcher.scan(null);
    await write("api.md", "v1\n");
    await watcher.onToolPath(path.join(dir, "api.md"), null);
    expect(events).toHaveLength(1);
  });
});
