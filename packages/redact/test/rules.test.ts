import { describe, expect, it } from "vitest";
import { ALL_RULES, MANUAL_RULES, candidateRules, compileRules } from "../src/rules.js";
import { GENERATED_RULES } from "../src/rules.generated.js";

/**
 * Kural setinin sağlığı. Kural BAŞINA pozitif testler motorla birlikte
 * (`redact.test.ts`); burada ölçülen: set yeterince büyük mü, hepsi
 * derleniyor mu ve ön filtre gerçekten çalışıyor mu.
 */

describe("kural seti", () => {
  it("gitleaks'ten en az 100 kural geldi", () => {
    expect(GENERATED_RULES.length).toBeGreaterThanOrEqual(100);
  });

  it("hepsi derleniyor ve `d` bayrağı taşıyor", () => {
    // `d` olmadan grup konumlarını alamayız; secretGroup çalışmaz.
    for (const rule of ALL_RULES) {
      expect(() => new RegExp(rule.pattern, rule.flags), rule.id).not.toThrow();
      expect(rule.flags, rule.id).toContain("d");
      expect(rule.flags, rule.id).toContain("g");
    }
  });

  it("id'ler tekrar etmiyor", () => {
    const ids = ALL_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("anahtar kelimesiz kural sayısı sınırlı", () => {
    // Bunlar HER metinde koşar; sayısı büyürse performans kuralı çöker.
    const always = ALL_RULES.filter((r) => r.keywords.length === 0);
    expect(always.length).toBeLessThanOrEqual(3);
  });
});

describe("ön filtre", () => {
  const compiled = compileRules();

  it("alakasız metinde neredeyse hiçbir regex koşmaz", () => {
    const text = "Randevu oluşturulurken pet_id bulunamadı, 404 döndürüldü.";
    const candidates = candidateRules(text, compiled);
    expect(candidates.length).toBeLessThanOrEqual(3);
  });

  it("anahtar kelime geçince ilgili kural aday oluyor", () => {
    const candidates = candidateRules(
      "aws_access_key_id = AKIAIOSFODNN7EXAMPLE",
      compiled,
    ).map((c) => c.spec.id);
    expect(candidates.some((id) => id.includes("aws"))).toBe(true);
  });
});

describe("elle eklenen kurallar", () => {
  const match = (id: string, text: string): string | null => {
    const spec = MANUAL_RULES.find((r) => r.id === id);
    if (!spec) throw new Error(`kural yok: ${id}`);
    const m = new RegExp(spec.pattern, spec.flags).exec(text);
    if (!m) return null;
    return spec.secretGroup !== undefined ? (m[spec.secretGroup] ?? null) : m[0];
  };

  it("anthropic anahtarı", () => {
    expect(match("anthropic-api-key", "ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGhIjKlMnOpQrSt")).toBe(
      "sk-ant-api03-AbCdEfGhIjKlMnOpQrSt",
    );
    expect(match("anthropic-api-key", "sk-ant-kisa")).toBeNull();
  });

  it("oda davet linki — sadece token kısmı", () => {
    expect(
      match("rooms-invite-token", "https://oda.example/join?token=Zt9xQv2LmNpR4sT7uWyA3bCdEfGh"),
    ).toBe("Zt9xQv2LmNpR4sT7uWyA3bCdEfGh");
  });

  it("magic link", () => {
    expect(
      match("rooms-magic-link", "http://localhost:5173/auth/callback?token=kQ7bN2vX9zR4tY6uI8oP1aS3"),
    ).toBe("kQ7bN2vX9zR4tY6uI8oP1aS3");
  });

  it(".env satırı — anahtar adı kalır, değer yakalanır", () => {
    expect(match("env-assignment", "DB_PASSWORD=sup3r-s3cret-value")).toBe("sup3r-s3cret-value");
    // Kısa değer ve küçük harfli anahtar eşleşmez (gürültü olurdu).
    expect(match("env-assignment", "DB_PASSWORD=kisa")).toBeNull();
    expect(match("env-assignment", "db_password=uzun-ama-kucuk-harf")).toBeNull();
  });
});
