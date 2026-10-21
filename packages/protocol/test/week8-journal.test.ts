import { describe, expect, it } from "vitest";
import {
  JournalEntry,
  JOURNAL_LIMITS,
  journalErrorFields,
  mergeJournalEntry,
  parseJournalPatch,
  type JournalPatch,
} from "../src/journal.js";

/**
 * Hafta 8, Adım 1 — defter şeması.
 *
 * Kabul: geçerli kayıt; serbest metin reddediliyor; var olmayan agent adı
 * reddediliyor; sınır aşımları reddediliyor; host alanları payload'dan
 * geldiğinde yok sayılıyor. Ayrıca birleştirme kuralları (birikimli kararlar
 * ve sözleşmeler, `remove_contracts`).
 */

const AGENTS = ["backend", "frontend"];

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

function host(version: number, touched: string[] = []) {
  return { agent: "backend", version, touched };
}

/** Yamayı doğrula + birleştir; testlerde tek adım. */
function write(prev: JournalEntry | null, input: unknown, version: number) {
  const p = parse(input);
  if (!p.success) throw new Error(p.error.message);
  return mergeJournalEntry(prev, p.data, host(version));
}

describe("geçerli kayıt", () => {
  it("tam bir kayıt şemadan geçiyor ve varsayılanlar doluyor", () => {
    const e = JournalEntry.parse({
      agent: "backend",
      status: "in_progress",
      headline: "Auth uçları yazılıyor",
      decisions: [decision],
      contracts: [login],
      version: 1,
    });
    expect(e.task).toBeNull();
    expect(e.touched).toEqual([]);
    expect(e.contracts[0]).toMatchObject({ stability: "draft" });
    expect(e.blocked_on).toBeNull();
  });

  it("ilk yazımda status + headline yeterli", () => {
    const r = write(null, { status: "idle", headline: "Başlamadım" }, 1);
    expect(r.success).toBe(true);
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
    expect(fieldsOf({ decisions: [{ ...decision, affects: ["qa"] }] })).toEqual(["decisions"]);
  });

  it("geçerli adlar geçiyor", () => {
    expect(parse({ needs_from: ["frontend"], decisions: [decision] }).success).toBe(true);
  });
});

describe("sınır aşımları reddediliyor", () => {
  it.each([
    ["headline 100'den uzun", { headline: "x".repeat(101) }, "headline"],
    ["headline 3'ten kısa", { headline: "ok" }, "headline"],
    ["10'dan fazla karar", { decisions: Array.from({ length: 11 }, (_, i) => ({ ...decision, what: `karar ${i}` })) }, "decisions"],
    ["10'dan fazla sözleşme", { contracts: Array.from({ length: 11 }, (_, i) => ({ ...login, name: `GET /${i}` })) }, "contracts"],
    ["shape 400'den uzun", { contracts: [{ ...login, shape: "x".repeat(401) }] }, "contracts"],
    ["why 300'den uzun", { decisions: [{ ...decision, why: "x".repeat(301) }] }, "decisions"],
    ["task 80'den uzun", { task: "x".repeat(81) }, "task"],
    ["blocked_on 200'den uzun", { blocked_on: "x".repeat(201) }, "blocked_on"],
    ["needs_from 5'ten fazla", { needs_from: Array(6).fill("frontend") }, "needs_from"],
  ])("%s", (_, input, field) => {
    expect(fieldsOf(input)).toEqual([field]);
  });

  it(`touched ${JOURNAL_LIMITS.touched} ile kırpılıyor (host alanı, hata değil)`, () => {
    const many = Array.from({ length: 80 }, (_, i) => `src/f${i}.ts`);
    const r = mergeJournalEntry(null, { status: "done", headline: "çok dosya" }, host(1, many));
    expect(r.success && r.data.touched.length).toBe(JOURNAL_LIMITS.touched);
  });
});

describe("host alanları payload'dan gelirse yok sayılıyor", () => {
  it("agent, touched, version atılıyor; kayıt çağıranın kimliğiyle yazılıyor", () => {
    const p = parse({
      agent: "frontend",
      touched: ["/etc/passwd"],
      version: 99,
      status: "done",
      headline: "Giriş ucu hazır",
    });
    expect(p.success).toBe(true);
    if (!p.success) return;
    expect(p.data).not.toHaveProperty("agent");
    expect(p.data).not.toHaveProperty("touched");
    expect(p.data).not.toHaveProperty("version");

    const r = mergeJournalEntry(null, p.data, host(1, ["src/api/login.ts"]));
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.agent).toBe("backend");
    expect(r.data.version).toBe(1);
    expect(r.data.touched).toEqual(["src/api/login.ts"]);
  });
});

describe("birleştirme", () => {
  const v1 = (() => {
    const r = write(null, { status: "in_progress", headline: "Auth başladı", decisions: [decision], contracts: [login] }, 1);
    if (!r.success) throw new Error(r.error.message);
    return r.data;
  })();

  it("gönderilmeyen alan devralınıyor", () => {
    const r = write(v1, { status: "done" }, 2);
    expect(r.success && r.data).toMatchObject({ status: "done", headline: "Auth başladı", version: 2 });
    expect(r.success && r.data.decisions).toEqual(v1.decisions);
    expect(r.success && r.data.contracts).toEqual(v1.contracts);
  });

  it("kararlar birikiyor, aynı `what` yenisiyle değişiyor", () => {
    const r = write(
      v1,
      {
        decisions: [
          { what: "refresh token DB'de", why: "Redis yok", affects: [] },
          { ...decision, why: "SSR ve CSRF koruması" },
        ],
      },
      2,
    );
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.decisions.map((d) => d.what)).toEqual(["refresh token DB'de", "JWT yerine session cookie"]);
    expect(r.data.decisions[1]!.why).toBe("SSR ve CSRF koruması");
  });

  it("kararlar 10'u aşınca en eski düşüyor", () => {
    let prev = v1;
    for (let i = 0; i < 12; i++) {
      const r = write(prev, { decisions: [{ what: `karar ${i}`, why: "test", affects: [] }] }, i + 2);
      if (!r.success) throw new Error(r.error.message);
      prev = r.data;
    }
    expect(prev.decisions).toHaveLength(JOURNAL_LIMITS.decisions);
    expect(prev.decisions[0]!.what).toBe("karar 2");
    expect(prev.decisions.at(-1)!.what).toBe("karar 11");
  });

  it("sözleşmeler taşınıyor, aynı ad yenisiyle değişiyor", () => {
    const r = write(
      v1,
      {
        contracts: [
          { ...login, shape: "-> {sessionId}", stability: "agreed" },
          { name: "POST /api/logout", shape: "-> 204" },
        ],
      },
      2,
    );
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.contracts.map((c) => [c.name, c.shape, c.stability])).toEqual([
      ["POST /api/login", "-> {sessionId}", "agreed"],
      ["POST /api/logout", "-> 204", "draft"],
    ]);
  });

  it("remove_contracts sözleşmeyi kaldırıyor", () => {
    const r = write(v1, { remove_contracts: ["POST /api/login"] }, 2);
    expect(r.success && r.data.contracts).toEqual([]);
  });

  it("remove_contracts'ta olmayan ad hata (yazım hatası kaybolmasın)", () => {
    const r = write(v1, { remove_contracts: ["POST /api/logn"] }, 2);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(journalErrorFields(r.error)).toEqual(["remove_contracts"]);
      expect(r.error.issues[0]!.message).toContain("POST /api/login");
    }
  });

  it("sözleşmeler sessizce düşmüyor: birleşim 10'u aşarsa hata", () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({ name: `GET /${i}`, shape: "-> {}" }));
    const full = write(null, { status: "done", headline: "on uç", contracts: ten }, 1);
    if (!full.success) throw new Error(full.error.message);
    const r = write(full.data, { contracts: [{ name: "GET /yeni", shape: "-> {}" }] }, 2);
    expect(r.success).toBe(false);
    if (!r.success) expect(journalErrorFields(r.error)).toEqual(["contracts"]);
  });

  it("ilk kayıtta status/headline yoksa hata", () => {
    const r = mergeJournalEntry(null, { decisions: [decision] } as JournalPatch, host(1));
    expect(r.success).toBe(false);
    if (!r.success) expect(journalErrorFields(r.error)).toEqual(["headline", "status"]);
  });

  it("blocked_on null ile temizlenebiliyor", () => {
    const b = write(v1, { status: "blocked", blocked_on: "frontend'in onayı" }, 2);
    if (!b.success) throw new Error(b.error.message);
    const r = write(b.data, { status: "in_progress", blocked_on: null }, 3);
    expect(r.success && r.data.blocked_on).toBeNull();
  });
});
