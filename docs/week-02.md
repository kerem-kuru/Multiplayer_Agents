# Hafta 2 — Tek agent, headless koşum

**Biten iş (kapı):** `curl` ile agent'a görev veriyorsun, agent container içinde gerçekten kod yazıyor, attığı her adım DB'de yapılandırılmış event olarak duruyor. Hiçbir yerde metin kazıma yok.

**Durum:** Kod tamam, `npm run gate:w2` **koşulmadı** — 14 kontrolün hepsi gerçek API çağrısı gerektiriyor ve makinede `ANTHROPIC_API_KEY` yok. Aşağıda anahtarsız doğrulanabilen her şeyin sonucu var.

## Görev listesi

| # | Görev | Durum |
| --- | --- | --- |
| 1 | Ortam değişkenleri (`ANTHROPIC_API_KEY`, `AGENT_MODEL`, bütçe, heartbeat) | ✅ |
| 2 | Rol config: tool isimleri enum | ✅ |
| 3 | Tool eşlemesi `packages/protocol/src/tools.ts` | ✅ |
| 4 | Yeni event tipleri | ✅ |
| 5 | Runner protokolü (NDJSON, Zod) | ✅ |
| 6 | `packages/runner` + SDK turn döngüsü + `map-messages` | ✅ |
| 7 | Oda imajı: runner + SDK | ✅ |
| 8 | `agent_runtime` tablosu + durum makinesi | ✅ |
| 9 | Exec katmanı (dockerode, stdio demux) | ✅ |
| 10 | `AgentManager` (spawn, sağlık, çökme, mutabakat) | ✅ |
| 11 | API uçları | ✅ |
| 12 | `validate-events` | ✅ |
| 13 | `week2-gate.sh` (14 kontrol) | ⏳ yazıldı, koşulmadı |
| 14 | Cuma dogfood | ⏳ anahtar bekliyor |
| 15 | README | ✅ |

## SDK doğrulaması (Adım 5)

Görev tanımı "kurulu sürümün tipleri bu dokümandan önceliklidir" diyor. `0.3.274` kuruldu ve `.d.ts` dosyaları tek tek okundu: **dokümandaki her seçenek adı ve imzası birebir doğru, tek bir sapma yok.**

Üç not:

- `permissionPrompts: 'host' | 'none'` mevcut → dokümanın önerdiği `canUseTool` yedek planına gerek kalmadı.
- `SDKMessage` birleşimi **~38 üyeli** (doküman 4'ünü anlatıyor). `mapMessage` bilmediği her tipi sessizce atlıyor — bilinmeyen mesaj hata değil.
- `Options.env` verilirse alt süreç ortamını **birleştirmez, tamamen değiştirir**. Bu yüzden hiç set edilmiyor; edilseydi `PATH` ve `ANTHROPIC_API_KEY` kaybolurdu.

## Mimari

```
host                                  container
────────────────────────────────      ──────────────────────────────
apps/api → AgentManager               /opt/runner/dist/runner.js
  ├─ dockerode exec ──────────────▶     ├─ stdin : NDJSON komut
  ├─ stdout satırları ◀───────────      ├─ stdout: NDJSON çıktı
  └─ appendEvent (SIRALI)               └─ Claude Agent SDK query()
                                             cwd = /room/worktrees/<agent>
```

**SDK neden container içinde:** `Bash` ve `Edit` tool'ları sürecin bulunduğu yerde çalışır. SDK host'ta koşsaydı agent host dosya sisteminde komut çalıştırırdı ve sandbox anlamsızlaşırdı. Host sadece yönetir.

**NDJSON neden metin kazıma değil:** aradaki her satır bizim tanımladığımız bir şemadır ve Zod ile doğrulanır. Agent'ın ürettiği serbest metin hiçbir zaman parse edilmez — sadece `agent.text` payload'ında taşınır.

## Event kataloğu değişti

Hafta 1'in agent event'leri gerçek SDK görülmeden tasarlanmıştı. Bu hafta SDK'ya göre yeniden yazıldı; zarf (`seq`, `roomId`, `sessionId`, `ts`, `actor`) aynı kaldı.

| Hafta 1 | Hafta 2 | Sebep |
| --- | --- | --- |
| `agent.spawned` | `agent.starting` + `agent.ready` | Süreç başlatma ile hazır olma ayrı olaylar; arada 30 sn'lik bir pencere var |
| — | `agent.crashed` | Beklenen çıkışla (`agent.exited`) beklenmeyeni ayırmak şart |
| `agent.message` | `message.received` | Turn'ün başlangıç noktası, agent'ın kendi mesajı değil |
| `turn.ended` | `turn.completed` + `turn.failed` | Başarı ve başarısızlık farklı alanlar taşıyor |
| `tool.called` | `tool.call` | — |
| — | `agent.text`, `tool.denied` | Metin ve reddedilen tool çağrısı ayrı izlenmeli |

Turn içindeki her event artık `messageId` taşımak **zorunda** — hangi mesaja ait olduğu belirsiz bir event log'u okunamaz kılar. `validate-events` bunu denetliyor.

## Tool yetkisi üç katmanda

Hiçbiri sistem prompt'u değil:

- **(a)** SDK `tools` — agent sadece bunları görür
- **(b)** SDK `disallowedTools` — yasaklılar kaldırılır
- **(c)** `PreToolUse` hook'u — her çağrı YAML'a karşı son kez kontrol edilir, reddedilen `tool.denied` olarak log'a düşer

`turn.started.tools` SDK'nın `init` mesajından okunuyor — YAML'ın iddiası değil, SDK'nın gerçekten açtığı liste. Kapı testinin 6. maddesi ikisini karşılaştırıyor.

## Anahtarsız doğrulananlar

| Ne | Sonuç |
| --- | --- |
| `npm run typecheck` (runner dahil) | temiz |
| 36 test (8'i `map-messages`) | geçiyor |
| Oda imajında SDK yükleniyor mu | `query: function` |
| Runner env eksikken | temiz hata, çıkış kodu 2 |
| Runner heartbeat üretimi | 5 sn'de bir, düzenli |
| `agent.starting → agent.ready` + durum `idle` | ✓ gerçek `runnerPid` ile |
| 45 sn boşta bekleme | çökme yok, `restart_count=0` |
| `POST .../stop` | `agent.exited(stopped)`, exitCode 0, container'da 0 kalıntı süreç |
| Sunucu yeniden başlatma mutabakatı | `agent.exited(server_restart)`, durum `stopped`, sahipsiz runner temizlendi |
| Anahtar imajda görünüyor mu | `docker history` → yok |
| SDK host kodunda | `grep claude-agent-sdk apps/api/src packages/core/src` → sonuç yok |

## Canlı testte bulunan hata

İlk yaşam döngüsü denemesinde agent `ready` olduktan kısa süre sonra `agent.crashed (exitCode 137)` ile öldü ve otomatik yeniden başladı. Heartbeat zaman aşımı 20 sn iken bu süre geçmemişti.

Runner'ı container'da elle koşturunca heartbeat'lerin düzenli üretildiği görüldü — yani sorun host tarafındaydı. Kodda gerçek bir yarış durumu bulundu:

`startRunnerExec()` docker akışını **dönmeden önce** tüketmeye başlıyor, ama çağıran `onLine`'ı ancak fonksiyon döndükten sonra kaydedebiliyor. O aralıkta gelen satırlar hiçbir dinleyiciye ulaşmadan kayboluyordu. Kaybolan bir `ready` satırı agent'ı 30 sn "starting"de bırakır; kaybolan heartbeat'ler sahte zaman aşımı üretir.

İki düzeltme:

1. **Exec katmanı tamponluyor** — dinleyici kaydolana kadar gelen satırlar biriktirilip sırayla teslim ediliyor.
2. **Canlılık herhangi bir satıra bağlandı** — heartbeat'e değil. İş üretip heartbeat'i kaçıran bir runner boşuna öldürülmemeli.

Düzeltme sonrası 45 saniyelik bekleme testinde çökme tekrarlamadı.

## Kalan iş

Sadece anahtar bekleyenler:

1. `npm run gate:w2` — 14 kontrol
2. Adım 14: Cuma dogfood — gerçek bir klasörle gerçek bir görev, sonra README'ye 3-5 maddelik not

`ANTHROPIC_API_KEY` `.env`'e eklendiği anda ikisi de koşulabilir.

## Not

Tek sunucu örneği varsayımı geçerli: `AgentManager` bellekte tutuluyor ve ikinci bir sunucu örneği açılış mutabakatında birincinin runner'larını öldürür. Çok sunuculu dağıtım Redis ile sonraki fazlarda.
