import { describe, expect, it } from "vitest";
import {
  MANAGED_LABEL,
  ROOM_LABEL,
  ROOM_MOUNT,
  buildCreateOptions,
  roomContainerName,
  shortRoomId,
  toDockerPath,
} from "../src/docker/container.js";

/**
 * Create seçenekleri saf üretiliyor — bu testler docker olmadan koşar.
 * Gerçek container `scripts/week1-gate.sh` içinde kaldırılıyor.
 */

const roomId = "c62b1a70-6481-40f8-8b56-62667034274d";

describe("container create seçenekleri", () => {
  it("windows yolunu bind biçimine çevirir", () => {
    expect(toDockerPath("C:\\Users\\kerem\\rooms-data\\x")).toBe("C:/Users/kerem/rooms-data/x");
    expect(toDockerPath("/home/kerem/x")).toBe("/home/kerem/x");
  });

  it("container adı oda kimliğinden türer ve sabittir", () => {
    expect(shortRoomId(roomId)).toBe("c62b1a70");
    expect(roomContainerName(roomId)).toBe("agent-rooms-room-c62b1a70");
  });

  it("tek bind: oda kökü /room'a bağlanır", () => {
    const opts = buildCreateOptions({
      roomId,
      roomRoot: "C:\\rooms\\x",
      image: "agent-rooms/room:dev",
    });
    expect(opts.HostConfig?.Binds).toEqual([`C:/rooms/x:${ROOM_MOUNT}`]);
    expect(opts.WorkingDir).toBe(ROOM_MOUNT);
    expect(opts.Image).toBe("agent-rooms/room:dev");
    expect(opts.name).toBe("agent-rooms-room-c62b1a70");
  });

  it("oda kimliği label olarak geçer — temizlik bunu filtreler", () => {
    const opts = buildCreateOptions({ roomId, roomRoot: "/r", image: "img" });
    expect(opts.Labels?.[ROOM_LABEL]).toBe(roomId);
    expect(opts.Labels?.[MANAGED_LABEL]).toBe("true");
  });

  it("kaynak sınırları konur — döngüye giren agent makineyi yemesin", () => {
    const opts = buildCreateOptions({ roomId, roomRoot: "/r", image: "img" });
    expect(opts.HostConfig?.Memory).toBe(2048 * 1024 * 1024);
    expect(opts.HostConfig?.NanoCpus).toBe(2_000_000_000);
    expect(opts.HostConfig?.PidsLimit).toBe(512);

    const custom = buildCreateOptions({
      roomId,
      roomRoot: "/r",
      image: "img",
      memoryMb: 512,
      cpus: 1,
    });
    expect(custom.HostConfig?.Memory).toBe(512 * 1024 * 1024);
    expect(custom.HostConfig?.NanoCpus).toBe(1_000_000_000);
  });
});
