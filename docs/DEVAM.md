# Kaldığımız yer — 18 Eylül 2026 (akşam)

Bu dosya oturum sonu devir notudur. Yarın buradan devam edilir.

## Tek cümleyle

**Hafta 4 bitti — on dört adımın hepsi.** İki kişi iki ayrı makineden aynı odayı canlı
izledi, ikinci kişi hiçbir şey yazamadı, agent gerçek bir dosya yazdı; secret ne ekrana ne
veritabanına düştü. Sırada **Hafta 5**: yazma yetkisi, kuyruk, kesme, sürücü devri.

## Durum tablosu

| Hafta | Konu | Durum |
| --- | --- | --- |
| 1 | İskelet ve event log | ✅ `npm run gate` → 10/10 |
| 2 | Tek agent, headless koşum | ⏳ kod tamam, `gate:w2` **koşulmadı** (Claude anahtarı yok) |
| 3 | Stream ve terminal görünümü | ✅ `gate:w3` 11/11 · `gate:w3:agent` 2/2 (Gemini) |
| 4 | Redaction ve ikinci izleyici | ✅ `gate:w4` 22/22 · dogfood ✅ (iki makine) |

Testler: **195**. Paketler: `protocol`, `redact` (YENİ), `view` (YENİ), `core`, `runner`,
`runner-gemini`.

## Hafta 4'te ne yapıldı

- **`packages/redact`** — gitleaks'ten üretilmiş 198 kural + entropi taraması. Eşikler
  ölçümle seçildi (12 pozitif / 20 negatif, yanlış pozitif 0). 16 KB metin ~1,5 ms.
- **Tek geçit** — `appendEvent`: parse → redact → INSERT → bulgu → commit → publish.
  `INSERT INTO session_events` repoda başka hiçbir yerde yok. Sunucu logger'ı da redaction'dan
  geçiyor (runner stderr'i oradan akıyor).
- **`packages/view`** — projeksiyon ortak pakete taşındı; sunucu snapshot üretirken, istemci
  ekranı çizerken aynı fonksiyonu çağırıyor.
- **Snapshot** — 200 event / 60 sn tetiği, son 3 snapshot saklanıyor, sürüm eskiyse tam
  replay'e düşülüyor.
- **Auth** — magic link (15 dk, tek kullanımlık, 5 dk'da 3 istek), oturum çerezi, oda üyeliği
  (`owner` / `viewer`). Ham token hiçbir tabloda yok.
- **Davet linki** — çok kullanımlık, süreli, iptal edilebilir; yalnızca `viewer` üretir.
- **Presence** — bellekte, event log'a yazılmıyor; bağlantı = varlık, 250 ms debounce.
- **Arayüz** — login, davet kabul, presence çubuğu, paylaşım kutusu, izleyici modu.

## Yarın ilk üç iş

1. **Hafta 5'e başla:** yazma yetkisi, kuyruk, kesme, sürücü devri. Gerekçesi dogfood'dan
   geldi: izleyici ekranını gören ilk tepki *"şu an izleyiciye müdahale yetkisi vermiyoruz"*
   oldu.
2. **`npm run gate:w4:agent`** — kota sıfırlanınca (Pasifik gece yarısı ≈ TSİ 10:00) koş:
   gerçek agent gerçek bir `.env` okuyor, secret log'a girmiyor mu?
3. **Turn sonucuna sebep alanı** (Hafta 5/6 UI işi): ekranda `bitti · error` yazıyor ama
   nedeni yalnızca sunucu logunda. Gemini runner'ı `result` satırındaki hata metnini
   taşımıyor.

Anthropic anahtarı gelirse ayrıca: `npm run gate:w2` (14 kontrol) ve Hafta 2 dogfood'u.

## Çalıştırma

```bash
npm run dev:all                                   # api 8787 + arayüz 5173
AUTH_DEV_MODE=true npm run api                    # giriş bağlantısı ekranda görünsün
npm run gate     / gate:w3 / gate:w4              # kapılar (anahtar gerekmez)
npm run gate:w3:agent / gate:w4:agent             # agent gerektirenler
```

**Uzaktan erişim:** Cloudflare hızlı tüneli SSE'yi TAMPONLUYOR — izleyici odayı görür ama
canlı akış hiç gelmez (ölçüldü). Aynı ağdaysanız `WEB_HOST=1 WEB_ALLOWED_HOSTS=<lan-ip>` ile
`http://<lan-ip>:5173` çalışıyor; uzaktaysa akışı geçiren bir tünel (ngrok) gerekir.
Her iki durumda da `APP_BASE_URL` o adres olmalı, yoksa giriş ve davet linkleri localhost'a
çıkar.

**Tuzaklar (bu oturumda üçüne de düşüldü):**
- Kapı/test koşarken **portta eski bir sunucu** varsa eski derleme ölçülür. `gate:w4` artık
  portu dolu bulursa baştan reddediyor; diğerlerinde elle bak.
- Bir kabuk script'ini **koşarken düzenleme**; bash dosyayı satır satır okur, ortasından
  sözdizimi hatası verir.
- `packages/runner*` altında bir şey değiştiysen `npm run build` YETMEZ, `npm run room:build`
  gerekir.

## Bilinen ve kabul edilmiş sınırlar

- **Gemini tool çıktısının metnini vermiyor**, sadece `status`. Terminal sekmesi komutu
  gösterir, çıktısını gösteremez.
- **Gemini'de tool kapısı engellemiyor, saptıyor.** Claude'daki `PreToolUse` karşılığı yok.
- **Redaction agent'ın context'ini korumaz.** Agent `.env` okursa içerik modele gider; bu
  tasarım gereği, engellemek onay kuyruğunun işi (Hafta 10).
- **Tek sunucu örneği varsayımı** (`AgentManager` ve presence bellekte).
- **`npm audit`** 5 zafiyet bildiriyor, hepsi dev bağımlılığı.

## Okuma sırası (yeni bir oturum buradan başlarsa)

1. `README.md` — mimari, iki kural, redaction'ın koruduğu/korumadığı, karar notları, dogfood
2. `docs/roadmap.md` — 12 haftalık plan
3. `docs/week-01.md` … `docs/week-04.md` — ne yapıldı ve neden
4. `docs/runtime-gemini.md` — ikinci koşum ortamının ölçümleri
5. Bu dosya
