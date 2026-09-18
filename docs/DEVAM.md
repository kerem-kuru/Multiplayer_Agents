# Kaldığımız yer — 18 Eylül 2026 akşamı

Bu dosya oturum devir notudur. Yeni bir oturum **buradan** başlar.

## Proje ne, neden

Bir **oda**, içinde birden çok agent barındıran izole bir container'dır. Odaya giren birden
çok geliştirici aynı anda bu agent'lara görev verir, işlerini canlı izler, yönlerini
değiştirir.

> **Tez:** Gerçek birim agent değil, her agent'ın okuyup yazdığı **tek paylaşılan bağlam
> deposudur.** Agent'lar birbirine mesaj atmaz; ortak oda defterine yazar ve oradan okur.

**Ölçülecek tek metrik:** aynı oturuma iki farklı insanın yazdığı oturum sayısı, haftalık.
Kurulum sayısı değil, star sayısı değil.

12 haftalık plan `docs/roadmap.md` içinde. Haftalık görev tanımları
`C:\Users\KEREM\Downloads\HAFTA-<N>-GOREV.md` dosyalarından geliyor; her hafta o dosyadaki
adımlar sırayla uygulanıyor, hafta sonunda kendi kapı script'i + dogfood + README yazılıyor.

## Durum

| Hafta | Konu | Durum |
| --- | --- | --- |
| 1 | İskelet ve event log | ✅ `npm run gate` → 10/10 |
| 2 | Tek agent, headless koşum | ⏳ kod tamam, `gate:w2` **koşulmadı** (Claude anahtarı yok) |
| 3 | Stream ve terminal görünümü | ✅ `gate:w3` 11/11 · `gate:w3:agent` 2/2 |
| 4 | Redaction ve ikinci izleyici | ✅ `gate:w4` 22/22 · dogfood ✅ · ⏳ `gate:w4:agent` (kota) |
| 5 | **Yazma yetkisi, kuyruk, kesme** | ⬜ sırada |

**195 test.** Paketler: `protocol`, `redact`, `view`, `core`, `runner`, `runner-gemini`.
Son commit `3398034`, push edilmiş, çalışma ağacı temiz.

## Yarın ilk üç iş

### 1. `npm run gate:w4:agent` — kota sıfırlandıktan sonra (TSİ ~10:00)

Hafta 4'ün tek eksik kontrolü: gerçek agent gerçek bir `.env` okuyor, secret log'a
girmemeli. Anahtar/kota yoksa kendi kendine atlar, başarısız saymaz.

```bash
npm run db:up
npm run gate:w4:agent
```

Geçerse Hafta 4 tamamen kapanır; `docs/week-04.md` "Kalan iş" maddesi güncellenir.

### 2. Hafta 5'e başla

Görev tanımı: `C:\Users\KEREM\Downloads\HAFTA-5-GOREV.md` (Kerem verecek).
Yol haritasındaki hedef: *iki kişi aynı agent'a yazıyor, çakışma yok; sürücülük 2 tıkta
devrediliyor.*

Beklenen parçalar: yazma rolü (`room_members.role` metin + CHECK olduğu için genişletmesi
tek satır), **kuyruk**, **kesme**, **sürücü devri**, akışta `[Ali]: ...` aktör etiketi.

**Gerekçesi dogfood'dan geldi:** izleyici ekranını gören ilk tepki *"şu an izleyiciye
müdahale etme yetkisini vermiyoruz"* oldu — soru, izleyici bir şey denemeden, ekrana bakar
bakmaz geldi. Kuyruk olmadan yazma yetkisi vermek iki mesajı paralel inference'a sokar;
sıra bu yüzden böyle.

### 3. Hafta 5/6'ya taşınan iki UI borcu

- **Turn sonucunda sebep alanı yok.** Ekranda `● bitti · error · 0 ms` yazıyor, nedeni
  (ör. Gemini kotası `429`) yalnızca sunucu logunda kalıyor — çünkü **event log'da da yok**.
  Gemini runner'ı `result` satırındaki `status`'u yazıyor ama hata metnini taşımıyor.
  Kerem bunu iki kez gördü; dogfood'un "ilk 10 saniyede neyi anlamadın" cevabı bu.
- **İzleyiciye "yetki iste" eylemi.** "Bu odayı izliyorsun" satırı ne olduğunu söylüyor ama
  ne zaman değişeceğini söylemiyor.

Anthropic anahtarı gelirse ayrıca: `npm run gate:w2` (14 kontrol) ve Hafta 2 dogfood'u;
tarayıcı testleri `E2E_AGENT` ile Claude odasına da koşulabilir.

## Bugün ne yapıldı (Hafta 4 — on dört adım)

- **`packages/redact`** — gitleaks'ten üretilmiş **198 kural** (`scripts/import-gitleaks.mjs`,
  çıktı repoda: build ağ istemesin) + Shannon entropi taraması. Eşikler ölçümle seçildi:
  12 pozitif, 20 negatif, yanlış pozitif 0. 16 KB metin ~1,5 ms (anahtar kelime ön filtresi).
- **Tek geçit** — `appendEvent`: parse → redact → INSERT → bulgu → commit → publish.
  `INSERT INTO session_events` repoda başka hiçbir yerde yok. Sunucu logger'ı da
  redaction'dan geçiyor (runner stderr'i oradan akıyor).
- **`packages/view`** — projeksiyon ortak pakete taşındı; sunucu snapshot üretirken, istemci
  ekranı çizerken **aynı** fonksiyonu çağırıyor.
- **Snapshot** — 200 event / 60 sn tetiği, son 3 saklanıyor, sürümü eskiyse tam replay.
  `project(hepsi) == snapshot + sonrası` her kesme noktasında derin eşit.
- **Auth** — magic link (15 dk, tek kullanımlık, 5 dk'da 3 istek), oturum çerezi, oda
  üyeliği (`owner` / `viewer`). Ham token hiçbir tabloda yok, yalnızca sha256.
- **Davet linki** — çok kullanımlık, süreli, iptal edilebilir; yalnızca `viewer` üretir.
- **Presence** — bellekte, event log'a yazılmıyor; bağlantı = varlık, 250 ms debounce.
  Presence frame'i `id:` taşımaz (yoksa `Last-Event-ID` imleci bozulur).
- **Arayüz** — login, davet kabul, presence çubuğu, paylaşım kutusu, izleyici modu.
- **Kapılar** — `scripts/week4-gate.sh` (20 kontrol + iki regresyon kapısı) ve
  `scripts/week4-agent-gate.sh` (agent gerektiren kısım, ayrı tutuldu).

**Dogfood:** iki kişi, iki ayrı makine, aynı yerel ağ. İkinci kişi kurulum yapmadan davet
linkinden girdi, canlı izledi, hiçbir şey yazamadı; agent gerçek bir dosya yazdı ve ikisi de
aynı anda gördü. Üç sorunun cevabı README "Hafta 4 dogfood notları" başlığında.

**Gün içinde bulunan ve düzeltilen gerçek hatalar:** giriş sonrası ekranda kalan sahte hata
(StrictMode + tek kullanımlık link), container silinince agent'ın sonsuza kadar `starting`de
kalması, `AGENT_MODEL`'in Gemini runner'ında sessizce yok sayılması, AWS anahtarının bulgu
kaydında `env-assignment` diye isimlendirilmesi, Hafta 3 kapısının presence frame'ini event
sanması, `smoke-api.mjs`'in Hafta 3'ten beri bozuk olması.

## Çalıştırma

```bash
npm run db:up                                     # postgres + redis
npm run dev:all                                   # api 8787 + arayüz 5173
AUTH_DEV_MODE=true npm run api                    # giriş bağlantısı ekranda görünsün
npm run gate / gate:w3 / gate:w4                  # kapılar, anahtar gerektirmez
npm run gate:w3:agent / gate:w4:agent             # agent gerektirenler
node scripts/demo-redaction.mjs <oda-id>          # maskelemeyi EKRANDA göster
```

**İkinci kişiyi odaya sokarken** (aynı ağdaysanız — bugün böyle yapıldı):

```bash
AUTH_DEV_MODE=true APP_BASE_URL="http://<lan-ip>:5173" \
  ROOM_CONFIG=config/room.gemini.yaml npm run api
WEB_HOST=1 WEB_ALLOWED_HOSTS="<lan-ip>,localhost" npm run dev:web
```

`APP_BASE_URL` o adres olmalı; yoksa giriş ve davet linkleri localhost'a çıkar ve karşı
taraf tıkladığında hiçbir yere ulaşamaz.

**Gemini kotası** ücretsiz katmanda model başına günde 20 istek; Pasifik gece yarısı
(≈ TSİ 10:00) sıfırlanıyor. Bir model dolarsa `AGENT_MODEL=gemini-3.1-flash-lite` — kotası
ayrı ve uçtan uca çalıştığı doğrulandı.

## Tuzaklar — bugün dördüne de düşüldü

1. **Portta kalmış eski sunucu.** Kapı/test eski derlemeyi ölçer ve saatlerce yanlış yere
   bakarsın. `gate:w4` artık portu dolu bulursa baştan reddediyor; diğerlerinde elle bak.
2. **Kabuk script'ini koşarken düzenleme.** Bash dosyayı satır satır okur, ortasından
   sözdizimi hatası verir.
3. **Çıplak `wait`.** Arka planda sunucu da varsa onu bekler, kapı asılı kalır. Kapıların
   geçici klasörleri artık koşuma özel (`$$`); yoksa asılı bir kapının temizlik kancası
   sonraki koşumun dosyalarını siliyor ve kontroller sahtelikten düşüyor.
4. **`packages/runner*` değiştiyse `npm run build` YETMEZ**, `npm run room:build` gerekir.
5. **Toplu `docker rm -f` ile oda container'larını silme** — canlı odaları öldürür, o odalar
   kurtarılamaz (artık en azından net hata veriyor).

## Bilinen ve kabul edilmiş sınırlar

- **Cloudflare hızlı tüneli SSE'yi TAMPONLUYOR** (ölçüldü: 25 sn'de tek byte yok, protokol
  bayrakları da çözmüyor). İzleyici odayı görür ama canlı akış gelmez. Yerel ağ ve vite
  vekili sorunsuz; uzaktan erişim gerekirse akışı geçiren bir tünel (ngrok) lazım.
- **Redaction agent'ın context'ini korumaz.** Agent `.env` okursa içerik modele gider;
  engellemek onay kuyruğunun işi (Hafta 10). Korunan şey log, UI, snapshot, SSE, sunucu logu.
- **Gemini tool çıktısının metnini vermiyor**, sadece `status`. Terminal sekmesi komutu
  gösterir, çıktısını gösteremez.
- **Gemini'de tool kapısı engellemiyor, saptıyor.** Claude'daki `PreToolUse` karşılığı yok.
- **Tek sunucu örneği varsayımı** — `AgentManager` ve presence bellekte.
- **`npm audit`** 5 zafiyet bildiriyor, hepsi dev bağımlılığı.

## Okuma sırası (yeni bir oturum buradan başlarsa)

1. Bu dosya
2. `README.md` — mimari, iki kural, redaction'ın koruduğu/korumadığı, karar notları, dogfood
3. `docs/roadmap.md` — 12 haftalık plan
4. `docs/week-01.md` … `docs/week-04.md` — hafta hafta ne yapıldı ve **neden**
5. `docs/runtime-gemini.md` — ikinci koşum ortamının ölçümleri ve eksikleri

## Çalışma tarzı (yeni oturum bunu bilmeli)

- Her adımın **kabul kriteri doğrulanmadan** sonrakine geçilmez; "çalışıyor gibi duruyor"
  yeterli değil, ölçüm gerekir.
- Değişmez kurallarla çelişen bir kısayol gerekirse durup README "Karar notları"na yazılır.
- Kapsam dışı listesindeki hiçbir şeye "hazırlık" amacıyla bile başlanmaz.
- Her adım sonunda anlamlı bir commit; hafta sonunda kapı script'i + dogfood + README.
