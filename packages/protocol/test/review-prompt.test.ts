import { describe, expect, it } from "vitest";
import { LINE_TEXT_LIMIT, buildReviewPrompt, type ReviewComment } from "../src/review-prompt.js";

/**
 * Agent'a giden metnin şekli burada kilitleniyor. Saf fonksiyon olmasının
 * sebebi tam olarak bu: "agent yorumu yanlış satıra uyguladı" dendiğinde
 * bakılacak ilk yer, ona ne söylendiği.
 */

const c = (over: Partial<ReviewComment> = {}): ReviewComment => ({
  path: "src/auth.ts",
  side: "new",
  line: 42,
  lineText: "const result = await validateAndSaveUserAndSendEmail(input)",
  body: "bunu böl",
  ...over,
});

describe("buildReviewPrompt", () => {
  it("tek yorum: dosya yolu, satır numarası ve alıntılanan satır metinde", () => {
    const text = buildReviewPrompt("Ayse", [c()]);

    expect(text).toContain("Diff üzerine 1 satır yorumu:");
    expect(text).toContain("1) src/auth.ts:42");
    expect(text).toContain("   > const result = await validateAndSaveUserAndSendEmail(input)");
    expect(text).toContain("   bunu böl");
    // `[İsim]: ` önekini kuyruk koyuyor; bu fonksiyon ismi metne yazmıyor.
    expect(text).not.toContain("Ayse");
  });

  it("çok dosyalı: yola, sonra satır numarasına göre sıralar", () => {
    const text = buildReviewPrompt("Ayse", [
      c({ path: "src/order.ts", line: 10, body: "üç" }),
      c({ path: "src/auth.ts", line: 88, body: "iki" }),
      c({ path: "src/auth.ts", line: 42, body: "bir" }),
    ]);

    const order = ["1) src/auth.ts:42", "2) src/auth.ts:88", "3) src/order.ts:10"];
    const positions = order.map((o) => text.indexOf(o));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(text).toContain("Diff üzerine 3 satır yorumu:");
  });

  it("silinen satıra yorumda satır numarasının yanında uyarı var", () => {
    const text = buildReviewPrompt("Ayse", [c({ side: "old", line: 17, body: "bunu geri al" })]);

    expect(text).toContain("1) src/auth.ts:17 (silinen satır)");
  });

  it("uzun satır 200 karakterde kırpılır, yorum gövdesi kırpılmaz", () => {
    const long = "x".repeat(400);
    const body = "y".repeat(3000);
    const text = buildReviewPrompt("Ayse", [c({ lineText: long, body })]);

    expect(text).toContain("x".repeat(LINE_TEXT_LIMIT) + "…");
    expect(text).not.toContain("x".repeat(LINE_TEXT_LIMIT + 1));
    expect(text).toContain(body);
  });

  it("alıntılanan satırdaki yeni satır karakteri bloğu bozmaz", () => {
    const text = buildReviewPrompt("Ayse", [c({ lineText: "bir\niki" })]);

    // Alıntı TEK satır kalmalı: iki satıra bölünürse numaralı liste kayar.
    expect(text).toContain("   > bir iki");
  });

  it("kapanış yönergesi her zaman sonda", () => {
    const text = buildReviewPrompt("Ayse", [c()]);
    const lines = text.trimEnd().split("\n");

    expect(lines[lines.length - 1]).toContain("alıntılanan metni esas al");
    expect(lines[lines.length - 2]).toContain("Her yorumu uygula");
  });
});
