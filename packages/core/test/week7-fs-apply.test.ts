import { describe, expect, it } from "vitest";
import { RoomConfig } from "@agent-rooms/protocol";
import { assignUids, diffFsStat, fsPlanScript, normalizeMode, planRoomFs } from "../src/room-fs.js";
import { buildCreateOptions, roomMemoryMb, roomVolumeName } from "../src/docker/container.js";
import { ownerOfWorkdir } from "../src/diff.js";

/**
 * Hafta 7, Adım 3 + 5 — volume, plan uygulayıcı, agent kimliği.
 *
 * Buradaki her şey Docker OLMADAN test edilir: üretilen script metni,
 * container create seçenekleri ve stat karşılaştırması. Gerçek container'daki
 * doğrulama `gate:w7`nin işi; bu testler hatanın plan üretiminde mi yoksa
 * uygulamada mı olduğunu ayırmak için var.
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

const cfg = (agents: Array<Record<string, unknown>>): RoomConfig =>
  RoomConfig.parse({ version: 1, name: "oda", agents });

function planOf(agents: Array<Record<string, unknown>>) {
  const c = cfg(agents);
  return planRoomFs(c, assignUids(c.agents.map((a) => a.name)));
}

describe("fsPlanScript", () => {
  const script = fsPlanScript(planOf([agent("frontend"), agent("backend")]));

  it("hata olursa durur", () => {
    expect(script.split("\n")[0]).toBe("set -eu");
  });

  it("grup yaratma idempotent", () => {
    expect(script).toContain("groupadd -f -g 19999 rooms-contracts");
  });

  it("kullanıcı zaten varsa useradd çalışmaz", () => {
    expect(script).toMatch(/id -u agent-frontend >\/dev\/null 2>&1 \|\| useradd/);
  });

  it("ek gruplar her seferinde yeniden yazılır (-G, -aG değil)", () => {
    // -aG olsaydı YAML'dan silinen bir readable satırı kullanıcıda kalırdı.
    expect(script).toContain('usermod -G "rooms-contracts" agent-frontend');
    expect(script).not.toContain("usermod -aG");
  });

  it("chmod chown'dan SONRA gelir — chown setgid bitini düşürür", () => {
    const chown = script.indexOf("chown root:rooms-contracts /room/contracts");
    const chmod = script.indexOf("chmod 2775 /room/contracts");
    expect(chown).toBeGreaterThan(-1);
    expect(chmod).toBeGreaterThan(chown);
  });

  it("worktree 0750 uygulanıyor", () => {
    expect(script).toContain("chmod 0750 /room/worktrees/frontend");
  });
});

describe("diffFsStat", () => {
  const plan = planOf([agent("frontend")]);

  it("plana uyan çıktıda sapma yok", () => {
    const out = plan.dirs
      .map((d) => `${d.path} ${d.owner} ${d.group} ${normalizeMode(d.mode)}`)
      .join("\n");
    expect(diffFsStat(plan, out)).toEqual([]);
  });

  it("gevşetilmiş izni yakalar", () => {
    const out = plan.dirs
      .map((d) =>
        d.path === "/room/worktrees/frontend"
          ? `${d.path} agent-frontend wtr-frontend 777`
          : `${d.path} ${d.owner} ${d.group} ${normalizeMode(d.mode)}`,
      )
      .join("\n");
    const drift = diffFsStat(plan, out);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({
      path: "/room/worktrees/frontend",
      expected: "agent-frontend:wtr-frontend 750",
      actual: "agent-frontend:wtr-frontend 777",
    });
  });

  it("eksik klasörü yakalar", () => {
    const drift = diffFsStat(plan, "");
    expect(drift.length).toBe(plan.dirs.length);
    expect(drift.every((d) => d.actual === "yok")).toBe(true);
  });

  it("normalizeMode baştaki sıfırı atar", () => {
    expect(normalizeMode("0750")).toBe("750");
    expect(normalizeMode("2775")).toBe("2775");
  });
});

describe("oda container'ı volume kullanır", () => {
  const roomId = "11111111-1111-4111-8111-111111111111";
  const opts = buildCreateOptions({ roomId, image: "img", agentCount: 2 });

  it("bind mount YOK", () => {
    expect(opts.HostConfig?.Binds).toBeUndefined();
  });

  it("named volume /room'a bağlanıyor", () => {
    expect(opts.HostConfig?.Mounts).toEqual([
      { Type: "volume", Source: `room-${roomId}`, Target: "/room" },
    ]);
  });

  it("volume adı tam uuid taşır — kısa hali çakışabilirdi", () => {
    expect(roomVolumeName(roomId)).toBe(`room-${roomId}`);
  });

  it("bellek agent sayısından gelir, tavan 8 GB", () => {
    expect(roomMemoryMb(1)).toBe(2048);
    expect(roomMemoryMb(3)).toBe(6144);
    expect(roomMemoryMb(9)).toBe(8192);
    expect(opts.HostConfig?.Memory).toBe(4096 * 1024 * 1024);
  });
});

describe("gitkit deponun sahibiyle koşar", () => {
  it("worktree yolundan agent kullanıcısı türer", () => {
    expect(ownerOfWorkdir("/room/worktrees/frontend")).toBe("agent-frontend");
    expect(ownerOfWorkdir("/room/worktrees/backend/")).toBe("agent-backend");
  });

  it("worktree olmayan yolda sessizce root'a düşmez", () => {
    expect(() => ownerOfWorkdir("/room/repo.git")).toThrow(/beklenen biçimde değil/);
    expect(() => ownerOfWorkdir("/room/worktrees/a/b")).toThrow();
  });
});
