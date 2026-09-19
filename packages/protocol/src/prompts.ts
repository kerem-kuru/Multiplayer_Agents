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
 * Claude yolunda sistem prompt'una eklenen tam metin: rol + çok kişili oda
 * notu + (ölçülmüşse) alet çantası.
 *
 * Gemini tarafındaki `GEMINI.md` ile AYNI parçalar. İki koşum ortamına iki
 * ayrı metin yazmak, birinin diğerinden sessizce ayrılması demekti.
 */
export function claudeSystemAppend(
  systemPrompt: string,
  toolchain?: ReadonlyArray<{ label: string; version: string | null }>,
): string {
  const parts = [appendMultiplayerNote(systemPrompt)];
  if (toolchain && toolchain.length > 0) parts.push(toolchainNote(toolchain));
  return parts.join("\n\n");
}

/**
 * Ortamda NE VAR sorusunun cevabı — TAHMİN DEĞİL ÖLÇÜM.
 *
 * Gerçekte oldu: agent'a "Django ile blog sitesi yaz" dendi, agent doğru
 * davranıp durdu ve "Python yüklü değil, sistem düzeyinde kurulum iznim yok"
 * dedi. Yetki sınırı değildi — oda imajında Python yoktu. Ekrandaki his ise
 * "sınırsız yetki verdim, hâlâ yapamıyor" oldu.
 *
 * İki şey gerekiyordu: (1) imajda gerçekten Python olması, (2) agent'ın ne
 * olduğunu DENEMEDEN bilmesi. İkincisi burada: runner başlangıçta bu
 * komutları koşup çıktısını rol bağlamına yazıyor. Liste elle yazılmış bir
 * iddia olsaydı imajla arasında kayma olurdu; ölçüm kayamaz.
 */
export const ROOM_TOOLCHAIN_PROBES: ReadonlyArray<{ label: string; cmd: string; args: string[] }> =
  [
    { label: "node", cmd: "node", args: ["--version"] },
    { label: "npm", cmd: "npm", args: ["--version"] },
    { label: "python", cmd: "python3", args: ["--version"] },
    { label: "pip", cmd: "pip", args: ["--version"] },
    { label: "git", cmd: "git", args: ["--version"] },
    { label: "rg", cmd: "rg", args: ["--version"] },
  ];

/**
 * Ölçüm çıktısından sadece sürümü al.
 *
 * `pip --version` "pip 26.2.1 from /opt/venv/lib/python3.11/site-packages/pip
 * (python 3.11)" diyor; bunu olduğu gibi yazınca satır okunmaz oluyor ve
 * agent'ın okuyacağı metin gürültüye dönüyor.
 */
function shortVersion(raw: string): string {
  return (/\d[\w.+-]*/.exec(raw)?.[0] ?? raw.trim()).slice(0, 24);
}

/** Ölçülmüş sürümlerden rol bağlamına girecek metni kur. */
export function toolchainNote(found: ReadonlyArray<{ label: string; version: string | null }>): string {
  const available = found.filter((f) => f.version !== null);
  const missing = found.filter((f) => f.version === null).map((f) => f.label);

  const lines = [
    "Bu oda izole bir container: içinde her şeyi yapabilirsin (dosya yaz, komut çalıştır,",
    "paket kur) ama SİSTEM PAKETİ kuramazsın — root değilsin, `apt` çalışmaz.",
    "",
    `Kurulu: ${available.map((f) => `${f.label} ${shortVersion(f.version!)}`).join(", ") || "(ölçülemedi)"}`,
  ];
  if (missing.length > 0) {
    lines.push(
      `Ortamda YOK: ${missing.join(", ")}. Bunları gerektiren bir görevde uydurma bir yol`,
      "arama; neyin eksik olduğunu söyle ve varsa kurulu araçlarla bir alternatif öner.",
    );
  }
  lines.push(
    "",
    "Python paketleri `/opt/venv` içine kurulur ve `pip install <paket>` doğrudan çalışır",
    "(sistem python'una kurmayı deneme, Debian PEP 668 ile engelliyor).",
    "Çalışma alanın dışına yazamazsın: kendi `worktrees/<rol>` klasörün ve `contracts/`",
    "yazılabilir, gerisi salt okunur.",
  );
  return lines.join("\n");
}

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
export function geminiContextFile(
  agent: { name: string; systemPrompt: string },
  /** Ölçülmüş alet çantası. Verilmezse o bölüm yazılmaz — uydurulmaz. */
  toolchain?: ReadonlyArray<{ label: string; version: string | null }>,
): string {
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
    ...(toolchain && toolchain.length > 0
      ? ["## Ortamda ne var", "", toolchainNote(toolchain), ""]
      : []),
    "## Kurulum doğrulama",
    "",
    `Bir insan "${SETUP_PROBE_QUESTION}" diye sorarsa, başka hiçbir şey yazmadan`,
    `yalnızca şu satırı yaz: ${SETUP_PROBE_ANSWER} ${agent.name}`,
    "",
  ].join("\n");
}
