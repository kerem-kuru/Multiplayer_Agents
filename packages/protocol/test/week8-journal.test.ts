import { describe, expect, it } from "vitest";
import {
  applyJournalWrite,
  Contract,
  EMPTY_JOURNAL,
  JOURNAL_COMPACTION_THRESHOLD,
  JOURNAL_LIMITS,
  journalCompaction,
  journalErrorFields,
  JournalSnapshot,
  mergeJournalWrite,
  parseJournalPatch,
  relevantDecisions,
  type JournalPatch,
  type JournalState,
} from "../src/journal.js";

/**
 * Hafta 8, Adım 1 — defter şeması, iki parçalı model.
 *
 * Kabul: geçerli kayıt; serbest metin reddediliyor; var olmayan agent adı
 * reddediliyor; sınır aşımları (TEK YAZIMDA) reddediliyor; host alanları
 * payload'dan geldiğinde yok sayılıyor. Ayrıca: anlık alanlar korunuyor,
 * sicil hiçbir şey düşürmüyor, sözleşmeyi yalnızca sahibi değiştirip
 * kaldırabiliyor, ilgi filtresi ve sıkıştırma eşiği deterministik.
 */

const AGENTS = ["backend", "frontend", "qa"];
const SHA = "a".repeat(64);

const decision = { what: "JWT yerine session cookie", why: "frontend SSR gerektiriyor", affects: ["frontend"] };
const login = { name: "POST /api/login", shape: "-> {token, expiresAt}", file: "contracts/auth.md" };

function parse(input: unknown) {
  return parseJournalPatch(input, { agents: AGENTS });
}

function fieldsOf(input: unknown): string[] {
  const r = parse(input);
  if (r.success) throw new Error("geçmesi beklenmiyordu");
  return journalErrorFields(r.error);
}

type Opts = { agent?: string; touched?: string[]; fileSha?: (f: string) => string | null };

/** Yamayı doğrula + birleştir; sürüm agent'ın önceki sürümünden. */
function write(prev: JournalState, input: unknown, opts: Opts = {}) {
  const agent = opts.agent ?? "backend";
  const p = parse(input);
  if (!p.success) throw new Error(p.error.message);
  return mergeJournalWrite(prev, p.data, {
    agent,
    version: (prev.snapshots[agent]?.version ?? 0) + 1,
    touched: opts.touched,
    fileSha: opts.fileSha ?? (() => SHA),
  });
}

/** Yaz ve uygula; başarısızsa test düşer. */
function commit(prev: JournalState, input: unknown, opts: Opts = {}): JournalState {
  const r = write(prev, input, opts);
  if (!r.success) throw new Error(r.error.message);
  return applyJournalWrite(prev, r.data);
}

function errorFields(r: ReturnType<typeof write>): string[] {
  if (r.success) throw new Error("başarısız olması bekleniyordu");
  return journalErrorFields(r.error);
}

const start = { status: "in_progress", headline: "Auth başladı" };

describe("geçerli kayıt", () => {
  it("anlık kısım şemadan geçiyor ve varsayılanlar doluyor", () => {
    const s = JournalSnapshot.parse({ agent: "backend", status: "in_progress", headline: "Auth uçları yazılıyor", version: 1 });
    expect(s).toMatchObject({ task: null, touched: [], blocked_on: null, needs_from: [] });
  });

  it("sözleşme varsayılanları: draft, sha null", () => {
    expect(Contract.parse({ ...login, owner: "backend" })).toMatchObject({ stability: "draft", sourceSha256: null });
  });

  it("ilk yazımda status + headline yeterli", () => {
    expect(write(EMPTY_JOURNAL, { status: "idle", headline: "Başlamadım" }).success).toBe(true);
  });
});

describe("serbest metin reddediliyor", () => {
  it('decisions: "JWT kullandım" → decisions alanı', () => {
    expect(fieldsOf({ status: "done", headline: "bitti", decisions: "JWT kullandım" })).toEqual(["decisions"]);
  });

  it("karar nesnesi yerine string dizisi → decisions", () => {
    expect(fieldsOf({ decisions: ["JWT kullandım"] })).toEqual(["decisions"]);
  });

  it("bilinmeyen anahtar sessizce atılmıyor, reddediliyor", () => {
    expect(fieldsOf({ headline: "tamam", summary: "uzun serbest metin" })).toEqual(["summary"]);
  });

  it("payload nesne değilse kaydın tamamı reddediliyor", () => {
    expect(fieldsOf("JWT kullandım, frontend cookie okusun")).toEqual(["(kayıt)"]);
  });

  it("geçersiz status reddediliyor", () => {
    expect(fieldsOf({ status: "yarım" })).toEqual(["status"]);
  });
});

describe("agent adları config'te olmalı", () => {
  it("needs_from'da var olmayan ad", () => {
    const r = parse({ needs_from: ["fronted"] });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(journalErrorFields(r.error)).toEqual(["needs_from"]);
      expect(r.error.issues[0]!.message).toContain("backend, frontend");
    }
  });

  it("decisions[].affects'te var olmayan ad", () => {
    expect(fieldsOf({ decisions: [{ ...decision, affects: ["ops"] }] })).toEqual(["decisions"]);
  });

  it("geçerli adlar geçiyor", () => {
    expect(parse({ needs_from: ["frontend"], decisions: [decision] }).success).toBe(true);
  });
});

describe("sınır aşımları — tek yazımın sınırı", () => {
  it.each([
    ["headline 100'den uzun", { headline: "x".repeat(101) }, "headline"],
    ["headline 3'ten kısa", { headline: "ok" }, "headline"],
    ["tek yazımda 10'dan fazla karar", { decisions: Array.from({ length: 11 }, (_, i) => ({ ...decision, what: `karar ${i}` })) }, "decisions"],
    ["tek yazımda 10'dan fazla sözleşme", { contracts: Array.from({ length: 11 }, (_, i) => ({ ...login, name: `GET /${i}` })) }, "contracts"],
    ["shape 400'den uzun", { contracts: [{ ...login, shape: "x".repeat(401) }] }, "contracts"],
    ["why 300'den uzun", { decisions: [{ ...decision, why: "x".repeat(301) }] }, "decisions"],
    ["affects 5'ten fazla", { decisions: [{ ...decision, affects: Array(6).fill("qa") }] }, "decisions"],
    ["task 80'den uzun", { task: "x".repeat(81) }, "task"],
    ["blocked_on 200'den uzun", { blocked_on: "x".repeat(201) }, "blocked_on"],
    ["needs_from 5'ten fazla", { needs_from: Array(6).fill("frontend") }, "needs_from"],
  ])("%s", (_, input, field) => {
    expect(fieldsOf(input)).toEqual([field]);
  });

  it(`touched ${JOURNAL_LIMITS.touched} ile kırpılıyor (host alanı, hata değil)`, () => {
    const many = Array.from({ length: 80 }, (_, i) => `src/f${i}.ts`);
    const r = write(EMPTY_JOURNAL, { status: "done", headline: "çok dosya" }, { touched: many });
    expect(r.success && r.data.snapshot.touched.length).toBe(JOURNAL_LIMITS.touched);
  });
});

describe("host alanları payload'dan gelirse yok sayılıyor", () => {
  it("agent, touched, version atılıyor; kayıt çağıranın kimliğiyle yazılıyor", () => {
    const p = parse({ agent: "frontend", touched: ["/etc/passwd"], version: 99, status: "done", headline: "Giriş ucu hazır" });
    expect(p.success).toBe(true);
    if (!p.success) return;
    expect(p.data).not.toHaveProperty("agent");
    expect(p.data).not.toHaveProperty("touched");
    expect(p.data).not.toHaveProperty("version");

    const r = mergeJournalWrite(EMPTY_JOURNAL, p.data, {
      agent: "backend",
      version: 1,
      touched: ["src/api/login.ts"],
      fileSha: () => null,
    });
    expect(r.success && r.data.snapshot).toMatchObject({ agent: "backend", version: 1, touched: ["src/api/login.ts"] });
  });

  it("sözleşmedeki owner ve sourceSha256 atılıyor; host dolduruyor", () => {
    const r = write(
      EMPTY_JOURNAL,
      { ...start, contracts: [{ ...login, owner: "frontend", sourceSha256: "b".repeat(64) }] },
      { fileSha: (f) => (f === "contracts/auth.md" ? SHA : null) },
    );
    expect(r.success && r.data.contracts[0]).toMatchObject({ owner: "backend", sourceSha256: SHA });
  });
});

describe("anlık kısım: yazımda yoksa önceki korunur", () => {
  const v1 = commit(
    EMPTY_JOURNAL,
    { ...start, task: "auth", blocked_on: "frontend'in onayı", needs_from: ["frontend"] },
    { touched: ["src/api/auth.ts"] },
  );

  it("yalnızca status gönderilince geri kalan anlık alanlar duruyor", () => {
    const r = write(v1, { status: "done" });
    expect(r.success && r.data.snapshot).toEqual({
      agent: "backend",
      task: "auth",
      status: "done",
      headline: "Auth başladı",
      touched: ["src/api/auth.ts"],
      blocked_on: "frontend'in onayı",
      needs_from: ["frontend"],
      version: 2,
    });
  });

  it("dosyaya dokunmayan yazım touched'ı silmiyor; dokunan değiştiriyor", () => {
    const empty = write(v1, { status: "done" }, { touched: [] });
    expect(empty.success && empty.data.snapshot.touched).toEqual(["src/api/auth.ts"]);
    const fresh = write(v1, { status: "done" }, { touched: ["src/api/session.ts"] });
    expect(fresh.success && fresh.data.snapshot.touched).toEqual(["src/api/session.ts"]);
  });

  it("null ve boş dizi açıkça temizliyor", () => {
    const r = write(v1, { blocked_on: null, needs_from: [], task: null });
    expect(r.success && r.data.snapshot).toMatchObject({ blocked_on: null, needs_from: [], task: null });
  });

  it("ilk yazımda status/headline yoksa hata", () => {
    const r = mergeJournalWrite(EMPTY_JOURNAL, { decisions: [decision] } as JournalPatch, {
      agent: "backend",
      version: 1,
      fileSha: () => null,
    });
    expect(errorFields(r)).toEqual(["headline", "status"]);
  });

  it("agent'ların anlık kısımları birbirinden bağımsız", () => {
    const both = commit(v1, { status: "idle", headline: "Bekliyorum" }, { agent: "frontend" });
    expect(both.snapshots.backend!.version).toBe(1);
    expect(both.snapshots.frontend!.version).toBe(1);
  });
});

describe("sicil: yazımda yoksa eklenmez, hiçbir şey düşmez", () => {
  it("12 ayrı yazımdan sonra 12 karar da sicilde — ilki dahil", () => {
    let s = commit(EMPTY_JOURNAL, start);
    for (let i = 0; i < 12; i++) s = commit(s, { decisions: [{ what: `karar ${i}`, why: "test", affects: [] }] });
    expect(s.decisions.map((d) => d.what)).toEqual(Array.from({ length: 12 }, (_, i) => `karar ${i}`));
    expect(s.decisions[0]!.version).toBe(2);
  });

  it("kararsız ve sözleşmesiz yazım sicile dokunmuyor", () => {
    const v1 = commit(EMPTY_JOURNAL, { ...start, decisions: [decision], contracts: [login] });
    const r = write(v1, { status: "done", headline: "bitti" });
    if (!r.success) throw new Error(r.error.message);
    expect(r.data).toMatchObject({ decisions: [], contracts: [], removeContracts: [] });
    const v2 = applyJournalWrite(v1, r.data);
    expect(v2.decisions).toEqual(v1.decisions);
    expect(v2.contracts).toEqual(v1.contracts);
  });

  it("aynı sahip + what yenisiyle değişiyor, sona geçiyor ve sürümü yenileniyor", () => {
    let s = commit(EMPTY_JOURNAL, { ...start, decisions: [decision, { what: "refresh token DB'de", why: "Redis yok" }] });
    s = commit(s, { decisions: [{ ...decision, why: "SSR ve CSRF koruması" }] });
    expect(s.decisions.map((d) => [d.what, d.why, d.version])).toEqual([
      ["refresh token DB'de", "Redis yok", 1],
      ["JWT yerine session cookie", "SSR ve CSRF koruması", 2],
    ]);
  });

  it("farklı sahiplerin aynı what'ı ayrı kararlar", () => {
    let s = commit(EMPTY_JOURNAL, { ...start, decisions: [decision] });
    s = commit(s, { ...start, decisions: [{ ...decision, affects: ["backend"] }] }, { agent: "frontend" });
    expect(s.decisions.map((d) => d.owner)).toEqual(["backend", "frontend"]);
  });

  it("sıra sabit: sahip adı, sonra sürüm — yazımlar araya girse de (DB okumasıyla aynı)", () => {
    let s = commit(EMPTY_JOURNAL, { ...start, decisions: [{ what: "f-karar-1", why: "test" }] }, { agent: "frontend" });
    s = commit(s, { ...start, decisions: [{ what: "b-karar-1", why: "test" }, { what: "b-karar-2", why: "test" }] });
    s = commit(s, { decisions: [{ what: "f-karar-2", why: "test" }] }, { agent: "frontend" });
    s = commit(s, { decisions: [{ what: "b-karar-3", why: "test" }] });
    expect(s.decisions.map((d) => d.what)).toEqual(["b-karar-1", "b-karar-2", "b-karar-3", "f-karar-1", "f-karar-2"]);
  });

  it("tek yazımda aynı what iki kez: sonuncusu kazanıyor", () => {
    const r = write(EMPTY_JOURNAL, { ...start, decisions: [decision, { ...decision, why: "ikinci gerekçe" }] });
    expect(r.success && r.data.decisions.map((d) => d.why)).toEqual(["ikinci gerekçe"]);
  });

  it("odanın sözleşme toplamı sınırsız: üç yazımda 25 sözleşme", () => {
    let s = commit(EMPTY_JOURNAL, start);
    for (let w = 0; w < 3; w++) {
      const batch = Array.from({ length: w < 2 ? 10 : 5 }, (_, i) => ({ name: `GET /${w}/${i}`, shape: "-> {}" }));
      s = commit(s, { contracts: batch });
    }
    expect(s.contracts).toHaveLength(25);
    expect(s.contracts[0]!.name).toBe("GET /0/0");
  });

  it("sahibi sözleşmeyi yerinde güncelliyor", () => {
    let s = commit(EMPTY_JOURNAL, { ...start, contracts: [login, { name: "POST /api/logout", shape: "-> 204" }] });
    s = commit(s, { contracts: [{ ...login, shape: "-> {sessionId}", stability: "agreed" }] });
    expect(s.contracts.map((c) => [c.name, c.shape, c.stability])).toEqual([
      ["POST /api/login", "-> {sessionId}", "agreed"],
      ["POST /api/logout", "-> 204", "draft"],
    ]);
  });
});

describe("sözleşmenin sahibi", () => {
  const owned = commit(
    commit(EMPTY_JOURNAL, { ...start, contracts: [login] }),
    { status: "idle", headline: "Bekliyorum" },
    { agent: "frontend" },
  );

  it("başka agent aynı adla yazamıyor", () => {
    const r = write(owned, { contracts: [{ ...login, shape: "-> {jwt}" }] }, { agent: "frontend" });
    expect(errorFields(r)).toEqual(["contracts"]);
    if (!r.success) expect(r.error.issues[0]!.message).toContain("backend'in sözleşmesi");
  });

  it("başka agent kaldıramıyor", () => {
    const r = write(owned, { remove_contracts: ["POST /api/login"] }, { agent: "frontend" });
    expect(errorFields(r)).toEqual(["remove_contracts"]);
  });

  it("sahibi kaldırabiliyor", () => {
    expect(commit(owned, { remove_contracts: ["POST /api/login"] }).contracts).toEqual([]);
  });

  it("olmayan ad hata (yazım hatası kaybolmasın)", () => {
    const r = write(owned, { remove_contracts: ["POST /api/logn"] });
    expect(errorFields(r)).toEqual(["remove_contracts"]);
    if (!r.success) expect(r.error.issues[0]!.message).toContain("POST /api/login");
  });

  it("aynı yazımda kaldır + yeniden ekle", () => {
    const s = commit(owned, { remove_contracts: ["POST /api/login"], contracts: [{ ...login, shape: "-> {sessionId}" }] });
    expect(s.contracts.map((c) => c.shape)).toEqual(["-> {sessionId}"]);
  });
});

describe("sourceSha256", () => {
  it("file yoksa null, dosya yoksa null, varsa yazım anındaki sha", () => {
    const r = write(
      EMPTY_JOURNAL,
      {
        ...start,
        contracts: [
          { name: "GET /a", shape: "-> {}" },
          { name: "GET /b", shape: "-> {}", file: "contracts/yok.md" },
          { name: "GET /c", shape: "-> {}", file: "contracts/c.md" },
        ],
      },
      { fileSha: (f) => (f === "contracts/c.md" ? SHA : null) },
    );
    expect(r.success && r.data.contracts.map((c) => c.sourceSha256)).toEqual([null, null, SHA]);
  });

  it("güncelleme sha'yı yeniliyor", () => {
    const s1 = commit(EMPTY_JOURNAL, { ...start, contracts: [login] }, { fileSha: () => SHA });
    const s2 = commit(s1, { contracts: [login] }, { fileSha: () => "c".repeat(64) });
    expect(s2.contracts[0]!.sourceSha256).toBe("c".repeat(64));
  });
});

describe("ilgi filtresi — model çağrısı yok", () => {
  const s = commit(
    commit(EMPTY_JOURNAL, {
      ...start,
      decisions: [
        { what: "frontend'i etkiler", why: "test", affects: ["frontend"] },
        { what: "yalnız qa'yı etkiler", why: "test", affects: ["qa"] },
        { what: "genel karar", why: "test", affects: [] },
      ],
    }),
    { ...start, decisions: [{ what: "frontend'in kendi kararı", why: "test", affects: ["qa"] }] },
    { agent: "frontend" },
  );

  it("kendi kararları + onu etkileyenler + genel; başkasını etkileyen elenir", () => {
    expect(relevantDecisions(s.decisions, "frontend").map((d) => d.what)).toEqual([
      "frontend'i etkiler",
      "genel karar",
      "frontend'in kendi kararı",
    ]);
    expect(relevantDecisions(s.decisions, "qa").map((d) => d.what)).toEqual([
      "yalnız qa'yı etkiler",
      "genel karar",
      "frontend'in kendi kararı",
    ]);
  });

  it("aynı girdi her zaman aynı çıktı", () => {
    const first = JSON.stringify(relevantDecisions(s.decisions, "backend"));
    for (let i = 0; i < 100; i++) expect(JSON.stringify(relevantDecisions(s.decisions, "backend"))).toBe(first);
  });
});

describe("sıkıştırma eşiği — journal.compaction_needed ölçümü", () => {
  function withDecisions(n: number, affects: string[]) {
    let s = commit(EMPTY_JOURNAL, start);
    for (let i = 0; i < n; i++) s = commit(s, { decisions: [{ what: `karar ${i}`, why: "test", affects }] });
    return s;
  }

  it("eşikte değil, eşiği aşınca gerekli", () => {
    const at = JOURNAL_COMPACTION_THRESHOLD.relevantDecisions;
    expect(journalCompaction(withDecisions(at, ["frontend"]), "frontend").needed).toBe(false);
    expect(journalCompaction(withDecisions(at + 1, ["frontend"]), "frontend")).toEqual({
      agent: "frontend",
      relevantDecisions: at + 1,
      totalDecisions: at + 1,
      contracts: 0,
      needed: true,
    });
  });

  it("okuyanı ilgilendirmeyen kararlar sayılmıyor", () => {
    const s = withDecisions(30, ["qa"]);
    expect(journalCompaction(s, "frontend")).toMatchObject({ relevantDecisions: 0, totalDecisions: 30, needed: false });
    expect(journalCompaction(s, "qa").needed).toBe(true);
  });

  it("sözleşme sayısı eşiği aşınca gerekli", () => {
    const n = JOURNAL_COMPACTION_THRESHOLD.contracts + 1;
    const s = commit(commit(EMPTY_JOURNAL, { ...start, contracts: Array.from({ length: 10 }, (_, i) => ({ name: `GET /${i}`, shape: "-> {}" })) }), {
      contracts: [{ name: "GET /son", shape: "-> {}" }],
    });
    expect(journalCompaction(s, "frontend")).toMatchObject({ contracts: n, needed: true });
  });
});
