import { describe, expect, it } from "vitest";
import { missingCredentials, modelFor } from "../src/agents/manager.js";

/**
 * Bu kontrol 21 Eylül'de gerçekte olan bir hatadan doğdu: Gemini anahtarı
 * tanımlıyken Claude runtime'lı bir agent başlatıldı, container açıldı, runner
 * kalktı ve hata ancak container İÇİNDE oluştu — "Not logged in · Please run
 * /login". SDK bunu normal metin olarak döndürdüğü için turn `completed`
 * yazıldı ve ekranda yeşil bir "tamamlandı" göründü.
 *
 * Testler saf fonksiyonu ölçüyor: docker, DB ve model yok.
 */

const claude = { name: "frontend", runtime: "claude" as const };
const gemini = { name: "backend", runtime: "gemini" as const };
const none = { apiKey: "", geminiApiKey: "", providerEnv: {} };

describe("missingCredentials", () => {
  it("Claude agent'ı anahtarsız başlatılamaz ve sebep agent adını taşır", () => {
    const msg = missingCredentials(claude, none);
    expect(msg).toContain("frontend");
    expect(msg).toContain("ANTHROPIC_API_KEY");
  });

  it("anahtar varsa engel yok", () => {
    expect(missingCredentials(claude, { ...none, apiKey: "sk-test" })).toBeNull();
  });

  it("BAŞKA koşum ortamının anahtarı gerekçe değildir", () => {
    // Asıl hata buydu: Gemini anahtarı yöneticiyi kurmaya yetiyor, ama bir
    // Claude agent'ını başlatmaya yetmez.
    expect(missingCredentials(claude, { ...none, geminiApiKey: "g-test" })).not.toBeNull();
    expect(missingCredentials(gemini, { ...none, apiKey: "sk-test" })).not.toBeNull();
  });

  it("sağlayıcı arka ucunda anahtar ARANMAZ — kimlik dışarıdan gelir", () => {
    // Bedrock/Vertex/gateway kurulumlarında ANTHROPIC_API_KEY yoktur. Burada da
    // anahtar istemek çalışan bir kurulumu kırardı.
    for (const env of [
      { CLAUDE_CODE_USE_BEDROCK: "1" },
      { CLAUDE_CODE_USE_VERTEX: "1" },
      { ANTHROPIC_BASE_URL: "https://gateway.example" },
      { ANTHROPIC_AUTH_TOKEN: "t" },
    ]) {
      expect(missingCredentials(claude, { ...none, providerEnv: env })).toBeNull();
    }
  });

  it("Gemini agent'ı kendi anahtarını ister", () => {
    expect(missingCredentials(gemini, none)).toContain("GEMINI_API_KEY");
    expect(missingCredentials(gemini, { ...none, geminiApiKey: "g-test" })).toBeNull();
  });

  it("sağlayıcı arka ucu Gemini'yi KURTARMAZ", () => {
    // Sağlayıcı bayrakları Claude'un arka ucunu seçer; Gemini CLI onları
    // okumaz. İkisini tek koşula bağlamak, anahtarsız bir Gemini agent'ının
    // sessizce başlamasına yol açardı.
    const env = { CLAUDE_CODE_USE_BEDROCK: "1" };
    expect(missingCredentials(gemini, { ...none, providerEnv: env })).not.toBeNull();
  });
});

describe("modelFor", () => {
  const claudeAgent = { runtime: "claude" as const, model: "claude-sonnet-5" };
  const geminiAgent = { runtime: "gemini" as const, model: "auto" };

  it("override yoksa rol YAML'ındaki model geçerli", () => {
    expect(modelFor(claudeAgent)).toBe("claude-sonnet-5");
    expect(modelFor(geminiAgent)).toBe("auto");
  });

  it("global override YAML'ı ezer — kapılar maliyeti böyle düşürüyor", () => {
    expect(modelFor(claudeAgent, {}, "claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5-20251001");
  });

  it("koşum ortamına özel override global olanı ezer", () => {
    // Asıl tuzak: .env'de Gemini için bırakılmış bir AGENT_MODEL, Claude
    // anahtarı bağlandığı gün Claude agent'ına da gidiyordu.
    const byRuntime = { gemini: "gemini-3.1-flash-lite", claude: "claude-sonnet-5" };
    expect(modelFor(geminiAgent, byRuntime, "hepsine-bu")).toBe("gemini-3.1-flash-lite");
    expect(modelFor(claudeAgent, byRuntime, "hepsine-bu")).toBe("claude-sonnet-5");
  });

  it("yalnızca bir koşum ortamı ayarlandıysa diğeri globale düşer", () => {
    expect(modelFor(claudeAgent, { gemini: "gemini-3.1-flash-lite" })).toBe("claude-sonnet-5");
  });
});
