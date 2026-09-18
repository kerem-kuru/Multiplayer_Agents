# Hafta 3 — Stream ve terminal görünümü

**Biten iş (kapı):** Tarayıcıda agent'ın çalışmasını canlı izliyorsun. Sekmeyi kapatıp
açtığında tek bir event kaybolmadan kaldığın yerden devam ediyor.

**Durum:** ✅ bitti. `npm run gate:w3` 11/11 (anahtar gerektirmez) ve `npm run gate:w3:agent`
2/2 (Gemini koşum ortamına karşı, 18 Eylül 2026).

## Görev listesi

| # | Adım | Durum |
| --- | --- | --- |
| 1 | Event bus (`packages/core/src/bus.ts`) + commit sonrası publish | ✅ |
| 2 | REST: `GET /rooms`, `GET /rooms/:id/events?since&limit` (`hasMore`) | ✅ |
| 3 | SSE ucu: abone ol → DB oku → tamponu boşalt → canlı | ✅ |
| 4 | Başsız SSE probe (`scripts/sse-probe.mjs`) | ✅ |
| 5 | Saf projeksiyon (`apps/web/src/model/project.ts`) | ✅ 11 birim testi |
| 6 | Akış hook'u (`useEventStream.ts`) | ✅ |
| 7 | Tasarım tokenları (kağıt/ekran ayrımı) | ✅ |
| 8 | Etkinlik akışı + `formatTool` | ✅ 15 birim testi (bu hafta eklendi) |
| 9 | Terminal (xterm.js, rAF ile batch yazım, salt okunur) | ✅ |
| 10 | Sayfa, agent çubuğu, gönderme alanı | ✅ |
| 11 | Tarayıcı testleri (Playwright, 2 test) | ✅ geçti |
| 12 | Kapı script'i (`scripts/week3-gate.sh`) | ✅ 11/11 |
| 13 | Cuma dogfood | ✅ README'de |
| 14 | README | ✅ |

## Kapının iki parçaya bölünmesi

Kapının 11 kontrolü akışı ölçüyor ve event'leri dev ucundan üretiyor: gerçek event,
gerçek DB, gerçek SSE — ama deterministik ve ücretsiz. Agent gerektiren iki kontrol
(tarayıcı testleri) `gate:w3:agent` altında ayrı duruyor. Gerekçe README "Karar
notları"nda; özeti: canlı agent kapıyı yavaşlatıp kararsızlaştırır, ölçtüğü şeye
hiçbir şey katmadan.

## Tarayıcı kapısı ilk koşumda üç şey buldu

Testler yazıldıklarında koşulamamıştı (kota yoktu). İlk gerçek koşumda üçü de çıktı:

1. **`başlat` iki düğmede geçiyor** — agent çubuğunda (`başlat`) ve gönderme alanında
   (agent durmuşken `Başlat`). Playwright ad eşlemesi büyük/küçük harfe duyarsız;
   seçici `nav`'a daraltıldı.
2. **Hazır olma yarışı (testte).** "başlat"a basıldıktan hemen sonra gönderme alanı
   etkin görünüyor, çünkü `agent.starting` event'i henüz gelmedi. Test yazıyor, sunucu
   `409` dönüyor, mesaj hiç gitmiyor ve test 180 sn bekleyip düşüyor. Test artık agent
   çubuğunda `idle` bekliyor — hazır olmanın tek dürüst kanıtı event'in ekrana düşmesi.
3. **Aynı yarış kullanıcıda da var (üründe).** `Composer` artık `starting` durumunda da
   kilitli ("Agent başlıyor — birkaç saniye"). Alanın "açık" olması "gönderilebilir"
   demek olmalı.

Üçüncüsü testin değil ürünün hatasıydı: kapıyı koşmasaydık kullanıcı bulacaktı.

## Ölçümler (kapı çıktısı)

| Kontrol | Sonuç |
| --- | --- |
| Geçmiş replay | boşluk 0, tekrar 0 |
| Canlı akış | yeni event'ler 2 sn içinde |
| Frame batch'leme | event/frame = 4,8 (eşik 1,5) |
| Kopma + boşluk doldurma | `--drop-after 3` sonrası toplam = DB `max(seq)` |
| `Last-Event-ID` | query'yi eziyor, ilk event `seq=4` |
| Üç eşzamanlı izleyici | aynı event kümesi (`diff` temiz) |
| Sızıntı | 10 bağlan-kopar sonrası abone 0, heap +0,5 MB |
| Birim testleri | 82 test |
| Tarayıcı testleri | 2/2, turn başına ~21 sn (Gemini) |

## Agent sayısı kontrolü

YAML'a üçüncü bir `docs` agent'ı eklendi, hiçbir koda dokunulmadı: `GET /rooms/:id/agents`
üçünü döndü, sol çubuk üçünü de çizdi. Geçici YAML silindi.

## Dogfood

README "Hafta 3 dogfood notları" başlığında. Üç cevabın özeti: **Terminal sekmesi bu
koşum ortamında bilgi taşımıyor** (Gemini tool çıktısı vermiyor), **`replace` satırı ne
değiştiğini söylemiyor** (diff Hafta 6'da, dogfood onu en üstteki ihtiyaç olarak
doğruladı) ve **gürültünün kaynağı koşum ortamının iç tool'ları** (`update_topic`,
turn'ün %43'ü) ile ham markdown metni.

## Kalan iş

- `gate:w2` (14 kontrol) hâlâ koşulmadı: `ANTHROPIC_API_KEY` yok.
- Hafta 2 dogfood'u aynı sebeple bekliyor.
