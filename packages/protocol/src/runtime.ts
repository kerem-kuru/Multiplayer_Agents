import { z } from "zod";

/**
 * Agent koşum ortamı — hangi binary'nin container içinde koştuğu.
 *
 * NEDEN BU DİKİŞ VAR: en iyi model her yıl değişiyor. Odanın değeri modelde
 * değil, agent'ların okuyup yazdığı paylaşılan bağlamda. Bu yüzden koşum
 * ortamı değiştirilebilir olmalı.
 *
 * MİMARİYİ DEĞİŞTİRMİYOR: runner zaten container içinde ayrı bir süreç ve
 * host ile arasındaki tek bağ NDJSON. Host (AgentManager, event log, API)
 * hangi binary'nin koştuğunu bilmiyor. Yeni bir koşum ortamı eklemek, aynı
 * dikişe ikinci bir fiş takmaktır — host tarafında tek satır değişmez.
 *
 * ── Yeni bir koşum ortamının sağlaması gereken sözleşme ──────────────────
 *
 * 1. YAPILANDIRILMIŞ AKIŞ. Altındaki CLI/SDK, tool çağrılarını ve sonuçlarını
 *    makine tarafından okunabilir biçimde vermeli. Sadece insan için biçimlenmiş
 *    metin veren bir CLI kabul EDİLEMEZ — "hiçbir yerde metin kazıma yok"
 *    kuralı bunu yasaklar. (Değerlendirmeden önce o CLI'ın non-interactive /
 *    JSON çıktı kipi olduğunu doğrula.)
 *
 * 2. TOOL KAPISI. Bir tool çalıştırılmadan ÖNCE araya girilebilmeli ki rol
 *    YAML'ındaki `toolsAllow`/`toolsDeny` zorlanabilsin ve reddedilen çağrı
 *    `tool.denied` olarak log'a düşsün. Hook yoksa bu katman kaybolur; geriye
 *    container sınırı ve dosya izinleri (Hafta 7) kalır — daha zayıf ama sıfır
 *    değil. Bu durumda README'ye açıkça yazılmalı.
 *
 * 3. OTURUM SÜREKLİLİĞİ. Çökme sonrası sohbeti sürdürebilmek için bir oturum
 *    kimliği veya geçmiş yeniden yükleme yolu olmalı (`turn_end.sdkSessionId`).
 *
 * 4. NDJSON PROTOKOLÜ. Host ile konuşma dili `runner-protocol.ts`'tir; koşum
 *    ortamı kendi akışını BİZİM event kataloğumuza çevirir. Katalog zaten
 *    sağlayıcı-bağımsız: `tool.call`, `tool.result`, `turn.completed` hiçbir
 *    yerde "Claude" demiyor.
 */

export const RuntimeKind = z.enum(["claude"]);
export type RuntimeKind = z.infer<typeof RuntimeKind>;

/**
 * Sağlayıcı seçimi ortam değişkenleriyle yapılır ve host'tan container'a
 * OLDUĞU GİBİ geçirilir. Oda konfigürasyonuna yazılmaz: bunlar dağıtım ayarı,
 * rol tanımı değil — ve kimlik bilgisi içerirler, YAML'a girmemeleri gerekir.
 *
 * Aynı Claude modelleri; sadece nereden servis edildikleri değişir.
 */
export const PROVIDER_ENV_NAMES: readonly string[] = [
  // Hangi arka uç
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_GATEWAY",
  // Doğrudan / gateway
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  // Bedrock
  "ANTHROPIC_BEDROCK_BASE_URL",
  "AWS_BEARER_TOKEN_BEDROCK",
  // Vertex
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
];

/** Kimlik bilgisi taşıyan aileler — tek tek saymak yerine önek. */
export const PROVIDER_ENV_PREFIXES: readonly string[] = [
  "AWS_",
  "GOOGLE_",
  "GCLOUD_",
  "CLOUD_ML_",
];

export function isProviderEnv(name: string): boolean {
  return (
    PROVIDER_ENV_NAMES.includes(name) ||
    PROVIDER_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/**
 * Host ortamından sağlayıcı değişkenlerini toplar.
 *
 * Bu, AWS/Google kimlik bilgilerini container'a geçirmek demektir ve
 * BİLEREK yapılır: SDK'nın Bedrock/Vertex'e bağlanabilmesi için başka yolu
 * yok. Agent'ın bu değişkenleri okuyabileceğini unutma — Hafta 4'teki
 * redaction bunları stream'e sızdırmamakla yükümlü.
 */
export function collectProviderEnv(
  source: Record<string, string | undefined> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || value === "") continue;
    if (isProviderEnv(name)) out[name] = value;
  }
  return out;
}

/** Sağlayıcı seçili mi — seçiliyse API anahtarı zorunlu değildir. */
export function hasProviderBackend(source: Record<string, string | undefined> = {}): boolean {
  return (
    source.CLAUDE_CODE_USE_BEDROCK === "1" ||
    source.CLAUDE_CODE_USE_VERTEX === "1" ||
    source.CLAUDE_CODE_USE_FOUNDRY === "1" ||
    source.CLAUDE_CODE_USE_GATEWAY === "1" ||
    Boolean(source.ANTHROPIC_BASE_URL) ||
    Boolean(source.ANTHROPIC_AUTH_TOKEN)
  );
}
