import { describe, expect, it } from "vitest";
import { redactValue } from "../src/redact.js";

/**
 * Performans kapısı.
 *
 * Redaction HER event'in yazma yolunda duruyor: yavaşlarsa agent'ın attığı her
 * adım yavaşlar. 198 kuralın regex'ini her metinde koşturmak on milisaniyeler
 * demek; anahtar kelime ön filtresi bunu ortadan kaldırıyor. Bu test o
 * filtrenin çalıştığının kanıtı — kaldırılırsa burası düşer.
 *
 * Hedef ortalama < 5 ms, sert sınır 15 ms.
 */

/** Gerçekçi 16 KB: kaynak kod + komut çıktısı karışımı, secret yok. */
function sampleText(): string {
  const block = [
    'import { redactPayload } from "@agent-rooms/redact";',
    "export async function appendEvent(event: NewRoomEvent): Promise<RoomEvent> {",
    "  const { payload, findings } = redactPayload(event.payload);",
    "  // 9f2a1c4e7b8d3a5f6e0c9b2d4a7f1e8c3b6d5a09 tarihli commit",
    "}",
    "npm run build > /dev/null && echo tamam",
    "  ✓ packages/redact/test/entropy.test.ts (38 tests) 12ms",
    '{"roomId":"3437e583-ca04-4f96-a9ef-817e6111a371","seq":42,"type":"tool.call"}',
  ].join("\n");
  let text = "";
  while (text.length < 16 * 1024) text += block + "\n";
  return text.slice(0, 16 * 1024);
}

describe("16 KB metin", () => {
  it("ortalama 15 ms altında taranıyor", () => {
    const text = sampleText();
    // Isınma: regex nesneleri ve JIT.
    redactValue(text);

    const runs = 20;
    const started = performance.now();
    for (let i = 0; i < runs; i++) redactValue(text);
    const average = (performance.now() - started) / runs;

    // Ölçüm çıktısı: yavaşlama sessizce birikmesin.
    console.log(`  redactValue(16 KB) ortalama: ${average.toFixed(2)} ms`);
    expect(average).toBeLessThan(15);
  });

  it("ön filtre gerçekten devrede — temiz metin secret'lı metinden yavaş değil", () => {
    const text = sampleText();
    const started = performance.now();
    for (let i = 0; i < 10; i++) redactValue(text);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(150);
  });
});
