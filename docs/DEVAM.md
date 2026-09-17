# Kaldığımız yer — 17 Eylül 2026

Bu dosya oturum sonu devir notudur. Yarın buradan devam edilir.

## Tek cümleyle

Hafta 1 ve 2 bitti, Hafta 3'ün **akış tarafı** bitti (kapı 11/11). Kalan her şey
tek bir şeye bağlı: **çalışan bir model anahtarı.**

## Durum tablosu

| Hafta | Konu | Durum |
| --- | --- | --- |
| 1 | İskelet ve event log | ✅ `npm run gate` → 10/10 |
| 2 | Tek agent, headless koşum | ⏳ kod tamam, `gate:w2` **koşulmadı** (anahtar yok) |
| 3 | Stream ve terminal görünümü | ✅ `npm run gate:w3` → 11/11 · ⏳ 2 kontrol agent bekliyor |

Ek olarak plan dışı ama bilerek yapılan: **ikinci koşum ortamı (Gemini CLI)**
ve sağlayıcı dikişi. Gerekçesi README "Karar notları"nda.

## Neyi engelleyen ne

**Tek engel anahtar.** Makinede her şey kurulu ve ayakta:

```
node v24  ·  docker 29  ·  postgres + redis healthy  ·  oda imajı kurulu
/opt/runner/claude  → Claude Agent SDK 0.3.274
/opt/runner/gemini  → Gemini CLI 0.60.0
```

| Anahtar | Durum | Etkisi |
| --- | --- | --- |
| `GEMINI_API_KEY` | `.env`'de var, **günlük kota doldu** (ücretsiz katman 20 istek/gün) | Kota **18 Eylül'de sıfırlanır**, sonra Gemini agent'ı yine çalışır |
| `ANTHROPIC_API_KEY` | yok | `gate:w2` ve Claude koşum ortamı bekliyor |

> **Güvenlik notu:** Gemini anahtarı bir kez sohbete düz metin yapıştırıldı.
> Hâlâ aynı anahtarsa **döndürülmeli**.

## Yarın ilk üç iş

1. **Push.** 2 commit bekliyor:
   ```bash
   git push
   ```
2. **Kota döndüyse Gemini ile Hafta 3'ü kapat:**
   ```bash
   npm run dev:all                      # api + arayüz
   npx playwright install chromium      # ilk seferde
   npm run gate:w3:agent                # 2 tarayıcı testi
   ```
3. **Cuma dogfood (Adım 13).** Gerçek bir klasörü worktree'ye kopyala, gerçek
   bir görev ver, **ekrandan** izle (psql'den değil) ve üç soruyu cevapla:
   - Neyi görmek için Terminal sekmesine geçmek zorunda kaldın?
   - Hangi bilgiyi ekranda bulamayıp DB'ye baktın?
   - 5 dakika sonra ekranda gürültü olmaya başlayan ne vardı?

   Cevaplar README'ye "Hafta 3 dogfood notları" başlığıyla yazılır ve
   **Hafta 6-7'nin UI kararlarını belirler.**

Anthropic anahtarı gelirse ayrıca: `npm run gate:w2` (14 kontrol) ve Hafta 2'nin
dogfood'u.

## Çalıştırma

```bash
npm run dev:all                                   # api 8787 + arayüz 5173
ROOM_CONFIG="config/room.gemini.yaml" npm run api # Gemini koşum ortamıyla
npm run verify                                    # Hafta 1 zinciri baştan sona
npm run gate:w3                                   # akış kapısı, anahtar gerekmez
```

**Tuzak:** `packages/runner*` altında bir şey değiştirdiysen `npm run build`
YETMEZ, `npm run room:build` gerekir. İmajdaki runner eskiyse agent protokol
sürümü uyuşmazlığı verir (artık net mesajla, sessiz çökme döngüsüyle değil).

## Bilinen ve kabul edilmiş sınırlar

- **Gemini tool çıktısının metnini vermiyor**, sadece `status`. Terminal sekmesi
  komutu gösterir, çıktısını gösteremez — "(bu koşum ortamı komut çıktısını
  vermiyor)" yazar. Claude'da bu sekme dolu görünecek.
- **Gemini'de tool kapısı ENGELLEMİYOR, SAPTIYOR.** `--allowed-tools` önden
  kısıtlıyor ama Claude'daki `PreToolUse` hook'unun karşılığını kurmadık.
  Gemini'nin `BeforeTool` hook'u ve Policy Engine'i var; şemaları ölçülmedi.
- **Tek sunucu örneği varsayımı.** `AgentManager` bellekte; ikinci bir sunucu
  açılış mutabakatında birincinin runner'larını öldürür.
- **`npm audit`** 5 zafiyet bildiriyor, hepsi dev bağımlılığı.

## Sonraki hafta (4) ne istiyor

Yol haritasına göre: redaction (gitleaks + entropy), snapshot üretimi, presence,
oda paylaşım linki, basit auth. Kapı: *ikinci kişi linke tıklıyor, 3 saniyede
senkron oluyor; bilerek `.env` okutuluyor, ekranda görünmüyor.*

Sıra önemli: **redaction Hafta 4'te, sonraya bırakılmaz** — ikinci insanı odaya
sokmadan önce.

## Okuma sırası (yeni bir oturum buradan başlarsa)

1. `README.md` — mimari, iki kural, karar notları
2. `docs/roadmap.md` — 12 haftalık plan
3. `docs/week-01.md`, `docs/week-02.md` — ne yapıldı ve neden
4. `docs/runtime-gemini.md` — ikinci koşum ortamının ölçümleri ve eksikleri
5. Bu dosya
