import { describe, expect, it } from "vitest";
import type { RoomView } from "@agent-rooms/view";
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
  contracts?: Record<string, { agent: string; at: string }>;
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
  for (const [path, c] of Object.entries(opts.contracts ?? {})) {
    contracts[path] = { sha256: "x", size: 1, lastAgent: c.agent, at: c.at, deleted: false };
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
  it("60 sn içinde iki farklı agent yazınca tespit", () => {
    const c = detectConflicts(
      view({
        contracts: {
          "api.md": { agent: "backend", at: ago(5_000) },
          "ui.md": { agent: "frontend", at: ago(10_000) },
        },
      }),
      NOW,
    );
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ kind: "contracts_race", agents: ["backend", "frontend"] });
  });

  it("pencere DIŞINDA tespit yok", () => {
    const c = detectConflicts(
      view({
        contracts: {
          "api.md": { agent: "backend", at: ago(5_000) },
          "ui.md": { agent: "frontend", at: ago(CONTRACTS_RACE_WINDOW_MS + 10_000) },
        },
      }),
      NOW,
    );
    expect(c).toEqual([]);
  });

  it("aynı agent iki dosya yazarsa yarış değil", () => {
    const c = detectConflicts(
      view({
        contracts: {
          "api.md": { agent: "backend", at: ago(1_000) },
          "db.md": { agent: "backend", at: ago(2_000) },
        },
      }),
      NOW,
    );
    expect(c).toEqual([]);
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
