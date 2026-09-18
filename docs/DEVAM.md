# Kaldığımız yer — 18 Eylül 2026

Bu dosya oturum sonu devir notudur. Yarın buradan devam edilir.

## Tek cümleyle

**Hafta 3 bitti** — akış kapısı 11/11 ve agent gerektiren iki tarayıcı testi de geçti,
dogfood yapıldı ve notları README'de. Sırada **Hafta 4**: redaction, snapshot, presence,
oda paylaşım linki, basit auth.

## Durum tablosu

| Hafta | Konu | Durum |
| --- | --- | --- |
| 1 | İskelet ve event log | ✅ `npm run gate` → 10/10 |
| 2 | Tek agent, headless koşum | ⏳ kod tamam, `gate:w2` **koşulmadı** (Claude anahtarı yok) · boru hattı Gemini ile doğrulandı (`npm run smoke:gemini`) |
| 3 | Stream ve terminal görünümü | ✅ `gate:w3` 11/11 · `gate:w3:agent` 2/2 (Gemini) · dogfood ✅ |

Birim testleri: **82** (bu oturumda `format-tool` için 15 test eklendi; Hafta Sonu Tanımı
"bus, projeksiyon ve format-tool testleri" diyordu, format-tool testsizdi).

## Bu oturumda ne oldu

1. **Tarayıcı kapısı ilk kez koşuldu** ve üç şey buldu (ayrıntı `docs/week-03.md`):
   - `başlat` iki düğmede geçiyor → seçici `nav`'a daraltıldı,
   - test "başlat"tan sonra alanı etkin sanıp erken yazıyordu → artık `idle` bekliyor,
   - **ürün hatası:** `Composer` `starting` durumunda açıktı, sunucu `409` dönüyordu →
     artık kilitli ("Agent başlıyor — birkaç saniye").
2. **Üçüncü agent kontrolü:** YAML'a `docs` agent'ı eklendi, koda dokunulmadan arayüzde
   üçüncü satır çıktı; geçici YAML silindi.
3. **Dogfood:** kendi FastAPI projem (118 satır, secret yok) worktree'ye kopyalandı,
   gerçek görev verildi (GET uçları + 404 kontrolü), 52,9 sn'de doğru yapıldı ve baştan
   sona ekrandan izlendi. Üç sorunun cevabı README'de.

## Neyi engelleyen ne

| Anahtar | Durum | Etkisi |
| --- | --- | --- |
| `GEMINI_API_KEY` | `.env`'de var, 18 Eylül'de kota sıfırlandı — çalışıyor | Hafta 3'ün agent kontrolleri bununla kapatıldı |
| `ANTHROPIC_API_KEY` | **yok** | `gate:w2` (14 kontrol) ve Hafta 2 dogfood'u bekliyor |

> **Güvenlik notu:** Gemini anahtarı bir kez sohbete düz metin yapıştırılmıştı.
> Hâlâ aynı anahtarsa **döndürülmeli**.

## Yarın ilk üç iş

1. **Hafta 4'e başla.** Sıra önemli: **redaction önce** — ikinci insanı odaya sokmadan
   önce. Kapı: *ikinci kişi linke tıklıyor, 3 saniyede senkron oluyor; bilerek `.env`
   okutuluyor, ekranda görünmüyor.*
2. **Dogfood'un üç bulgusunu Hafta 6-7 planına taşı** (README "Hafta 3 dogfood notları"):
   koşum ortamına özgü iç tool'ları katla, `replace` satırına diff, turn başlığına saat.
3. Anthropic anahtarı gelirse: `npm run gate:w2` ve Hafta 2 dogfood'u; ayrıca
   `E2E_AGENT` ile tarayıcı testlerini Claude odasına da koştur.

## Çalıştırma

```bash
npm run dev:all                                   # api 8787 + arayüz 5173
ROOM_CONFIG="config/room.gemini.yaml" npm run api # Gemini koşum ortamıyla
npm run gate:w3                                   # akış kapısı, anahtar gerekmez
npm run gate:w3:agent                             # 2 tarayıcı testi (api + web ayakta olmalı)
npm run verify                                    # Hafta 1 zinciri baştan sona
```

Playwright tarayıcısı kurulu (`npx playwright install chromium` bir kez koşuldu).

**Tuzak:** `packages/runner*` altında bir şey değiştirdiysen `npm run build` YETMEZ,
`npm run room:build` gerekir. İmajdaki runner eskiyse agent protokol sürümü uyuşmazlığı
verir (artık net mesajla, sessiz çökme döngüsüyle değil).

## Bilinen ve kabul edilmiş sınırlar

- **Gemini tool çıktısının metnini vermiyor**, sadece `status`. Terminal sekmesi komutu
  gösterir, çıktısını gösteremez. Dogfood'da en çok göze batan şey buydu.
- **Gemini'de tool kapısı ENGELLEMİYOR, SAPTIYOR.** `--allowed-tools` önden kısıtlıyor
  ama Claude'daki `PreToolUse` hook'unun karşılığını kurmadık.
- **Tek sunucu örneği varsayımı.** `AgentManager` bellekte; ikinci bir sunucu açılış
  mutabakatında birincinin runner'larını öldürür.
- **`npm audit`** 5 zafiyet bildiriyor, hepsi dev bağımlılığı.

## Okuma sırası (yeni bir oturum buradan başlarsa)

1. `README.md` — mimari, iki kural, karar notları, Hafta 3 dogfood notları
2. `docs/roadmap.md` — 12 haftalık plan
3. `docs/week-01.md`, `docs/week-02.md`, `docs/week-03.md` — ne yapıldı ve neden
4. `docs/runtime-gemini.md` — ikinci koşum ortamının ölçümleri ve eksikleri
5. Bu dosya
