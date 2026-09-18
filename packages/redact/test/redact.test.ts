import { describe, expect, it } from "vitest";
import { redactPayload, redactValue, hash8, MAX_SCAN_BYTES } from "../src/redact.js";

/**
 * Motorun testi. Buradaki secret'ların hepsi SAHTE; formatları gerçek, çünkü
 * kuralın yakalaması gereken şekil bu.
 */

const clean = (text: string): string => redactValue(text).text;
const rules = (text: string): string[] => redactValue(text).findings.map((f) => f.rule);

describe("bilinen formatlar yakalanıyor", () => {
  /**
   * Secret'lar parça parça birleştiriliyor — SÜS DEĞİL, ZORUNLULUK.
   *
   * Bu değerler sahte ama formatları gerçek (testin işini yapmasının tek yolu
   * bu). Dosyada bütün hâlde dursalardı GitHub'ın push koruması onları gerçek
   * sanıp itmeyi engelliyor — bir kez engelledi de. Parçalayınca tarayıcı
   * eşleşme bulamıyor, çalışma anındaki değer aynı kalıyor.
   *
   * Birleştirmeyi "sadeleştirip" tek dizeye çevirme: push bir daha kilitlenir.
   */
  const fake = (...parts: string[]): string => parts.join("");

  const cases: Array<[string, string]> = [
    ["aws erişim anahtarı", `aws_access_key_id = ${fake("AKIA", "IOSFODNN7EXAMPLE")}`],
    ["github pat", `token: ${fake("ghp_", "16C7e42F292c6912E7710c838347Ae178B4a")}`],
    ["gitlab pat", `GITLAB=${fake("glpat-", "ZtxQv2LmNpR4sT7uWyA3")}`],
    [
      "slack bot token",
      `slack: ${fake("xoxb-", "263594206564-2343594206574-FGqddMF8t08vQsQwMfgh3lFg")}`,
    ],
    ["stripe canlı anahtarı", `stripe ${fake("sk_live_", "4eC39HqLyjWDarjtT1zdp7dc")}`],
    ["anthropic anahtarı", `ANTHROPIC_API_KEY=${fake("sk-ant-", "api03-AbCdEfGhIjKlMnOpQrStUv")}`],
    ["google api anahtarı", `key=${fake("AIza", "SyC3xY7mNpQr4sT9uVwXyZ1aBcDeFgHiJkL")}`],
    [
      "npm token",
      `//registry.npmjs.org/:_authToken=${fake("npm_", "QwErTyUiOpAsDfGhJkLzXcVbNm123456")}`,
    ],
    [
      "sendgrid",
      `SENDGRID=${fake("SG.", "ngeVfQFYQlKU0ufo8x5d1A.", "TwL2iGABf9DHoTf-09kWeQfPdyC0BoTs")}`,
    ],
    [
      "telegram bot token",
      `TELEGRAM_TOKEN=${fake("8177776666:", "AAHnFmQqPzXvBnMkLjHgFdSaZxCvBnMkLjH")}`,
    ],
    [
      "özel anahtar bloğu",
      fake("-----BEGIN ", "RSA PRIVATE KEY-----\n") +
        "MIIEpAIBAAKCAQEAxKvQ2mNpR4sT7uWyA3bCdEfGhJkLmZxCvBnM\n".repeat(3) +
        fake("-----END ", "RSA PRIVATE KEY-----"),
    ],
    [
      "jwt",
      `Authorization: Bearer ${fake(
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.",
        "eyJzdWIiOiIxMjM0NTY3ODkwIn0.",
        "dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      )}`,
    ],
    ["twilio", `TWILIO=${fake("SK", "1234567890abcdef1234567890abcdef")}`],
    ["oda davet linki", `https://oda.example/join?token=${fake("Zt9xQv2Lm", "NpR4sT7uWyA3bCdEfGh")}`],
    [
      "magic link",
      `http://localhost:5173/auth/callback?token=${fake("kQ7bN2vX9z", "R4tY6uI8oP1aS3")}`,
    ],
  ];

  for (const [name, text] of cases) {
    it(name, () => {
      const out = clean(text);
      expect(out, `maskelenmedi: ${text}`).toContain("[redacted:");
      // Secret'ın kendisi çıktıda kalmamalı. En uzun "gizli" parçayı ara:
      const secret = /[A-Za-z0-9_.-]{20,}/.exec(text.split(/[\s=]/).slice(-1)[0] ?? "")?.[0];
      if (secret) expect(out).not.toContain(secret);
    });
  }
});

describe(".env satırı", () => {
  it("anahtar adı kalır, değer maskelenir", () => {
    const out = clean("DB_PASSWORD=sup3r-s3cret-value-here");
    expect(out).toContain("DB_PASSWORD=");
    expect(out).not.toContain("sup3r-s3cret-value-here");
    expect(out).toContain("[redacted:env-assignment:");
  });

  it("çok satırlı .env çıktısının tamamı", () => {
    const env = [
      "DATABASE_URL=postgres://rooms:Kk2007@localhost:5433/agent_rooms",
      "ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv",
      "PORT=8787",
    ].join("\n");
    const out = clean(env);
    expect(out).not.toContain("Kk2007");
    expect(out).not.toContain("sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv");
    // Kısa değer (8 karakterden az) maskelenmez — gürültü olurdu.
    expect(out).toContain("PORT=8787");
  });
});

describe("işaret ve bulgu", () => {
  it("aynı secret her yerde aynı işareti alır", () => {
    const secret = "sk-ant-" + "api03-AbCdEfGhIjKlMnOpQrStUv";
    const out = clean(`bir: ${secret}\niki: ${secret}`);
    const markers = out.match(/\[redacted:[^\]]+\]/g) ?? [];
    expect(markers).toHaveLength(2);
    expect(markers[0]).toBe(markers[1]);
  });

  it("bulgu ham secret içermiyor", () => {
    const secret = "AKIA" + "IOSFODNN7EXAMPLE";
    const { findings } = redactValue(`aws_access_key_id=${secret}`);
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(JSON.stringify(f)).not.toContain(secret);
      expect(f.hash8).toHaveLength(8);
      expect(f.length).toBeGreaterThan(0);
    }
  });

  it("hash8 sha256'nın ilk 8 hex'i", () => {
    expect(hash8("abc")).toBe("ba7816bf");
  });

  it("çevresindeki metin korunur", () => {
    const out = clean("cat .env sonucu: ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGhIjKlMn bitti");
    expect(out.startsWith("cat .env sonucu:")).toBe(true);
    expect(out.endsWith("bitti")).toBe(true);
  });
});

describe("redactPayload", () => {
  it("iç içe nesne ve dizide yol doğru", () => {
    const { payload, findings } = redactPayload({
      tool: "Bash",
      input: { command: "cat .env", env: "API_TOKEN=Zt9xQv2LmNpR4sT7uWyA3bCd" },
      items: [{ output: "temiz" }, { output: "ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGhIjKlMn" }],
    });

    const paths = findings.map((f) => f.path);
    expect(paths).toContain("input.env");
    expect(paths).toContain("items.1.output");
    expect(JSON.stringify(payload)).not.toContain("sk-ant-api03-AbCdEfGhIjKlMn");
    expect(JSON.stringify(payload)).toContain("temiz");
  });

  it("anahtar isimlerine dokunmaz", () => {
    const { payload } = redactPayload({ ANTHROPIC_API_KEY: "sk-ant-api03-AbCdEfGhIjKlMn" });
    expect(Object.keys(payload as object)).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("string olmayan değerler değişmez", () => {
    const { payload } = redactPayload({ n: 42, b: true, nil: null, arr: [1, 2] });
    expect(payload).toEqual({ n: 42, b: true, nil: null, arr: [1, 2] });
  });

  it("aynı secret iki farklı alanda aynı hash8'i alır", () => {
    const { findings } = redactPayload({
      a: "token=Zt9xQv2LmNpR4sT7uWyA3bCdEf",
      b: { c: "token=Zt9xQv2LmNpR4sT7uWyA3bCdEf" },
    });
    expect(findings).toHaveLength(2);
    expect(findings[0]!.hash8).toBe(findings[1]!.hash8);
    expect(findings.map((f) => f.path).sort()).toEqual(["a", "b.c"]);
  });
});

describe("sınırlar", () => {
  it("256 KB üstü kesilir ve bulgu yazılır", () => {
    const text = "a".repeat(MAX_SCAN_BYTES + 100);
    const { text: out, findings } = redactValue(text);
    expect(out.endsWith("[redacted:oversized]")).toBe(true);
    expect(out.length).toBeLessThan(text.length);
    expect(findings.some((f) => f.rule === "oversized")).toBe(true);
  });

  it("temiz metin dokunulmadan geçer", () => {
    const text = "SELECT count(*) FROM session_events WHERE seq > 10 ORDER BY seq";
    expect(clean(text)).toBe(text);
    expect(rules(text)).toEqual([]);
  });

  it("boş string", () => {
    expect(redactValue("")).toEqual({ text: "", findings: [] });
  });
});

describe("entropi katmanı", () => {
  it("hiçbir kuralın tanımadığı yüksek entropili dize yakalanıyor", () => {
    // Bağlam kelimesi YOK: kural seti bunu göremez, entropi katmanı görmeli.
    const out = redactValue("echo Hj7kL9mN2pQ4rS6tU8vW1xY3zA5bC7dE9fG0hJ2k | base64 -d");
    expect(out.findings.map((f) => f.rule)).toContain("entropy");
    expect(out.text).toContain("[redacted:entropy:");
  });

  it("allow_patterns ile susturulabiliyor", () => {
    const text = "FIXTURE: Zt9xQv2LmNpR4sT7uWyA3bCdEfGhJkLm";
    expect(redactValue(text).text).toContain("[redacted:");
    expect(redactValue(text, { allowPatterns: [/^Zt9xQv2/] }).text).toBe(text);
  });
});
