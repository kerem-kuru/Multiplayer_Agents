import { afterEach, describe, expect, it } from "vitest";
import { RoomConfig } from "../src/room-config.js";
import { isInside, normalizePath } from "../src/paths.js";

/**
 * Hafta 7, Adım 1 — rol config'inin yazma/okuma kuralları.
 *
 * Her kural için bir GEÇERLİ ve bir GEÇERSİZ örnek. Kuralın kendisi kadar
 * hata mesajının doğru olduğu da kontrol ediliyor: bu mesajlar YAML yazan
 * insana kuralı öğretmek için var, "invalid input" demek yetmiyor.
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

function room(extra: Record<string, unknown> = {}, agents = [agent("frontend"), agent("backend")]) {
  return { version: 1, name: "oda", agents, ...extra };
}

/** Doğrulama hatalarının mesajlarını tek metinde toplar. */
function errors(input: unknown): string {
  const r = RoomConfig.safeParse(input);
  return r.success ? "" : r.error.issues.map((i) => i.message).join(" | ");
}

const ROOT_KEY = "ROOMS_SOURCE_ROOT";
const originalRoot = process.env[ROOT_KEY];
afterEach(() => {
  if (originalRoot === undefined) delete process.env[ROOT_KEY];
  else process.env[ROOT_KEY] = originalRoot;
});

describe("workspace tam olarak worktrees/<ad>", () => {
  it("geçerli", () => {
    expect(RoomConfig.safeParse(room()).success).toBe(true);
  });

  it("geçersiz: başka bir yol", () => {
    const bad = room({}, [agent("frontend", { workspace: "apps/frontend" }), agent("backend")]);
    expect(errors(bad)).toContain('workspace tam olarak "worktrees/frontend" olmalı');
  });
});

describe("writable yalnızca kendi worktree'si ve contracts", () => {
  it("geçerli: ikisi birden", () => {
    expect(RoomConfig.safeParse(room()).success).toBe(true);
  });

  it("geçersiz: başka agent'ın worktree'si — mesaj kuralı anlatır", () => {
    const bad = room({}, [
      agent("frontend", { writable: ["worktrees/frontend", "worktrees/backend"] }),
      agent("backend"),
    ]);
    expect(errors(bad)).toContain("her worktree'nin tek yazarı sahibidir");
    expect(errors(bad)).toContain("frontend");
  });

  it("geçersiz: journal artık yazılabilir değil", () => {
    // Hafta 7'den önce journal writable olabiliyordu; şema daraldı.
    const bad = room({}, [agent("frontend", { writable: ["worktrees/frontend", "journal"] }), agent("backend")]);
    expect(errors(bad)).toContain('"journal" yazılabilir olamaz');
  });
});

describe("readable yalnızca başka worktree'ler", () => {
  it("geçerli: adıyla ve yıldızla", () => {
    const ok = room({}, [
      agent("frontend", { readable: ["worktrees/backend"] }),
      agent("backend", { readable: ["worktrees/*"] }),
    ]);
    expect(RoomConfig.safeParse(ok).success).toBe(true);
  });

  it("geçersiz: var olmayan agent", () => {
    const bad = room({}, [agent("frontend", { readable: ["worktrees/devops"] }), agent("backend")]);
    expect(errors(bad)).toContain('"devops" adında bir agent yok');
  });

  it("geçersiz: kendi worktree'si", () => {
    const bad = room({}, [agent("frontend", { readable: ["worktrees/frontend"] }), agent("backend")]);
    expect(errors(bad)).toContain("kendi worktree'si");
  });

  it("geçersiz: worktree dışı bir yol", () => {
    const bad = room({}, [agent("frontend", { readable: ["contracts"] }), agent("backend")]);
    expect(errors(bad)).toContain('yalnızca "worktrees/<agent>" veya "worktrees/*"');
  });
});

describe("repo kaynağı", () => {
  it("varsayılan empty", () => {
    const r = RoomConfig.parse(room());
    expect(r.repo).toEqual({ kind: "empty" });
  });

  it("git kaynağı geçerli", () => {
    const r = RoomConfig.parse(room({ repo: { kind: "git", url: "https://example.com/a.git" } }));
    expect(r.repo).toEqual({ kind: "git", url: "https://example.com/a.git", ref: "HEAD" });
  });

  it("local: ROOMS_SOURCE_ROOT tanımsızsa reddedilir", () => {
    delete process.env[ROOT_KEY];
    const bad = room({ repo: { kind: "local", path: "/srv/repos/a" } });
    expect(errors(bad)).toContain("ROOMS_SOURCE_ROOT tanımlı değil");
  });

  it("local: kök altındaysa geçerli", () => {
    process.env[ROOT_KEY] = "/srv/repos";
    const ok = room({ repo: { kind: "local", path: "/srv/repos/a" } });
    expect(RoomConfig.safeParse(ok).success).toBe(true);
  });

  it("local: kök dışındaysa reddedilir", () => {
    process.env[ROOT_KEY] = "/srv/repos";
    const bad = room({ repo: { kind: "local", path: "/etc/passwd" } });
    expect(errors(bad)).toContain("altında değil");
  });

  it("local: .. ile kaçış reddedilir", () => {
    process.env[ROOT_KEY] = "/srv/repos";
    const bad = room({ repo: { kind: "local", path: "/srv/repos/../../etc" } });
    expect(errors(bad)).toContain("altında değil");
  });
});

describe("contracts worktrees altında olamaz", () => {
  it("geçersiz", () => {
    const bad = room({ contractsDir: "worktrees/ortak" });
    expect(errors(bad)).toContain("contracts klasörü worktrees altında olamaz");
  });
});

describe("yol yardımcıları", () => {
  it("normalizePath ayraçları ve segmentleri düzeltir", () => {
    expect(normalizePath(String.raw`C:\srv\repos\a`)).toBe("c:/srv/repos/a");
    expect(normalizePath("/srv//repos/./a/")).toBe("/srv/repos/a");
    expect(normalizePath("/srv/repos/b/../a")).toBe("/srv/repos/a");
  });

  it("isInside segment sınırına bakar", () => {
    expect(isInside("/srv/repos", "/srv/repos/a")).toBe(true);
    expect(isInside("/srv/repos", "/srv/repos")).toBe(true);
    // "repos-gizli" ile başlıyor ama ALTINDA değil.
    expect(isInside("/srv/repos", "/srv/repos-gizli/a")).toBe(false);
  });

  it("isInside boş kökte her zaman hayır der", () => {
    expect(isInside("", "/herhangi")).toBe(false);
  });
});
