# Hafta 4 — Redaction ve ikinci izleyici

**Biten iş (kapı):** İkinci kişi paylaşım linkine tıklıyor, saniyeler içinde odayı canlı
izliyor, hiçbir şey yazamıyor. Agent'a bilerek `.env` okutuluyor — secret ne ekranda ne
veritabanında görünüyor.

**Sıralama pazarlığa açık değildi:** redaction → snapshot → auth → presence → UI. Davet
linki üretebilen ilk satır, redaction bittikten sonra yazıldı.

## Görev listesi

| # | Adım | Durum |
| --- | --- | --- |
| 1 | gitleaks kural setini içeri al | ✅ 198 kural, 24 atlandı |
| 2 | Entropi taraması | ✅ 12 pozitif / 20 negatif, yanlış pozitif 0 |
| 3 | Redaction motoru | ✅ 16 KB'da ortalama 1,55 ms |
| 4 | Geçidi bağla (`appendEvent` + logger) | ✅ tek geçit |
| 5 | Migration 003 | ✅ |
| 6 | Auth (magic link) | ✅ |
| 7 | Davet ve paylaşım linki | ✅ |
| 8 | Projeksiyonu `packages/view`'a taşı | ✅ |
| 9 | Snapshot | ✅ 200 event / 60 sn tetiği |
| 10 | Presence | ✅ 250 ms debounce |
| 11 | UI (login, davet, presence, paylaşım, izleyici modu) | ✅ |
| 12 | Kapı script'i | ✅ `gate:w4` → 22/22 |
| 13 | Cuma dogfood (iki kişi) | ✅ iki makine, yerel ağ |
| 14 | README | ✅ |

## Redaction: ölçerek bulunan üç şey

Eşikleri tahminle seçseydik üçünü de kaçırırdık.

1. **Tokenizer'da ortadaki `=`.** `DB_PASSWORD=Tk9m...` tek token oluyordu; değer anahtar
   adına yapışınca hem bağlam kayboluyor hem `boundary=----WebKit...` yanlış pozitif
   veriyordu. `=` artık yalnızca sonda (base64 dolgusu).
2. **"`/` varsa yoldur" yanlış.** AWS gizli anahtarı da `/` içeriyor
   (`wJalrXUtnFEMI/K7MDENG/bPxRf...`) ve kaçırılıyordu. Ayırt edici işaret: yol parçaları
   küçük harflidir, base64 gövdesi karışık harf taşır.
3. **SRI `sha512-...` ve multipart `boundary=`** yanlış pozitif veriyordu; ikisi de beyaz
   listede.

Dördüncüsü motor testinde çıktı: gitleaks kuralları secret'ı tek yakalama grubuna alıyor
ama TOML'da `secretGroup` çoğunda yok. Kullanmayınca `generic-api-key` `DB_PASSWORD=...`
satırının **tamamını** maskeliyordu — okunması gereken bağlam kayboluyordu. Import script'i
artık tek grubu olan kurallara `secretGroup=1` türetiyor (198 kuralın 142'si).

## RE2 → JS: neyi atladık, neyi çevirdik

| Yapı | Karar | Gerekçe |
| --- | --- | --- |
| `\A` / `\z` | **çevrildi** (`^` / `$`) | `m` bayrağı olmadan JS'te bunlar tam olarak girdinin başı ve sonu. Atlasaydık 153 kural giderdi. |
| karakter sınıfı içinde `\A` / `\z` | atlandı | orada `^`/`$` düz karakter olur, anlam değişirdi |
| `(?i)` desenin başında | `i` bayrağına yükseltildi | birebir karşılık |
| `(?i)` ortada | **atlandı** (22 kural) | JS satır içi bayrak desteklemiyor; uydurmak kuralın ne aradığını sessizce değiştirirdi |
| `(?P<...>)`, `(?>...)` | atlandı | JS'te yok |

Sessiz anlam kaymasına ayrıca dikkat edildi: `\z` JS'te hata vermez, sadece "z" harfi olur —
kural derlenir ama yanlış şeyi arar.

## Yetki: sunucuda, UI'da değil

- Tüm `/rooms/*` uçları (SSE ve geliştirme event ucu dahil) `requireUser` / `requireRoom`
  üzerinden geçiyor.
- `GET /rooms` yalnızca üye olunan odaları döndürüyor — gizleme UI'da değil **sorguda**.
- Var olmayan oda `404` değil `403`: `404` hangi oda kimliklerinin var olduğunu sızdırır.
- Actor artık oturumdan geliyor, `x-user-id` başlığından değil. İstemcinin söylediği kimliğe
  güvenmek Hafta 5'teki `[Ali]:` etiketini anlamsız kılardı.
- Kapı script'leri auth'u **atlatmıyor, kullanıyor** (`scripts/dev-session.mjs`). Bypass
  eklemek, kapının "oturumsuz istek 401 alır" kontrolünü anlamsız kılardı.

## Snapshot doğruluğu

`project(hepsi)` ile `project(sonrası, snapshot)` **her kesme noktasında** derin eşit —
turn ortasında kesilen, yarım turn'ün snapshot'a girdiği durumlar dahil. Eşit olmasaydı hata
snapshot'ta değil projeksiyonda olurdu (saf değildir); o durumda snapshot düzeltilmez,
projeksiyon düzeltilir.

Projeksiyon `packages/view`'a taşındı: sunucu snapshot üretirken, istemci ekranı çizerken
**aynı** fonksiyonu çağırıyor. İki ayrı kod olsaydı zamanla birbirinden ayrılır ve kimse
fark etmezdi.

## Presence

Bellekte, event log'a yazılmıyor. **Bağlantı = varlık.** Aynı kullanıcının üç sekmesi tek
satır; `viewing` en son dokunulan sekmeden gelir. Yayın 250 ms debounce'lu.

Presence frame'i `id:` **taşımıyor**: `id` yalnızca event sırasını ilerletir; presence'a id
verseydik yeniden bağlanan istemcinin `Last-Event-ID` imleci bozulur ve gerçek event'ler
atlanırdı.

## Koşarken çıkan hatalar

| Nerede | Ne oldu |
| --- | --- |
| Kapı e-postası | Sabit e-postayla kapıyı 5 dakikada iki kez koşturmak magic link hız sınırını tetikliyor ve kapının kendisini düşürüyordu. Sınır gevşetilmedi; kapılar her koşumda benzersiz e-posta üretiyor. |
| Hafta 3 kapısı, 5. kontrol | `data:` satırını körlemesine alıyor ve presence frame'ini event sanıyordu. Artık `event: events` satırından sonraki data okunuyor. |
| `scripts/smoke-api.mjs` | Hafta 3'ten beri bozukmuş: `nextSince` alanı o hafta `lastSeq` olmuş, script güncellenmemiş. Kimse koşmadığı için fark edilmemiş. |
| Arayüz, giriş | StrictMode effect'i iki kez koşturuyor, magic link tek kullanımlık olduğu için ikinci çağrı 400 dönüyordu: giriş başarılıyken ekranda hata kalıyordu. **Elle denerken bulundu**, 194 test bulmamıştı — hiçbiri ekranda ne yazdığına bakmıyordu. |
| Hafta 4 kapısı | Çıplak `wait` arka plandaki sunucuyu da bekliyordu ve kapı asılı kalıyordu. Hafta 3 kapısındaki yorum tam bunu uyarıyor; yine de yapıldı. |
| Sunucu süreci | Kapı/testler iki kez **eski derlemeye** karşı koştu, çünkü portta kalmış eski bir süreç vardı. Kapı artık portu dolu bulursa baştan reddediyor. |

## Kapı çıktısı (18 Eylül 2026)

| Kontrol | Sonuç |
| --- | --- |
| Dört sahte secret DB'de | yok |
| SSE çıktısında | yok |
| `[redacted:` işareti + anahtar adı | ikisi de var |
| Bulgu kaydı | 4 satır, hiçbirinde ham değer yok |
| Yanlış pozitif (normal kaynak dosya) | 0 |
| Sunucu logu | temiz |
| Tek geçit | yalnızca `appendEvent` |
| `project(hepsi)` == snapshot + sonrası | derin eşit |
| Yetki | oturumsuz 401 · üye değil 403 · olmayan oda 403 |
| Davet / izleyici | kabul `viewer`, mesaj-başlat-davet üçü de 403 |
| Tek kullanımlık / süresi dolmuş / iptal | üçü de 400 |
| DB'de ham token | yok |
| Davetlinin ilk frame'i | **81 ms** (hedef < 3000) |
| Presence | bakış değişimi 1,96 sn · kopma 7,9 sn içinde düştü |
| Presence event log'da | 0 |
| Regresyon | Hafta 1 10/10 · Hafta 3 11/11 |

**Geçen: 22 · Kalan: 0.**

Kapının kendisi üç koşumda oturdu ve ikisi ürün hatası değildi:
1. Çıplak `wait` arka plandaki sunucuyu da bekliyordu → kapı asılı kaldı. Asılı kapıyı
   öldürünce temizlik kancası **aynı isimli** geçici klasörü sildi ve sonraki koşumun beş
   kontrolü sahtelikten düştü. Klasör adı artık koşuma özel; dosyası olmayan kontrol de
   sessizce geçmek yerine düşüyor ("bulamadım" ile "bakamadım" aynı şey değil).
2. Script koşarken düzenlendi; bash dosyayı satır satır okuduğu için ortasından sözdizimi
   hatası verdi.
3. **Gerçek bulgu:** snapshot eşdeğerliği `JSON.stringify` ile karşılaştırılıyordu. Postgres
   JSONB anahtarları yeniden sıralıyor, yani veri birebir aynıyken metin farklı çıkıyordu.
   Kontrol artık `isDeepStrictEqual` kullanıyor — istenen şey derin eşitlik, metin eşitliği
   değil.

## Dogfood (Adım 13) — yapıldı

İki kişi, iki ayrı makine, aynı yerel ağ. İkinci kişi kurulum yapmadan davet linkinden
girdi, izleyici olarak canlı izledi; agent gerçek bir dosya yazdı. Üç sorunun cevabı
README "Hafta 4 dogfood notları" başlığında.

**Dogfood'un asıl bulduğu şey kodda değil, dağıtımdaydı:** Cloudflare hızlı tüneli SSE'yi
tamamen tamponluyor (25 sn'de tek byte yok), yani izleyici odayı görüyor ama hiçbir canlı
güncelleme almıyor. Doğrudan bağlantı, vite vekili ve yerel ağ akışı geçiriyor. Olay akışı
tabanlı bir arayüz, yanıtı tamponlayan bir vekilin arkasında çalışmaz — ve bunu hiçbir kapı
testi göremezdi, çünkü kapılar aynı makinede koşuyor.

Dogfood sırasında çıkan iki ürün hatası (ikisi de düzeltildi):
- Odanın container'ı dışarıdan silinince agent sonsuza kadar `starting`de kalıyordu; artık
  `failed` + net mesaj + ekranda görünen hata.
- `AGENT_MODEL` Gemini runner'ında sessizce yok sayılıyordu (Claude'da geçerliydi). Kota
  dolunca başka modele geçilemiyordu; düzeltmeden sonra `gemini-3.1-flash-lite` ile turn
  uçtan uca geçti.

## Kalan iş

- `gate:w2` hâlâ koşulmadı (`ANTHROPIC_API_KEY` yok) — Hafta 2'den kalan boşluk. Anahtar
  gelene kadar Claude yolunun kapısı açılamaz; Gemini yolunun çalışması onu kanıtlamaz
  (SDK event şekilleri farklı).

## Kapanan işler (19 Eylül 2026, Hafta 5'in ilk günü)

- `npm run gate:w4:agent` **5/5 geçti** (Gemini): gerçek agent gerçek bir `.env` okudu, üç
  sahte secret'ın hiçbiri `session_events`'e girmedi, üç bulgu kaydı yazıldı.
- **Turn sonucunda sebep alanı** geldi: Gemini yolunda başarısız turn artık
  `turn.completed subtype:"error"` değil `turn.failed` yazıyor ve son stderr satırlarını
  (`429 RESOURCE_EXHAUSTED` gibi) `error` alanında taşıyor. Ekranda da yazıyor —
  sebep event log'a girmezse UI'da olamaz.
- **Presence bakışı sekme bazlı**: `hello` frame'i bağlantı kimliğini istemciye veriyor,
  istemci `POST /presence` gövdesinde geri yolluyor. Üç sekme açan kişi artık hepsinde aynı
  agent'a bakıyor görünmüyor. Bu yolda `touched` alanının `Date.now()` olması yüzünden aynı
  milisaniyedeki iki değişiklikte eski sekmenin kazandığı da düzeldi (monoton sayaç).
