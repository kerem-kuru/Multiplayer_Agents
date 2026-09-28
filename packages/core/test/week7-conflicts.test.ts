import { describe, expect, it } from "vitest";
import { project, type RoomView } from "@agent-rooms/view";
import { CONTRACTS_RACE_WINDOW_MS, detectConflicts, diffConflicts } from "../src/conflicts.js";

/**
 * Hafta 7, Adım 8 — çakışma tespiti.
 *
 * Saf fonksiyon, container yok. Ölçülen şey: aynı yolu iki agent değiştirince
 * tespit, biri geri alınca temizlenme, farklı yollarda tespit YOK, pencere
 * dışındaki sözleşme yazımında tespit YOK.
 */

const NOW = new Date("2026-09-22T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

/** Sadece bu testlerin okuduğu alanları taşıyan iskelet bir görünüm. */
function view(opts: {
  files?: Record<string, string[]>;
  clean?: Record<string, string[]>;
  /** yol -> (agent -> son yazma anı) */
  contracts?: Record<string, Record<string, string>>;
}): RoomView {
  const agents: RoomView["agents"] = {};
  const put = (agent: string, path: string, status: string) => {
    agents[agent] ??= { diff: { files: {} } } as unknown as RoomView["agents"][string];
    (agents[agent] as unknown as { diff: { files: Record<string, unknown> } }).diff.files[path] = {
      status,
    };
  };
  for (const [path, list] of Object.entries(opts.files ?? {})) {
    for (const a of list) put(a, path, "modified");
  }
  for (const [path, list] of Object.entries(opts.clean ?? {})) {
    for (const a of list) put(a, path, "clean");
  }

  const contracts: RoomView["contracts"] = {};
  for (const [path, writes] of Object.entries(opts.contracts ?? {})) {
    const last = Object.entries(writes).sort(([, a], [, b]) => a.localeCompare(b)).at(-1)!;
    contracts[path] = {
      sha256: "x",
      size: 1,
      lastAgent: last[0],
      at: last[1],
      deleted: false,
      lastWriteBy: writes,
    };
  }

  return { lastSeq: 0, agents, access: [], baseSha: null, conflicts: [], contracts };
}

describe("path_overlap", () => {
  it("iki agent aynı yolu değiştirince tespit edilir", () => {
    const c = detectConflicts(view({ files: { "src/shared.js": ["frontend", "backend"] } }), NOW);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({
      kind: "path_overlap",
      agents: ["backend", "frontend"],
      paths: ["src/shared.js"],
    });
  });

  it("farklı yollarda tespit YOK", () => {
    const c = detectConflicts(
      view({ files: { "web/a.js": ["frontend"], "api/b.js": ["backend"] } }),
      NOW,
    );
    expect(c).toEqual([]);
  });

  it("biri değişikliği geri alınca (clean) temizlenir", () => {
    const before = detectConflicts(view({ files: { "src/shared.js": ["frontend", "backend"] } }), NOW);
    const after = detectConflicts(
      view({ files: { "src/shared.js": ["frontend"] }, clean: { "src/shared.js": ["backend"] } }),
      NOW,
    );
    expect(before).toHaveLength(1);
    expect(after).toEqual([]);

    const d = diffConflicts(before, after);
    expect(d.cleared).toEqual([before[0]!.id]);
    expect(d.detected).toEqual([]);
  });

  it("aynı çift için birden çok yol TEK çakışmada toplanır", () => {
    const c = detectConflicts(
      view({ files: { "a.js": ["frontend", "backend"], "b.js": ["frontend", "backend"] } }),
      NOW,
    );
    expect(c).toHaveLength(1);
    expect(c[0]!.paths).toEqual(["a.js", "b.js"]);
  });

  it("üç agent aynı yolda tek çakışma", () => {
    const c = detectConflicts(
      view({ files: { "src/shared.js": ["frontend", "backend", "security"] } }),
      NOW,
    );
    expect(c).toHaveLength(1);
    expect(c[0]!.agents).toEqual(["backend", "frontend", "security"]);
  });
});

describe("contracts_race", () => {
  it("aynı dosyaya 60 sn içinde iki farklı agent yazınca tespit", () => {
    const c = detectConflicts(
      view({ contracts: { "api.md": { backend: ago(10_000), frontend: ago(5_000) } } }),
      NOW,
    );
    expect(c).toEqual([
      {
        id: "contracts_race|backend+frontend|api.md",
        kind: "contracts_race",
        agents: ["backend", "frontend"],
        paths: ["api.md"],
      },
    ]);
  });

  it("FARKLI dosyalara yazan iki agent yarış değil (29 Eylül'e kadar yanlışlıkla sayılıyordu)", () => {
    const c = detectConflicts(
      view({ contracts: { "api.md": { backend: ago(5_000) }, "ui.md": { frontend: ago(10_000) } } }),
      NOW,
    );
    expect(c).toEqual([]);
  });

  it("pencere DIŞINDA tespit yok", () => {
    const c = detectConflicts(
      view({
        contracts: {
          "api.md": { backend: ago(5_000), frontend: ago(CONTRACTS_RACE_WINDOW_MS + 10_000) },
        },
      }),
      NOW,
    );
    expect(c).toEqual([]);
  });

  it("aynı agent aynı dosyaya art arda yazarsa yarış değil", () => {
    const c = detectConflicts(view({ contracts: { "api.md": { backend: ago(1_000) } } }), NOW);
    expect(c).toEqual([]);
  });

  it("aynı agent kümesinin yarıştığı dosyalar TEK çakışmada", () => {
    const c = detectConflicts(
      view({
        contracts: {
          "api.md": { backend: ago(3_000), frontend: ago(2_000) },
          "db.md": { backend: ago(4_000), frontend: ago(1_000) },
        },
      }),
      NOW,
    );
    expect(c.map((x) => x.id)).toEqual(["contracts_race|backend+frontend|api.md,db.md"]);
  });

  it("üç agent aynı dosyada tek çakışma", () => {
    const c = detectConflicts(
      view({ contracts: { "api.md": { backend: ago(3_000), frontend: ago(2_000), security: ago(1_000) } } }),
      NOW,
    );
    expect(c).toHaveLength(1);
    expect(c[0]!.agents).toEqual(["backend", "frontend", "security"]);
  });
});

describe("contracts_race — event log'dan uçtan uca", () => {
  /**
   * gate:w7:agent [11], 29 Eylül 23:05 — gerçek iki event (sha256 kısaltıldı).
   * Projeksiyon yalnızca son yazanı tuttuğu sürece bu yarış görülmüyordu.
   */
  const at = (iso: string, seq: number, agent: string, sha256: string) => ({
    seq,
    roomId: "11111111-1111-4111-8111-111111111111",
    sessionId: "22222222-2222-4222-8222-222222222222",
    ts: iso,
    actor: { kind: "agent" as const, name: agent },
    type: "contract.changed" as const,
    payload: { agent, messageId: null, path: "api.md", sha256, size: 33, deleted: false },
  });

  it("backend ve frontend 5,6 sn arayla aynı api.md'ye yazdı → yarış", () => {
    const v = project([
      at("2026-09-28T23:05:26.258Z", 73, "backend", "8fd7a3ef"),
      at("2026-09-28T23:05:31.909Z", 84, "frontend", "914cb5a6"),
    ] as unknown as Parameters<typeof project>[0]);

    expect(v.contracts["api.md"]).toMatchObject({
      lastAgent: "frontend",
      lastWriteBy: { backend: "2026-09-28T23:05:26.258Z", frontend: "2026-09-28T23:05:31.909Z" },
    });
    const c = detectConflicts(v, new Date("2026-09-28T23:05:32.000Z"));
    expect(c.map((x) => x.id)).toEqual(["contracts_race|backend+frontend|api.md"]);

    // Pencere geçince bir sonraki ölçümde kalkar (conflict.cleared).
    expect(detectConflicts(v, new Date("2026-09-28T23:06:40.000Z"))).toEqual([]);
  });
});

describe("conflictId deterministik", () => {
  it("aynı çakışma iki ölçümde aynı id'yi alır", () => {
    const a = detectConflicts(view({ files: { "x.js": ["frontend", "backend"] } }), NOW);
    const b = detectConflicts(view({ files: { "x.js": ["backend", "frontend"] } }), NOW);
    expect(a[0]!.id).toBe(b[0]!.id);
    // Ikinci olcumde "yeni" sayilmamali.
    expect(diffConflicts(a, b).detected).toEqual([]);
  });
});
