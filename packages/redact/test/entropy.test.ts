import { describe, expect, it } from "vitest";
import { scanEntropy, shannonEntropy, hasKeyContext } from "../src/entropy.js";

/**
 * Entropi taramasının test seti.
 *
 * Eşikler bu kümeye göre SEÇİLDİ, tahminle değil. Kural: negatif kümede bir
 * tane bile bayrak çıkarsa test düşer — yanlış pozitif, kaçırılan secret kadar
 * zararlıdır, çünkü ekip aracı kapatır.
 *
 * Buradaki "secret"ların hepsi SAHTE ama formatları gerçek.
 */

const flagged = (text: string): string[] => scanEntropy(text).map((h) => h.value);

describe("shannonEntropy", () => {
  it("tek karakterin tekrarında sıfır", () => {
    expect(shannonEntropy("AAAAAAAAAAAAAAAA")).toBe(0);
  });

  it("karışık base64'te 4.5 üstü", () => {
    expect(shannonEntropy("Zt9xQv2LmNpR4sT7uWyA3bCdEfGhJkLm")).toBeGreaterThan(4.5);
  });

  it("boş metinde sıfır", () => {
    expect(shannonEntropy("")).toBe(0);
  });
});

describe("hasKeyContext", () => {
  it("anahtar benzeri kelime + ayraç", () => {
    expect(hasKeyContext("AWS_SECRET_ACCESS_KEY=")).toBe(true);
    expect(hasKeyContext('api_key: "')).toBe(true);
    expect(hasKeyContext("--auth-token ")).toBe(true);
  });

  it("alakasız kelime bağlam değil", () => {
    expect(hasKeyContext("const value = ")).toBe(false);
    expect(hasKeyContext("filename: ")).toBe(false);
  });
});

describe("pozitif — bayraklanmalı", () => {
  const positives: Array<[string, string]> = [
    ["aws gizli anahtarı", "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLE"],
    ["api_key ataması", 'api_key: "Zt9xQv2LmNpR4sT7uWyA3bCdEfGh"'],
    ["komut satırı bayrağı", "gemini --auth-token kQ7bN2vX9zR4tY6uI8oP1aS3dF5gH0jKlZxCvBnM2qW"],
    ["bağlamsız uzun base64", "echo Zt9xQv2LmNpR4sT7uWyA3bCdEfGhJkLm | base64 -d"],
    ["jwt", "Cookie: jwt=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"],
    ["db şifresi", "DB_PASSWORD=Tk9mQ2vZ8xR4wY7Lp"],
    ["bearer başlığı", "Authorization: Bearer q7WxE2rT9yU4iO6pA1sD3fG5hJ8kL0zXcVbN"],
    ["oturum çerezi", "session=MjA5ZmE4YzQtN2I2ZS00YzFhLTk4ZDMtYmY3"],
    ["client secret", "client_secret=8fK2mQ9wP4xL7vB3nR6tY1uI5oA0sD"],
    ["credential alanı", 'credential: "aZ4xS7dF2gH9jK1lQ6wE3rT8yU5iO0p"'],
    ["webhook imzası", "signature=X9kL2mN7pQ4rS1tU8vW3xY6zA5bC0dE"],
    ["bağlamsız 48 karakter", "curl https://x.example/Hj7kL9mN2pQ4rS6tU8vW1xY3zA5bC7dE9fG0hJ2k"],
  ];

  for (const [name, text] of positives) {
    it(name, () => {
      expect(flagged(text).length, `bayraklanmadı: ${text}`).toBeGreaterThan(0);
    });
  }
});

describe("negatif — ASLA bayraklanmamalı", () => {
  const negatives: Array<[string, string]> = [
    ["git sha1", "commit 9f2a1c4e7b8d3a5f6e0c9b2d4a7f1e8c3b6d5a09 tarihli"],
    ["git sha256", "sha256:3484bbe88584c944984e3a5be05b98247ec5dd62c24f89ffbc06bdb9cdc52b03"],
    ["uuid", '{"roomId": "3437e583-ca04-4f96-a9ef-817e6111a371"}'],
    ["iso tarih", '{"createdAt": "2026-09-18T11:45:36.907Z"}'],
    ["uzun dosya yolu", "/room/worktrees/backend/node_modules/@agent-rooms/protocol/dist/index.js"],
    ["import satırı", 'import { mapStream } from "@agent-rooms/runner-gemini/dist/map-stream.js";'],
    ["minified js", "function(e,t,n){return e.exports=t(n(42),n(19)),e.exports}"],
    ["base64 png", 'src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="'],
    ["sri integrity", 'integrity: "sha512-9BsAEeHnbzOjPaCPFTPqXBZVuGPrDXFZJXvKJqkqPIiXJm"'],
    ["vitest snapshot", "exports[`ActivityFeed > tam bir turn 1`] = `<section>...</section>`;"],
    ["lorem ipsum", "Loremipsumdolorsitametconsecteturadipiscingelit sed do eiusmod"],
    ["tekrar eden karakter", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
    ["md5 etag", 'etag: "d41d8cd98f00b204e9800998ecf8427e"'],
    ["multipart boundary", "Content-Type: multipart/form-data; boundary=----WebKitFormBoundary7MA4YWxkTrZu0gW"],
    ["semver ve derleme", "version 2.11.0-rc.4+build.20260918"],
    ["camelCase tanımlayıcı", "const ThisIsAVeryLongCamelCaseIdentifierName = 1;"],
    ["docker imaj etiketi", "agent-rooms/room:dev sha256:bd75b7db3339c8cf9460c947a460da708373e618"],
    ["kısa base64", 'Buffer.from("aGVsbG8gd29ybGQ=", "base64")'],
    ["sql sorgusu", "SELECT count(*) FROM session_events WHERE session_id = $1 ORDER BY seq"],
    ["türkçe düz metin", "Randevu oluşturulurken pet_id veritabanında bulunamadı, 404 döndürüldü."],
  ];

  for (const [name, text] of negatives) {
    it(name, () => {
      expect(flagged(text), `yanlış pozitif: ${text}`).toEqual([]);
    });
  }
});

describe("oda YAML'ındaki allow_patterns", () => {
  it("projeye özgü yanlış pozitif susturulabiliyor", () => {
    const text = "FIXTURE_TOKEN=Zt9xQv2LmNpR4sT7uWyA3bCdEfGhJkLm";
    expect(scanEntropy(text).length).toBeGreaterThan(0);
    expect(scanEntropy(text, { allowPatterns: [/^Zt9xQv2/] })).toEqual([]);
  });
});
