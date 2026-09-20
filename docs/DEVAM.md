# Kaldığımız yer — 20 Eylül 2026, akşam

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
`C:\Users\KEREM\Downloads\HAFTA-<N>-GOREV.md` dosyalarından geliyor.

## Durum

| Hafta | Konu | Durum |
| --- | --- | --- |
| 1 | İskelet ve event log | ✅ `npm run gate` → 10/10 |
| 2 | Tek agent, headless koşum | ⏳ kod tamam, `gate:w2` **koşulmadı** (Claude anahtarı yok) |
| 3 | Stream ve terminal görünümü | ✅ `gate:w3` 11/11 · `gate:w3:agent` 2/2 |
| 4 | Redaction ve ikinci izleyici | ✅ `gate:w4` 22/22 · `gate:w4:agent` 5/5 · dogfood ✅ |
| 5 | **Yazma yetkisi, kuyruk, kesme** | ✅ `gate:w5` 25/25 · `gate:w5:agent` 7/7 · dogfood ✅ **HAFTA KAPANDI** |
| 6 | Diff görünümü ve satır yorumu | ⬜ **sırada** — görev tanımı Kerem'den bekleniyor |

**233 test.** Paketler: `protocol`, `redact`, `view`, `core`, `runner`, `runner-gemini`.
Hafta 5'te 31 test eklendi: 12 kuyruk + 8 sürücü (gerçek DB + sahte runner) + 6 projeksiyon
+ 5 rol bağlamı / hata özeti.

**Kod durumu:** her şey commit'li ve push'lu, çalışma ağacı temiz. Oda imajı Python'lu
hâliyle yeniden derlendi.

**Makinede ne açık kaldı:** `postgres` (5433) + `redis` (6380) ayakta. API (8787) ve arayüz
(5173) dogfood için açılmıştı; oturum sonunda kapatılabilir. Oda container'larından biri
canlı (bugünkü dogfood odası `255d346b`), onbir tanesi `Exited` — eski imajlardan kalma,
kurtarılamaz. Tek tek silinebilir (`docker rm -f agent-rooms-room-<kısa-id>`) ama **toplu
silme yapma** (5. tuzak). Compose'un `build-only` profilinden kalan isimsiz bir
`sleep infinity` container'ı da dönüyor; hiçbir odaya bağlı değil.

## Hafta 5 KAPANDI — hafta sonu tanımının 10 maddesi de doğrulandı

Son iki madde bugün kapandı:

1. **Elle test** (dün yarım kalmıştı): yeni oda Python'lu imajdan açıldı, rol bağlamı ulaştı,
   agent gerçek dosya işleri yaptı.
2. **İki kişilik dogfood** (Adım 12): iki cihaz, aynı yerel ağ, 20:04–20:09, 7 mesaj.
   Notlar README "Hafta 5 dogfood notları" başlığında, ölçümler `docs/week-05.md` içinde.

Dogfood'un event log'dan çıkan sayıları: kesme **109 ms** (`mode: abort`), kesilen turn
`reason: "interrupted"` ve yeniden koşmadı, kesmeyi **devirden sonraki sürücü** yaptı,
koşan turn sırasında gelen mesaj önceki turn'ün bitişinden **59 ms sonra** alındı (10,8 sn
kuyrukta bekledi), hiçbir anda iki `running` satır yok. Dört sorunun hiçbirinde sorun
çıkmadı — yani kapının ölçtüğü ile gerçek kullanım aynı çıktı.

## Yarın ilk iş: Hafta 6

Görev tanımı: `C:\Users\KEREM\Downloads\HAFTA-6-GOREV.md` (Kerem verecek, henüz yok).
Yol haritasındaki hedef: *satıra "bunu böl" yazılıyor, agent 30 sn'de düzeltiyor, ikinci
kullanıcı canlı görüyor.*

**Hafta 6'ya taşınan üç borç:**

1. **İzleyiciye "yetki iste" eylemi yok.** İzleyici satırı ne olduğunu VE nasıl değişeceğini
   söylüyor ama tek tıkla yetki isteme yolu yok. Hafta 5 kapsamında talep akışı YOKTU (görev
   tanımı açıkça kapsam dışı bıraktı).
2. **Durmuş oda container'ı ham Docker hatası gösteriyor.** Docker yeniden başlayınca oda
   container'ları `Exited` kalıyor ve arayüze
   `container'a bağlanılamadı: Error: (HTTP code 409) … is not running` düşüyor. Sunucu
   container'ın var-ama-durmuş olduğunu biliyor; ya kendiliğinden `docker start` etmeli ya da
   insan diliyle "oda kapandı, yeni oda aç" demeli. Tek nokta: `AgentStartError`'ın üretildiği
   yer. **Dikkat:** eski container eski imajdan; otomatik başlatma yapılacaksa imaj/protokol
   sürümü kontrolü de gerekir.
3. **`gate:w2` hâlâ koşulmadı** (Claude anahtarı yok) — Hafta 2'den kalan boşluk.

## Dogfood ortamını yeniden kurmak (iki cihaz, yerel ağ)

```bash
npm run db:up && npm run build
# LAN IP'yi doğrula (20 Eylül'de 192.168.1.114 idi):
#   PowerShell: Get-NetIPAddress -AddressFamily IPv4 | ? { $_.InterfaceAlias -like "Wi-Fi*" }
IP=192.168.1.114

AUTH_DEV_MODE=true APP_BASE_URL="http://$IP:5173" \
  ROOM_CONFIG=config/room.gemini.yaml AGENT_MODEL=gemini-3.1-flash-lite \
  node apps/api/dist/index.js

WEB_HOST=1 WEB_ALLOWED_HOSTS="$IP,localhost" npm run dev:web
```

`APP_BASE_URL` LAN IP'si olmalı, yoksa giriş bağlantısı ikinci cihazda `localhost`a gider.
İkinci cihaza **katılımcı** (`member`) linki ver — izleyici kesemez, devir alamaz.
Wi-Fi ağı "Public" profilinde ama Node için Public inbound izin kuralı var, ek ayar gerekmedi.
**Her zaman yeni oda aç:** var olan container eski imajdan yaratılmış olabilir.

## Elle test ederken çıkan dört şey (19 Eylül, kapılardan SONRA)

Kapılar yeşilken arayüz elle denendi ve dördü de gerçek sorundu:

1. **Giriş ekranı yalan söylüyordu.** `AUTH_DEV_MODE` olmadan `/auth/request` `{ ok: true }`
   dönüyor, ekran "bağlantı gönderdik" yazıyordu; e-posta gönderimi Faz 3'te, yani giriş
   imkânsızdı. Uç artık `503` + ne yapılacağını söylüyor. `.env`'e `AUTH_DEV_MODE=true`,
   `APP_BASE_URL`, `COOKIE_SECURE=false` eklendi — `npm run dev:all` ile de geçerli.
2. **Hafta 5'ten önce açılmış odalarda sürücü satırı yoktu** → sürücü uçları "agent
   bulunamadı" (`404`). `005_driver_backfill.sql` + kodda kendini onarma.
3. **Gemini rol bağlamı yoktu** → `GEMINI.md`: runner her başlangıçta rol YAML'ını çalışma
   alanına yazıyor (rol prompt'u + çok kişili not + kurulum doğrulama satırı). Kapı hem
   dosyayı hem modelin o satırı yazdığını ölçüyor. **Claude anahtarı beklemeden rol sistemi
   doğrulanabiliyor**; Claude'un `systemPrompt.append`'i ile birbirinin yedeği.
4. **4xx'ler artık sunucu logunda** (üretim dışında): `403 GET /rooms/... — sebep`. "403
   alıyorum" demek hangi uç olduğunu söylemiyordu.

**Açık kalan tek gözlem:** elle testte bir `403` görüldü ama hangi uçtan geldiği
bilinmiyordu. En olası iki sebep: (a) tarayıcı adresinde `?room=<id>` üye olunmayan bir odayı
gösteriyor (kapı koşumlarının açtığı odalar gibi) → `GET /rooms/:id` `403` verir ve SSE
bağlanmaz; (b) oturum başka bir e-postaya ait. Tekrarlarsa sunucu logundaki satır tam yolu
söyleyecek.

## Dogfood denemesinde çıkan iki şey (19 Eylül akşamı)

1. **Kota turn değil İSTEK sayıyor** — "Django ile blog yaz" tek başına günlük kotayı
   bitirdi. Ekrandaki hata da işe yaramıyordu: sebep (`429`) yığın izinin ortasında
   kalıyordu. `summarizeGeminiError` sebebi başa alıyor.
2. **Oda imajında Python yoktu.** Agent doğru davranıp durdu ("kurulum iznim yok") ama
   his "sınırsız yetki verdim, yapamıyor" oldu. İmaja Python 3 + hazır venv (`/opt/venv`,
   PATH'te) + `build-essential` girdi; runner ortamdaki araçların sürümünü ÖLÇÜP rol
   bağlamına yazıyor (elle liste imajla kayar, ölçüm kayamaz).

   **Dikkat:** imaj değişikliği yalnızca YENİ odalar için geçerli. Var olan oda container'ı
   eski imajdan yaratıldı; Python'ı görmesi için yeni oda açılmalı.

## Hafta 5'te ne yapıldı

**Ürünün doğum haftası:** iki kişi aynı agent'a aynı anda yazıyor, iki mesaj asla paralel
inference'a girmiyor, agent kime cevap verdiğini biliyor, sürücülük iki tıkta devrediliyor ve
sürücü koşan turn'ü kesebiliyor.

- **Kuyruk** (`packages/core/src/queue.ts`): DB'de, FIFO, agent başına tek koşan. Garanti üç
  katmanlı — bellekte promise zinciri, `FOR UPDATE SKIP LOCKED`, `agent_queue_single_running`
  kısmi unique index. Üçüncüsü son sözü söylüyor ve testte bir kez ihlal denenip reddedildiği
  doğrulandı.
- **Sürücü** (`packages/core/src/driver.ts`): claim / release / handoff (iyimser kilitli),
  presence 60 sn kayıpsa kendiliğinden düşme.
- **Kesme**: `interrupt.requested` → `interrupt.applied` iki ayrı event; 30 sn'de kapanmayan
  turn için sert kesme. Streaming input'a GEÇİLMEDİ, kesme `abortController` / süreç grubu
  sinyali ile (karar notu README'de).
- **Roller**: `owner` / `member` / `viewer`; davetin varsayılanı `member`.
- **Projeksiyon**: `queue`, `running`, `driver`, `interrupt` alanları; `SNAPSHOT_VERSION` 2.
- **UI**: Composer her zaman açık (agent meşgulken de), QueueList, DriverBadge, kesme düğmesi
  ve "kesme kuyruğa alındı" durumu.
- **Kapı**: `gate:w5` gerçek agent gerektirmiyor — sunucu `AGENT_FAKE_RUNTIME=1` ile kalkıyor,
  hiçbir modele istek gitmiyor. Ölçülen şey model çıktısı değil sıralama.
- **Hafta 4 borçları kapandı**: `gate:w4:agent` 5/5 koştu; turn başarısızlığının SEBEBİ artık
  event log'da ve ekranda; presence bakışı sekme bazlı (`hello` frame'i bağlantı kimliğini
  veriyor).

### Ölçerek bulunan üç gerçek hata

1. **FIFO `enqueued_at` ile çalışmıyordu.** 10 paralel `enqueue`'da iki satır aynı
   mikrosaniyeye düşüyor, sıra rastgele UUID'ye kalıyor ve koşma sırası giriş sırasından
   farklı çıkıyordu. Çözüm: `agent_queue.ord` (artan sayaç).
2. **Presence `touched` alanı `Date.now()` idi**; aynı milisaniyede iki sekme bakış
   değiştirdiğinde eski sekme kazanıyordu. Çözüm: monoton sayaç.
3. **Kesme 32 saniye sürüyordu.** Gemini CLI'ya SIGTERM göndermek onun başlattığı
   `sleep 120` çocuğunu durdurmuyor; host 30 sn sonra sert kesiyordu. Süreç artık kendi
   grubunda başlıyor, sinyal gruba gidiyor → **1 saniyenin altı**. Sahte koşum ortamıyla
   bulunamayacak bir hataydı: sahte runner'ın çocuk süreci yok.

## Çalıştırma

```bash
npm run db:up                                     # postgres + redis
npm run dev:all                                   # api 8787 + arayüz 5173
AUTH_DEV_MODE=true npm run api                    # giriş bağlantısı ekranda görünsün
npm run gate / gate:w3 / gate:w4 / gate:w5        # kapılar, anahtar gerektirmez
npm run gate:w3:agent / gate:w4:agent / gate:w5:agent   # agent gerektirenler
```

**`gate:w5` yaklaşık 8 dakika sürer**: içinde 60 saniyelik gerçek sürücülük düşme ölçümü ve
Hafta 1/3/4 kapılarının regresyonu var.

**Oda imajı değiştiyse** (`rooms/Dockerfile` veya `packages/runner*`) → `npm run room:build`
ve **yeni oda aç**: var olan container eski imajdan yaratılmıştır. 19 Eylül'de imaja Python
girdi, yani dünden kalan odalar Python görmez.

**Sahte koşum ortamı** elle denemek için de kullanılabilir (modelsiz, ücretsiz):

```bash
AUTH_DEV_MODE=true SPAWN_CONTAINER=0 AGENT_FAKE_RUNTIME=1 npm run api
```

Sunucu açılışta `koşum ortamı SAHTE` yazar. `NODE_ENV=production` iken kurulmaz.

**Gemini kotası** ücretsiz katmanda model başına günde **20 MODEL İSTEĞİ** — turn değil.
Tool çağrısı yapan tek bir agentic turn modele birkaç kez gidiyor: 19 Eylül akşamı "Django
ile blog sitesi yaz" isteği tek başına kalan kotayı bitirdi ve dogfood yarıda kaldı.
Pasifik gece yarısı (≈ TSİ 10:00) sıfırlanıyor. Model başına ayrı kota:
`AGENT_MODEL=gemini-3.1-flash-lite` ile devam edilebiliyor (`model: auto` bugün
`gemini-3.5-flash`e çözülüyor). `gate:w5:agent` koşum başına en az üç istek harcar.

## Tuzaklar

1. **Portta kalmış eski sunucu.** Kapılar portu dolu bulursa baştan reddediyor.
2. **Kabuk script'ini koşarken düzenleme.** Bash dosyayı satır satır okur.
3. **Çıplak `wait`.** Hafta 5 kapısı bu yüzden 10 dakika asılı kaldı — tuzak bu dosyada
   YAZIYORDU ve yine düşüldü. Kapılar artık yalnızca kendi başlattıkları PID'leri bekliyor.
4. **`packages/runner*` değiştiyse `npm run build` YETMEZ**, `npm run room:build` gerekir.
   Hafta 5'te `PROTOCOL_VERSION` 2'ye çıktı: bayat imajla agent `stopped`da kalır ve sunucu
   logunda "imaj protokol sürümü uyuşmuyor" yazar. Agent kapısı ilk koşumda tam bunun yüzünden
   düştü.
5. **Toplu `docker rm -f` ile oda container'larını silme** — canlı odaları öldürür.
6. **Kapı testinde ölçüm sıklığı.** Örnek başına bir `docker compose exec` açmak saniyede bir
   örnek demek; eşzamanlılık iddiasını 3 örnekle kanıtlamak ölçmemekle aynı şey. Örnekleme
   Postgres'in içinde (`\watch 0.1`).

## Bilinen ve kabul edilmiş sınırlar

- **Cloudflare hızlı tüneli SSE'yi TAMPONLUYOR** (ölçüldü). Yerel ağ ve vite vekili sorunsuz;
  uzaktan erişim için akışı geçiren bir tünel (ngrok) lazım.
- **Redaction agent'ın context'ini korumaz** — engellemek onay kuyruğunun işi (Hafta 10).
- **Gemini'de sistem prompt'u yok**: rol YAML'ındaki `system_prompt` ve çok kişili oda notu
  Gemini agent'ına ulaşmıyor (CLI'da bayrak yok). Agent kimin yazdığını yalnızca `[İsim]: `
  önekinden anlar — kapı bunun yeterli olduğunu ölçtü, ama çelişen iki yönergede davranışı
  Claude yolundan farklı olabilir.
- **Gemini tool çıktısının metnini vermiyor**, sadece `status`.
- **Oda imajında ne varsa o var**: agent sistem paketi kuramaz (root değil). Bugün imajda
  Node 22, Python 3 + hazır venv (`/opt/venv`), build-essential, git, ripgrep, curl var.
  Başka bir dil gerekirse `rooms/Dockerfile`a girmesi ve imajın yeniden derlenmesi gerekir;
  runner ortamı ölçüp agent'a söylüyor, yani liste ile gerçek arasında kayma olmaz.
- **Tek sunucu örneği varsayımı** — `AgentManager`, presence ve sürücü izleyicisi bellekte.
  Kuyruk kodu çok sunucuya hazır yazıldı (satır kilidi) ama ikinci sunucu çalıştırılmadı.
- **`npm audit`** dev bağımlılıklarında zafiyet bildiriyor.

## Okuma sırası (yeni bir oturum buradan başlarsa)

1. Bu dosya
2. `README.md` — mimari, iki kural, roller, kuyruk/sürücü/kesme semantiği, karar notları
3. `docs/roadmap.md` — 12 haftalık plan
4. `docs/week-01.md` … `docs/week-05.md` — hafta hafta ne yapıldı ve **neden**
5. `docs/runtime-gemini.md` — ikinci koşum ortamının ölçümleri ve eksikleri

## Çalışma tarzı (yeni oturum bunu bilmeli)

- Her adımın **kabul kriteri doğrulanmadan** sonrakine geçilmez; "çalışıyor gibi duruyor"
  yeterli değil, ölçüm gerekir.
- Değişmez kurallarla çelişen bir kısayol gerekirse durup README "Karar notları"na yazılır.
- Kapsam dışı listesindeki hiçbir şeye "hazırlık" amacıyla bile başlanmaz.
- Her adım sonunda anlamlı bir commit; hafta sonunda kapı script'i + dogfood + README.
