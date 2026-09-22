import { describe, expect, it } from "vitest";
import { RoomConfig } from "@agent-rooms/protocol";
import {
  AGENT_UID_BASE,
  CONTRACTS_GID,
  CONTRACTS_GROUP,
  INTEGRATOR,
  INTEGRATOR_ID,
  assignUids,
  planRoomFs,
} from "../src/room-fs.js";

/**
 * Hafta 7, Adım 2 — izin planı.
 *
 * Plan saf olduğu için container açmadan test edilir. Buradaki her iddia
 * `gate:w7`de container içinde `stat` ile bir kez daha doğrulanacak; bu testler
 * hatanın planda mı uygulamada mı olduğunu ayırt etmek için var.
 */

function agent(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    systemPrompt: "rol",
    workspace: `worktrees/${name}`,
    writable: [`worktrees/${name}`, "contracts"],
    ...extra,
  };
}

function cfg(agents: Array<Record<string, unknown>>): RoomConfig {
  return RoomConfig.parse({ version: 1, name: "oda", agents });
}

function plan(agents: Array<Record<string, unknown>>, existing: Record<string, number> = {}) {
  const c = cfg(agents);
  const names = c.agents.map((a) => a.name);
  return planRoomFs(c, assignUids(names, existing));
}

const dir = (p: ReturnType<typeof plan>, path: string) => p.dirs.find((d) => d.path === path);
const user = (p: ReturnType<typeof plan>, name: string) => p.users.find((u) => u.name === name);

describe("iki agent", () => {
  const p = plan([agent("frontend"), agent("backend")]);

  it("uid'ler 10001'den başlar", () => {
    expect(user(p, "agent-frontend")?.uid).toBe(AGENT_UID_BASE + 1);
    expect(user(p, "agent-backend")?.uid).toBe(AGENT_UID_BASE + 2);
  });

  it("worktree'ler 0750 ve kendi okuyucu grubunda", () => {
    expect(dir(p, "/room/worktrees/frontend")).toEqual({
      path: "/room/worktrees/frontend",
      owner: "agent-frontend",
      group: "wtr-frontend",
      mode: "0750",
    });
  });

  it("contracts setgid ve ortak grupta", () => {
    expect(dir(p, "/room/contracts")).toMatchObject({ group: CONTRACTS_GROUP, mode: "2775" });
  });

  it("journal'a hiçbir agent yazamaz", () => {
    expect(dir(p, "/room/journal")).toMatchObject({ owner: "root", group: "root", mode: "0755" });
  });

  it("merkez depo integrator'a ait", () => {
    expect(dir(p, "/room/repo.git")).toMatchObject({ owner: INTEGRATOR, group: INTEGRATOR });
  });

  it("integrator hiçbir agent grubunda değil, agent'lar onun grubunda değil", () => {
    expect(user(p, INTEGRATOR)).toMatchObject({ uid: INTEGRATOR_ID, groups: [] });
    for (const u of p.users) {
      if (u.name === INTEGRATOR) continue;
      expect(u.groups).not.toContain(INTEGRATOR);
    }
  });

  it("readable boşken kimse diğerinin grubunda değil", () => {
    expect(user(p, "agent-frontend")?.groups).toEqual([CONTRACTS_GROUP]);
    expect(user(p, "agent-backend")?.groups).toEqual([CONTRACTS_GROUP]);
  });

  it("contracts grubu sabit gid", () => {
    expect(p.groups.find((g) => g.name === CONTRACTS_GROUP)?.gid).toBe(CONTRACTS_GID);
  });

  it("üst klasör alt klasörden önce gelir", () => {
    const i = p.dirs.findIndex((d) => d.path === "/room/worktrees");
    const j = p.dirs.findIndex((d) => d.path === "/room/worktrees/frontend");
    expect(i).toBeLessThan(j);
  });
});

describe("üç agent + readable: worktrees/*", () => {
  const p = plan([
    agent("frontend"),
    agent("backend"),
    agent("security", { readable: ["worktrees/*"], writable: ["worktrees/security", "contracts"] }),
  ]);

  it("security diğer ikisinin okuyucu grubunda", () => {
    const g = user(p, "agent-security")?.groups ?? [];
    expect(g).toContain("wtr-frontend");
    expect(g).toContain("wtr-backend");
  });

  it("security kendi grubunu tekrar almaz", () => {
    expect(user(p, "agent-security")?.groups).not.toContain("wtr-security");
  });

  it("okuma tek yönlü: frontend security'yi göremez", () => {
    expect(user(p, "agent-frontend")?.groups).not.toContain("wtr-security");
  });

  it("wtr gid'i uid'den türer", () => {
    const uid = user(p, "agent-security")?.uid as number;
    expect(p.groups.find((g) => g.name === "wtr-security")?.gid).toBe(20000 + (uid - AGENT_UID_BASE));
  });
});

describe("agent sonradan eklenince uid'ler korunur", () => {
  it("var olanlar sabit kalır, yeni olan sıradakini alır", () => {
    const existing = { frontend: 10001, backend: 10002 };
    const uids = assignUids(["frontend", "backend", "security"], existing);
    expect(uids).toEqual({ frontend: 10001, backend: 10002, security: 10003 });
  });

  it("YAML yeniden sıralansa bile uid değişmez", () => {
    const existing = { frontend: 10001, backend: 10002 };
    const uids = assignUids(["backend", "frontend"], existing);
    expect(uids.frontend).toBe(10001);
    expect(uids.backend).toBe(10002);
  });

  it("çıkarılan agent'ın uid'i yeniden kullanılmaz", () => {
    // backend odadan çıkarıldı ama klasörleri hâlâ 10002'ye ait olabilir.
    const existing = { frontend: 10001, backend: 10002 };
    const uids = assignUids(["frontend", "security"], existing);
    expect(uids.security).toBe(10003);
  });

  it("uid atanmamış agent sessizce geçmez", () => {
    const c = cfg([agent("frontend")]);
    expect(() => planRoomFs(c, {})).toThrow(/uid atanmamış/);
  });
});

describe("writable'da contracts yoksa gruba girmez", () => {
  it("yalnızca kendi worktree'si yazılabilir", () => {
    const p = plan([agent("frontend", { writable: ["worktrees/frontend"] }), agent("backend")]);
    expect(user(p, "agent-frontend")?.groups).not.toContain(CONTRACTS_GROUP);
    expect(user(p, "agent-backend")?.groups).toContain(CONTRACTS_GROUP);
  });
});
