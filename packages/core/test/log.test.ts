import { describe, expect, it } from "vitest";
import { createRedactingLogger } from "../src/log.js";

describe("redaction'lı logger", () => {
  it("mesajdaki secret stdout'a düşmüyor", () => {
    const lines: string[] = [];
    const log = createRedactingLogger((_l, msg) => lines.push(msg));
    log("info", "[backend] ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv");
    expect(lines[0]).not.toContain("sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv");
    expect(lines[0]).toContain("[redacted:");
    expect(lines[0]).toContain("[backend]");
  });

  it("extra alanı da temizleniyor", () => {
    const extras: unknown[] = [];
    const log = createRedactingLogger((_l, _m, extra) => extras.push(extra));
    log("error", "runner satırı işlenemedi", { line: "token=Zt9xQv2LmNpR4sT7uWyA3bCdEf" });
    expect(JSON.stringify(extras)).not.toContain("Zt9xQv2LmNpR4sT7uWyA3bCdEf");
  });

  it("temiz mesaj değişmiyor", () => {
    const lines: string[] = [];
    const log = createRedactingLogger((_l, msg) => lines.push(msg));
    log("warn", "heartbeat zaman aşımı: backend");
    expect(lines[0]).toBe("heartbeat zaman aşımı: backend");
  });
});
