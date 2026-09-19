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
