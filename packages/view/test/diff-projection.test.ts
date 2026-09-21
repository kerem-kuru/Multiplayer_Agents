import { describe, expect, it } from "vitest";
import type { StoredEvent } from "@agent-rooms/protocol";
import { project } from "../src/project.js";
import { anchorOf, lineAt, parsePatch } from "../src/patch.js";

/**
 * Hafta 6 projeksiyonu. Saf fonksiyon olduğu için ne sunucu ne tarayıcı
 * gerekiyor — dokümanın istediği beş senaryo + çapanın üç geçişi.
 */

const ROOM = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const MID = "33333333-3333-4333-8333-333333333333";
const CID = "44444444-4444-4444-8444-444444444444";
const RID = "55555555-5555-4555-8555-555555555555";
const AYSE = { id: "66666666-6666-4666-8666-666666666666", name: "Ayse" };
const BASE = "cp_aaaaaaaaaaaa";

let seq = 0;
const ev = (type: string, payload: Record<string, unknown>, actor?: unknown): StoredEvent =>
  ({
    seq: ++seq,
    roomId: ROOM,
    sessionId: SESSION,
    ts: new Date(Date.UTC(2026, 8, 21, 10, 0, seq)).toISOString(),
    actor: actor ?? { kind: "agent", name: "backend" },
    type,
    payload,
  }) as unknown as StoredEvent;

const reset = (): void => {
  seq = 0;
};

const file = (over: Record<string, unknown> = {}) => ({
  path: "src/order.js",
  oldPath: null,
  status: "modified",
  patch: null,
  additions: 1,
  deletions: 0,
  blobHash: "a".repeat(40),
  truncated: false,
  collapsedByDefault: false,
  ...over,
});

/** Üç satırlık bir dosyanın ikinci satırına ekleme yapan gerçekçi bir patch. */
const PATCH_V1 = [
  "diff --git a/src/order.js b/src/order.js",
  "index 111..222 100644",
  "--- a/src/order.js",
  "+++ b/src/order.js",
  "@@ -1,3 +1,4 @@",
  " function processOrder(o) {",
  "+  const x = 1;",
  "   return o;",
  " }",
  "",
].join("\n");

const baseline = () =>
  ev("checkpoint.created", {
    agent: "backend",
    checkpointId: BASE,
    kind: "baseline",
    label: "taban",
    commitSha: "b".repeat(40),
    treeSha: "c".repeat(40),
    messageId: null,
    by: null,
    becomesBase: true,
  });

const diffUpdated = (files: unknown[]) =>
  ev("diff.updated", {
    agent: "backend",
    messageId: MID,
    baseCheckpointId: BASE,
    files,
  });

const comment = (over: Record<string, unknown> = {}) =>
  ev(
    "comment.on_line",
    {
      agent: "backend",
      commentId: CID,
      reviewId: RID,
      author: AYSE,
      path: "src/order.js",
      side: "new",
      line: 2,
      lineText: "  const x = 1;",
      body: "bunu böl",
      baseCheckpointId: BASE,
      diffSeq: 2,
      ...over,
    },
    { kind: "human", ...AYSE },
  );

describe("diff projeksiyonu", () => {
  it("dosya ekleme ve güncelleme dosyayı üzerine yazar", () => {
    reset();
    const view = project([
      baseline(),
      diffUpdated([file({ additions: 1 })]),
      diffUpdated([file({ additions: 7, blobHash: "d".repeat(40) })]),
    ]);
    const agent = view.agents.backend!;

    expect(Object.keys(agent.diff.files)).toEqual(["src/order.js"]);
    expect(agent.diff.files["src/order.js"]!.additions).toBe(7);
    expect(agent.diff.base).toMatchObject({ checkpointId: BASE, kind: "baseline" });
    expect(agent.diff.lastSeq).toBe(3);
  });

  it("clean gelen dosya listeden SİLİNİR", () => {
    reset();
    const view = project([
      baseline(),
      diffUpdated([file(), file({ path: "package.json" })]),
      diffUpdated([file({ status: "clean", patch: null, blobHash: null })]),
    ]);

    expect(Object.keys(view.agents.backend!.diff.files)).toEqual(["package.json"]);
  });

  it("yeni taban diff'i sıfırlar ve tabanı günceller", () => {
    reset();
    const view = project([
      baseline(),
      diffUpdated([file()]),
      ev("checkpoint.created", {
        agent: "backend",
        checkpointId: "cp_bbbbbbbbbbbb",
        kind: "manual",
        label: "öğle arası",
        commitSha: "e".repeat(40),
        treeSha: "f".repeat(40),
        messageId: null,
        by: AYSE,
        becomesBase: true,
      }),
    ]);
    const agent = view.agents.backend!;

    expect(agent.diff.files).toEqual({});
    expect(agent.diff.base).toMatchObject({ checkpointId: "cp_bbbbbbbbbbbb", kind: "manual" });
    // En yeni checkpoint başta.
    expect(agent.checkpoints[0]?.checkpointId).toBe("cp_bbbbbbbbbbbb");
    expect(agent.checkpoints[0]?.by).toEqual(AYSE);
  });

  it("turn checkpoint'i tabanı kaydırmaz", () => {
    reset();
    const view = project([
      baseline(),
      diffUpdated([file()]),
      ev("checkpoint.created", {
        agent: "backend",
        checkpointId: "cp_cccccccccccc",
        kind: "turn",
        label: "turn sonu",
        commitSha: "e".repeat(40),
        treeSha: "f".repeat(40),
        messageId: MID,
        by: null,
        becomesBase: false,
      }),
    ]);
    const agent = view.agents.backend!;

    expect(agent.diff.base?.checkpointId).toBe(BASE);
    expect(Object.keys(agent.diff.files)).toEqual(["src/order.js"]);
  });

  it("aynı event iki kez gelirse checkpoint listesi ikiye katlanmaz", () => {
    reset();
    const cp = baseline();
    const view = project([cp, cp]);
    expect(view.agents.backend!.checkpoints).toHaveLength(1);
  });
});

describe("yorum çapası", () => {
  it("yazıldığı anda current", () => {
    reset();
    const view = project([baseline(), diffUpdated([file({ patch: PATCH_V1 })]), comment()]);
    const c = view.agents.backend!.comments[0]!;

    expect(c).toMatchObject({ anchor: "current", currentLine: 2, resolved: false });
    expect(c.author).toEqual(AYSE);
  });

  it("satır kayarsa moved ve yeni satırı taşır", () => {
    reset();
    const moved = [
      "@@ -1,3 +1,5 @@",
      "+// başlık",
      " function processOrder(o) {",
      "+  const x = 1;",
      "   return o;",
      " }",
      "",
    ].join("\n");

    const view = project([
      baseline(),
      diffUpdated([file({ patch: PATCH_V1 })]),
      comment(),
      diffUpdated([file({ patch: moved, blobHash: "d".repeat(40) })]),
    ]);
    const c = view.agents.backend!.comments[0]!;

    expect(c.anchor).toBe("moved");
    expect(c.currentLine).toBe(3);
  });

  it("satır değişirse outdated", () => {
    reset();
    const changed = [
      "@@ -1,3 +1,4 @@",
      " function processOrder(o) {",
      "+  const y = 2;",
      "   return o;",
      " }",
      "",
    ].join("\n");

    const view = project([
      baseline(),
      diffUpdated([file({ patch: PATCH_V1 })]),
      comment(),
      diffUpdated([file({ patch: changed, blobHash: "d".repeat(40) })]),
    ]);
    const c = view.agents.backend!.comments[0]!;

    expect(c.anchor).toBe("outdated");
    expect(c.currentLine).toBeNull();
  });

  it("aynı metin iki kez geçiyorsa TAHMİN YAPMAZ — outdated", () => {
    reset();
    /**
     * Yorumun yazıldığı satırda ARTIK BAŞKA bir metin var ve aranan metin
     * dosyada İKİ yerde geçiyor. İki aday arasında seçim yapmak yanlış
     * satıra yapışmanın kibar hâli olurdu.
     */
    const twice = [
      "@@ -1,3 +1,6 @@",
      " function processOrder(o) {",
      "+  // başlık",
      "+  const x = 1;",
      "+  const x = 1;",
      "   return o;",
      " }",
      "",
    ].join("\n");

    const view = project([
      baseline(),
      diffUpdated([file({ patch: PATCH_V1 })]),
      comment(),
      diffUpdated([file({ patch: twice, blobHash: "d".repeat(40) })]),
    ]);

    expect(view.agents.backend!.comments[0]!.anchor).toBe("outdated");
  });

  it("dosya diff'ten çıkarsa outdated", () => {
    reset();
    const view = project([
      baseline(),
      diffUpdated([file({ patch: PATCH_V1 })]),
      comment(),
      diffUpdated([file({ status: "clean", patch: null, blobHash: null })]),
    ]);

    expect(view.agents.backend!.comments[0]!.anchor).toBe("outdated");
  });

  it("çözme ve yeniden açma insan kararı", () => {
    reset();
    const view = project([
      baseline(),
      diffUpdated([file({ patch: PATCH_V1 })]),
      comment(),
      ev("comment.resolved", { agent: "backend", commentId: CID, by: AYSE }),
    ]);
    expect(view.agents.backend!.comments[0]!.resolved).toBe(true);

    const view2 = project([
      baseline(),
      diffUpdated([file({ patch: PATCH_V1 })]),
      comment(),
      ev("comment.resolved", { agent: "backend", commentId: CID, by: AYSE }),
      ev("comment.reopened", { agent: "backend", commentId: CID, by: AYSE }),
    ]);
    expect(view2.agents.backend!.comments[0]!.resolved).toBe(false);
  });

  it("aynı yorum iki kez gelirse tekrarlanmaz", () => {
    reset();
    const c = comment();
    const view = project([baseline(), diffUpdated([file({ patch: PATCH_V1 })]), c, c]);
    expect(view.agents.backend!.comments).toHaveLength(1);
  });
});

describe("patch ayrıştırıcı", () => {
  it("iki taraflı numaralandırma yapar", () => {
    const lines = parsePatch(PATCH_V1);
    expect(lines).toEqual([
      { oldLine: 1, newLine: 1, kind: "context", text: "function processOrder(o) {" },
      { oldLine: null, newLine: 2, kind: "add", text: "  const x = 1;" },
      { oldLine: 2, newLine: 3, kind: "context", text: "  return o;" },
      { oldLine: 3, newLine: 4, kind: "context", text: "}" },
    ]);
  });

  it("başlık satırlarını ve 'No newline' notunu atlar", () => {
    const withNote = PATCH_V1 + "\\ No newline at end of file\n";
    expect(parsePatch(withNote)).toHaveLength(4);
    expect(parsePatch(null)).toEqual([]);
  });

  it("lineAt iki tarafı ayrı okur", () => {
    expect(lineAt(PATCH_V1, "new", 2)).toBe("  const x = 1;");
    expect(lineAt(PATCH_V1, "old", 2)).toBe("  return o;");
    expect(lineAt(PATCH_V1, "new", 99)).toBeNull();
  });

  it("binary dosyada çapa tutmaz", () => {
    const res = anchorOf(
      { ...file({ status: "binary", patch: null }) } as never,
      "new",
      2,
      "x",
    );
    expect(res).toEqual({ anchor: "outdated", currentLine: null });
  });
});
