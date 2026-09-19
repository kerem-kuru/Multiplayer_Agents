/**
 * Agent'ın sistem prompt'una eklenen ortak metinler.
 *
 * TEK SABİT, TEK YER: her agent aynı metni alır. Rol YAML'ındaki
 * `system_prompt` agent'a özeldir; buradaki not odanın kendisiyle ilgilidir ve
 * agent'tan agent'a değişmez.
 */

/**
 * Hafta 5: odada birden fazla insan var.
 *
 * Kuyruktan çıkan her mesaj runner'a `[İsim]: ...` olarak verilir. Agent bu
 * önekin ne demek olduğunu bilmezse iki kişinin yönergesini tek bir kişinin
 * fikir değiştirmesi sanar ve kime cevap verdiğini kaybeder.
 */
export const MULTIPLAYER_PROMPT_NOTE = [
  "Bu odaya birden fazla kişi yazabilir. Her kullanıcı mesajı `[İsim]: ` ile başlar.",
  "Cevabında kime yanıt verdiğini belirt.",
  "Kişiler çelişen yönergeler verirse durumu belirt ve hangisini uyguladığını söyle.",
].join(" ");

/** Rol YAML'ındaki metnin yanına eklenir; ikisi arasında boş satır bırakılır. */
export function appendMultiplayerNote(systemPrompt: string): string {
  const base = systemPrompt.trim();
  return base.length > 0 ? `${base}\n\n${MULTIPLAYER_PROMPT_NOTE}` : MULTIPLAYER_PROMPT_NOTE;
}

/**
 * Kurulumun modele ULAŞTIĞINI kanıtlayan satır.
 *
 * "Rol prompt'u gitti mi" sorusunun serbest metinden okunması güvenilmez:
 * model rolünü doğru anlatsa da bunu dosyadan mı yoksa mesajdan mı çıkardığı
 * belirsiz kalır. Bu satır belirli bir soruya belirli bir cevap bağlıyor ve
 * cevabın tek kaynağı bu dosya.
 */
export const SETUP_PROBE_QUESTION = "oda kurulumu dogru mu";
export const SETUP_PROBE_ANSWER = "ODA-KURULUMU-OK";

/**
 * Gemini koşum ortamının bağlam dosyası (`GEMINI.md`).
 *
 * Gemini CLI'da sistem prompt'u veren bir bayrak YOK (`--help` çıktısında
 * yok); rol prompt'u bu yüzden o koşum ortamına hiç ulaşmıyordu. CLI çalışma
 * alanındaki `GEMINI.md` dosyasını bağlam olarak okuyor — rol sistemi bu yolla
 * anahtar beklemeden doğrulanabiliyor ve Claude yolunun
 * `systemPrompt.append`'i ile birbirinin yedeği oluyor.
 *
 * Dosya her agent başlangıcında ÜZERİNE YAZILIR: tek kaynak rol YAML'ı,
 * dosyanın elle düzenlenmiş hâli değil.
 */
export function geminiContextFile(agent: { name: string; systemPrompt: string }): string {
  return [
    `# Oda rolü: ${agent.name}`,
    "",
    "<!-- ÜRETİLMİŞ DOSYA — her agent başlangıcında rol YAML'ından yeniden",
    "     yazılır. Elle düzenlemek kalıcı değildir. -->",
    "",
    "## Rolün",
    "",
    agent.systemPrompt.trim(),
    "",
    "## Bu odada birden fazla insan var",
    "",
    MULTIPLAYER_PROMPT_NOTE,
    "",
    "## Kurulum doğrulama",
    "",
    `Bir insan "${SETUP_PROBE_QUESTION}" diye sorarsa, başka hiçbir şey yazmadan`,
    `yalnızca şu satırı yaz: ${SETUP_PROBE_ANSWER} ${agent.name}`,
    "",
  ].join("\n");
}
