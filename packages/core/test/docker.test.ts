import { describe, expect, it } from "vitest";
import { parseRoomConfig } from "../src/config/loadRoomConfig.js";
import {
  ROOM_MOUNT,
  buildRunArgs,
  roomContainerName,
  shortRoomId,
  toDockerPath,
} from "../src/docker/container.js";
import {
  ANCESTOR_MODE,
  agentUser,
  ancestorDirs,
  ownershipPlan,
  provisionCommands,
} from "../src/docker/isolation.js";
import { mountPlan } from "../src/room/layout.js";

const roomId = "c62b1a70-6481-40f8-8b56-62667034274d";

const minimal = `
version: 1
name: Test odası
agents:
  - name: frontend
    systemPrompt: "frontend"
    workspace: worktrees/frontend
    writable: [worktrees/frontend, contracts]
  - name: backend
    systemPrompt: "backend"
    workspace: worktrees/backend
    writable: [worktrees/backend, contracts]
`;

const { config } = parseRoomConfig(minimal);

describe("container argümanları", () => {
  it("windows yolunu docker biçimine çevirir", () => {
    expect(toDockerPath("C:\\Users\\kerem\\rooms-data\\x")).toBe("C:/Users/kerem/rooms-data/x");
    expect(toDockerPath("/home/kerem/x")).toBe("/home/kerem/x");
  });

  it("container adı oda kimliğinden türer ve sabittir", () => {
    expect(shortRoomId(roomId)).toBe("c62b1a70");
    expect(roomContainerName(roomId)).toBe("agent-rooms-room-c62b1a70");
  });

  it("tek mount: oda kökü /room'a bağlanır", () => {
    const args = buildRunArgs({ roomId, roomRoot: "C:\\rooms\\x", image: "agent-rooms/room:dev" });
    expect(args).toContain("-v");
    expect(args).toContain(`C:/rooms/x:${ROOM_MOUNT}`);
    // Agent başına mount YOK — izolasyon container içinde POSIX ile.
    expect(args.filter((a) => a === "-v")).toHaveLength(1);
  });

  it("oda kimliği label olarak geçer — artık container'ları bulunabilsin", () => {
    const args = buildRunArgs({ roomId, roomRoot: "/r", image: "img" });
    expect(args).toContain(`agent-rooms.room=${roomId}`);
    expect(args).toContain("--pids-limit");
    expect(args[args.length - 1]).toBe("img");
  });
});

describe("izolasyon planı", () => {
  it("agent adı 32 karakteri aşarsa reddeder", () => {
    expect(agentUser("frontend")).toBe("agent-frontend");
    expect(() => agentUser("a".repeat(30))).toThrow(/çok uzun/);
  });

  it("tek yazıcılı klasör sahibine, ortak klasör gruba açılır", () => {
    const plan = ownershipPlan(config);
    const fe = plan.find((p) => p.dir === "worktrees/frontend")!;
    expect(fe.owner).toBe("agent-frontend");
    expect(fe.mode).toBe("2750");

    const contracts = plan.find((p) => p.dir === "contracts")!;
    expect(contracts.owner).toBe("root");
    expect(contracts.mode).toBe("2770");
    expect(contracts.writers).toEqual(["frontend", "backend"]);

    // Defteri kimse doğrudan yazmaz — Hafta 8'de API yazacak.
    const journal = plan.find((p) => p.dir === "journal")!;
    expect(journal.writers).toEqual([]);
    expect(journal.mode).toBe("2750");
  });

  it("sahiplik planı mount planıyla aynı gerçeği söyler", () => {
    const plan = ownershipPlan(config);
    for (const mp of mountPlan(config)) {
      for (const dir of mp.readWrite) {
        expect(plan.find((p) => p.dir === dir)!.writers).toContain(mp.agent);
      }
      for (const dir of mp.readOnly) {
        expect(plan.find((p) => p.dir === dir)!.writers).not.toContain(mp.agent);
      }
    }
  });

  it("provision komutları grup, kullanıcı ve sahiplik sırasıyla gelir", () => {
    const cmds = provisionCommands(config);
    expect(cmds[0]).toEqual(["groupadd", "-f", "room"]);
    expect(cmds.some((c) => c[0] === "useradd" && c.includes("agent-backend"))).toBe(true);
    expect(
      cmds.some((c) => c[0] === "chown" && c.includes(`agent-frontend:room`)),
    ).toBe(true);
    // Kullanıcılar sahiplikten ÖNCE açılmalı, yoksa chown bilinmeyen kullanıcıya çarpar.
    const lastUseradd = cmds.findLastIndex((c) => c[0] === "useradd");
    const firstChown = cmds.findIndex((c) => c[0] === "chown");
    expect(lastUseradd).toBeLessThan(firstChown);
  });

  it("ara dizinler kilitlenir — kardeşini taşıyamasın", () => {
    // Silme/yeniden adlandırma yetkisi ÜST dizinden gelir. worktrees/ 0777
    // kalsaydı frontend, backend/ klasörünü mv ile taşıyabilirdi.
    expect(ancestorDirs(config)).toEqual(["", "worktrees"]);

    const cmds = provisionCommands(config);
    const chmods = cmds.filter((c) => c[0] === "chmod");
    expect(chmods).toContainEqual(["chmod", ANCESTOR_MODE, "/room"]);
    expect(chmods).toContainEqual(["chmod", ANCESTOR_MODE, "/room/worktrees"]);

    // Ara dizinlerde -R KULLANILMAZ: oda kökünde recursive chown alttaki
    // agent sahipliklerini silerdi.
    const rootChown = cmds.find((c) => c[0] === "chown" && c[c.length - 1] === "/room")!;
    expect(rootChown).not.toContain("-R");
    expect(rootChown).toContain("root:room");
  });

  it("üçüncü agent eklemek planı kendiliğinden büyütür", () => {
    const { config: three } = parseRoomConfig(
      `${minimal}  - name: security\n    systemPrompt: "security"\n    workspace: worktrees/security\n    writable: [journal]\n`,
    );
    const plan = ownershipPlan(three);
    expect(plan.map((p) => p.dir)).toContain("worktrees/security");
    // journal artık tek yazıcılı: security'nin olur.
    expect(plan.find((p) => p.dir === "journal")!.owner).toBe("agent-security");
  });
});
