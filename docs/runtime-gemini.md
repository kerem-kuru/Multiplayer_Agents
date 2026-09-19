# Koşum ortamı incelemesi — Gemini CLI

`@google/gemini-cli@0.60.0` ile **ölçülerek** çıkarıldı (tahmin değil): kuruldu, gerçek API anahtarıyla üç kez koşturuldu, stdout/stderr ayrı yakalandı.

**Sonuç: `packages/protocol/src/runtime.ts` içindeki dört maddelik sözleşmeyi karşılıyor.** İkinci koşum ortamı olarak uygundur.

## Sözleşme kontrolü

| # | Madde | Durum | Kanıt |
| --- | --- | --- | --- |
| 1 | Yapılandırılmış akış | ✅ | `-o stream-json`; stdout'taki **her satır geçerli JSON** çıktı |
| 2 | Tool kapısı | ✅ | `BeforeTool` / `AfterTool` hook'ları + Policy Engine (`--policy`, `--admin-policy`) |
| 3 | Oturum sürekliliği | ✅ | `--resume`, `--session-id`, `--session-file`, `--list-sessions` |
| 4 | NDJSON'a çevrim | ✅ | Aşağıdaki eşleme neredeyse 1:1 |

`gemini hooks migrate` alt komutunun açıklaması *"Migrate hooks from Claude Code to Gemini CLI"* — hook modeli bilerek uyumlu tutulmuş.

## Ölçülen stdout akışı

```json
{"type":"init","timestamp":"...","session_id":"f933c02f-...","model":"auto"}
{"type":"message","timestamp":"...","role":"user","content":"hello2.txt olustur..."}
{"type":"tool_use","timestamp":"...","tool_name":"write_file",
 "tool_id":"write_file__call_23054","parameters":{"content":"test","file_path":"hello2.txt"}}
{"type":"tool_result","timestamp":"...","tool_id":"write_file__call_23054","status":"success"}
{"type":"message","timestamp":"...","role":"assistant","content":"hello2.txt dosy","delta":true}
{"type":"message","timestamp":"...","role":"assistant","content":"ası başarıyla oluşturuldu.","delta":true}
{"type":"result","timestamp":"...","status":"success",
 "stats":{"total_tokens":25889,"input_tokens":24673,"output_tokens":72,"cached":16245,
          "duration_ms":89862,"tool_calls":1,
          "models":{"gemini-3.1-flash-lite":{...},"gemini-3.5-flash":{...}}}}
```

Dosya gerçekten oluştu ve içeriği doğruydu — CLI işi yapıyor, sadece anlatmıyor.

## Event kataloğumuza eşleme

| Gemini | Bizim | Not |
| --- | --- | --- |
| `init` | `turn.started` | `sdkSessionId = session_id`, `model` |
| `message` role=assistant | `agent.text` | `delta:true` — parçalar birleştirilmeli |
| `message` role=user | — | Bizde `message.received` zaten host tarafında yazılıyor |
| `tool_use` | `tool.call` | `toolUseId = tool_id`, `tool = tool_name`, `input = parameters` |
| `tool_result` | `tool.result` | `isError = status !== "success"` |
| `result` | `turn.completed` | `subtype = status`, `durationMs = stats.duration_ms`, `usage = stats` |
| stderr | sunucu logu | Event log'a yazılmaz |

## Claude SDK'ya göre eksikler

Bunlar engel değil ama **bilerek kabul edilmesi** gereken kayıplar:

| Eksik | Etkisi |
| --- | --- |
| `init` tool listesi vermiyor | `turn.started.tools` boş kalır. Hafta 2 kapısının 6. maddesi (tools == YAML) Gemini için aynı şekilde koşamaz; yetki kanıtı Policy Engine tarafına kayar. |
| `tool_result` sadece `status` veriyor, çıktı içeriği yok | `tool.result.output` boş kalır. Claude'da tool çıktısının metnini alıyoruz, burada alamıyoruz — denetim değeri düşer. `-o json` kipinde daha fazlası var mı, denenmedi. |
| USD maliyet yok | `turn.completed.costUsd` 0 olur. Token sayıları var; fiyat tablosu ekleyip kendimiz hesaplamalıyız (Hafta 11'in maliyet maddesi). |
| `model: "auto"` | Gerçek modeller sadece `result.stats.models` içinde görünüyor — tek turn'de **iki model** kullanıldı (`gemini-3.1-flash-lite` + `gemini-3.5-flash`). Rol başına model yönlendirme (Hafta 11) burada farklı çalışır. |

## Headless çalıştırma notları

- **Güven kapısı:** `--skip-trust` veya `GEMINI_CLI_TRUST_WORKSPACE=true` şart; yoksa CLI hiç başlamıyor.
- **`--approval-mode yolo` KULLANMA.** Tüm tool'ları otomatik onaylar, yani Gemini'nin kendi kapısını kapatır. Yetki kısıtımız `BeforeTool` hook'u veya Policy Engine üzerinden kurulmalı. (Bu incelemede sadece akışı görmek için kullanıldı.)
- **stdout temiz, stderr gürültülü.** Uyarılar, YOLO mesajları ve 503 retry stack trace'leri stderr'e gidiyor. Bizim runner sözleşmemizle birebir uyumlu.
- **Gecikme:** basit bir dosya yazma görevi ücretsiz katmanda 14–90 sn sürdü (bir koşumda 503 alıp geri çekildi). Kapı testlerinde zaman aşımları buna göre ayarlanmalı.
- `ripgrep` container'da kurulu olmalı, yoksa "Falling back to GrepTool" diyor — bizim oda imajında zaten var.

## Uygulama sırasında çıkan üç hata

Ölçüm doğruydu ama entegrasyon üç yerde tökezledi. Üçü de gerçek, üçü de düzeltildi:

**1 — `--allowed-tools` prompt'u yutuyor.** Dizi seçeneği olduğu için
`--allowed-tools a b c -p "metin"` yazınca yargs dizinin sonunu bulamıyor ve
prompt'u pozisyonel argümana çeviriyor:

```
Cannot use both a positional prompt and the --prompt (-p) flag together
```

Çözüm: bayrağı her tool için TEKRARLA (`--allowed-tools a --allowed-tools b`).

**2 — stderr seli heartbeat'i aç bıraktı.** İlk hâlde Gemini'nin her stderr
satırını bir `log` protokol mesajına çevirip stdout'a yazıyorduk. Gemini bir
503 aldığında onlarca satır stack trace döküyor; heartbeat'ler o selin arkasına
sıraya giriyor, 20 sn'yi aşıyor ve host runner'ı ölmüş sanıp `SIGKILL` ediyordu
(`exitCode 137`, ardından yeniden başlatma döngüsü).

Ders: **dış dünyanın sınırsız çıktısı protokol kanalına sokulmaz.** Çocuk
sürecin stderr'i doğrudan runner'ın stderr'ine akıtılıyor; exec katmanı onu
zaten sunucu loguna taşıyor.

**3 — `update_topic` yanlış pozitif.** Gemini'nin kendi iç bakım tool'ları
(oturum başlığı, yapılacaklar listesi) YAML yetkisinin konusu değil ama
allow listesinde olmadıkları için `tool.denied` üretiyorlardı. `save_memory`
bu muafiyete DAHİL DEĞİL — kalıcı veri yazıyor.

Ayrıca `file.changed` yolu mutlak geliyordu (`/room/worktrees/...`); iki koşum
ortamı aynı biçimi versin diye `roomRelativePath()` ile oda-göreli yapıldı.

## Uçtan uca doğrulama

Gerçek görev, gerçek anahtar, container içinde:

```
5:message.received → 6:turn.started → 8:tool.call → 11:file.changed
→ 12:tool.result → 16-18:agent.text → 19:turn.completed
durum: idle · restart: 0
```

`hello.js` gerçekten oluştu ve `merhaba oda` bastı. Turn 11.7 sn sürdü.

## Yapılmadı

- `-o json` (stream olmayan) kipinin tool çıktısını içerip içermediği
- `BeforeTool` hook'unun tam giriş/çıkış şeması — reddetme kararı nasıl döndürülüyor
- Policy Engine dosya formatı
- `--session-id` ile çökme sonrası devam etme

Bunlar `packages/runner-gemini` yazılırken ölçülecek.

## Kesme (Hafta 5'te ölçüldü)

Gemini CLI'ya `SIGTERM` göndermek **onun başlattığı kabuk komutunu durdurmuyor.**
`sleep 120` koşarken kesme istendiğinde CLI kapanmıyor, turn kapanmıyor ve host 30 saniye
sonra runner'ı sert kesiyor:

```
mode = hard_kill · 32 sn
```

Runner artık Gemini sürecini `detached: true` ile **kendi süreç grubunda** başlatıyor ve
sinyali gruba gönderiyor (`process.kill(-pid, "SIGTERM")`, 5 sn sonra `SIGKILL`). Aynı ölçüm:

```
mode = abort · 1 saniyenin altında
```

Grup her yolda öldürülüyor (kesme, `shutdown`, çıkış), yani container içinde sahipsiz süreç
kalmıyor.

## Rol bağlamı: sistem prompt'u yerine `GEMINI.md`

Gemini CLI'da sistem prompt'u veren bir bayrak **yok** (`--help` çıktısında yok), yani rol
YAML'ındaki `systemPrompt` bu koşum ortamına uzun süre hiç ulaşmadı.

Çözüm: runner her başlangıçta agent'ın çalışma alanına `GEMINI.md` yazıyor — CLI çalışma
alanındaki bu dosyayı bağlam olarak okuyor. Dosyanın içinde üç şey var:

1. rol YAML'ındaki `systemPrompt`,
2. çok kişili oda notu (`MULTIPLAYER_PROMPT_NOTE` — Claude yolunda `systemPrompt.append`
   ile giden aynı sabit),
3. **kurulum doğrulama satırı**: "oda kurulumu dogru mu" sorusuna `ODA-KURULUMU-OK <rol>`
   cevabı.

Üçüncüsü ölçüm için: "model rolünü biliyor mu" sorusunu serbest metinden okumak güvenilmez,
cevabı dosyadan mı mesajdan mı çıkardığı belirsiz kalır. Bu satırın tek kaynağı dosyadır.
`gate:w5:agent` hem dosyanın diskte olduğunu hem modelin o satırı yazdığını doğruluyor —
ölçüldü, geçti.

Dosya her başlangıçta **üzerine yazılır**: tek kaynak rol YAML'ı, dosyanın elle düzenlenmiş
hâli değil. Yazılamazsa turn engellenmez, `log` ile söylenir (rolsüz agent çalışır ama
rolünü bilmez).

İki yol birbirinin **yedeği**: Claude tarafında sistem prompt'u, Gemini tarafında bağlam
dosyası. Anahtar beklemeden rol sistemi bu yolla doğrulanabiliyor.
