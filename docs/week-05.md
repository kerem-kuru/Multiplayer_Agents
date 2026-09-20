# Hafta 5 — Yazma yetkisi, kuyruk, kesme

**Biten iş (kapı):** İki kişi aynı agent'a aynı anda yazıyor, çakışma yok, agent kime cevap
verdiğini biliyor. Sürücülük iki tıkta devrediliyor.

Hafta 4'ün sonunda ikinci kişi odaya girip canlı izliyordu ama hiçbir şeye dokunamıyordu.
Bu hafta izleyici katılımcıya dönüştü. Zor kısım UI değil **eşzamanlılık**: iki mesaj paralel
inference'a girerse agent'ın context'i bozulur ve hata **sessizce** oluşur.

## Görev listesi

| # | Adım | Durum |
| --- | --- | --- |
| 1 | Roller: `owner` / `member` / `viewer` | ✅ davet iki rol üretiyor, varsayılan `member` |
| 2 | Migration 004 (kuyruk + sürücü) | ✅ `agent_queue_single_running` dahil |
| 3 | Yeni event'ler | ✅ 7 yeni tip, `turn.failed` sebebine `interrupted` |
| 4 | Kuyruk ve zamanlayıcı | ✅ 12 birim test, gerçek DB + sahte runner |
| 5 | Sürücü | ✅ 8 birim test |
| 6 | Kesme (runner tarafı) | ✅ `abort` yolu; streaming input'a geçilmedi (karar notu) |
| 7 | Sistem prompt'u: odada birden fazla insan | ✅ Claude'da `systemPrompt.append`, Gemini'de `GEMINI.md` — ikisi birbirinin yedeği |
| 8 | API | ✅ mesaj/kuyruk/sürücü/kesme uçları |
| 9 | Projeksiyon | ✅ `SNAPSHOT_VERSION` 2, snapshot doğruluğu yeni alanlarla geçiyor |
| 10 | UI | ✅ Composer her zaman açık, QueueList, DriverBadge, kesme düğmesi |
| 11 | Kapı script'i | ✅ `gate:w5` 25/25 · `gate:w5:agent` 5/5 (Gemini) |
| 12 | Cuma dogfood | ✅ 20 Eylül, iki kişi iki cihaz, 7 mesaj · notlar README'de |
| 13 | README | ✅ |

## Tek koşan garantisi: üç katman, üçü de gerekli

```
1. bellekte agent başına promise zinciri   → tick aynı anda iki kez koşmaz
2. FOR UPDATE SKIP LOCKED                  → iki seçici aynı satırı alamaz
3. agent_queue_single_running (kısmi uniq)  → DB ikinci 'running' satırı REDDEDER
```

Üçüncüsü son sözü söylüyor ve testte bir kez **ihlal denenip reddedildiği** doğrulandı.
Birinci ve ikinci katman kodun dikkatine dayanır; üçüncüsü dayanmaz.

## Ölçerek bulunan hata: FIFO `enqueued_at` ile çalışmıyor

Kuyruk sırası ilk hâlde `ORDER BY enqueued_at, id` idi. 10 paralel `enqueue` ile koşturulan
birim test **sırayı bozuk** buldu: iki satır aynı mikrosaniyeye düştü ve sıra rastgele
UUID'ye kaldı — yani koşma sırası kuyruğa giriş sırasından farklı çıktı.

Tahminle yazılsa fark edilmezdi: iki kişi elle yazarken bu yarış neredeyse hiç görünmez.
Çözüm `agent_queue.ord` (artan sayaç); eşitlik artık imkânsız.

İkinci benzer hata presence tarafında çıktı (Hafta 4 borcu kapatılırken): `touched` alanı
`Date.now()` idi ve aynı milisaniyede iki sekme bakış değiştirdiğinde **eski** sekme
kazanıyordu. Sıra sorusunun cevabı duvar saati değil monoton sayaç.

## Kesme: iki event, sıfır olmayan bir aralık

```
interrupt.requested   → istek anında yazılır (sürücü bastı)
        │
        ├─ runner'a sinyal (abort / SIGTERM)
        │
interrupt.applied     → gerçekten durdu (mode: graceful | abort | hard_kill)
turn.failed           → reason: "interrupted"
```

UI aradaki süreyi **"Kesme istendi — agent şu an bir komutu bitiriyor"** olarak gösterir.
Uzun bir bash komutunun ortasında anlık durdurma sözü verilmiyor; 30 saniyede kapanmayan
turn için sert kesme var (`mode: hard_kill`) ve turn `interrupted` ile kapanır.

### Ölçüm: kesme 32 saniyeden 1 saniyenin altına indi

Gerçek agent kapısı (`gate:w5:agent`, Gemini, `sleep 120` koşarken) ilk koşumda şunu
ölçtü:

```
mode = hard_kill · 32 sn
```

Sebep: Gemini CLI'ya SIGTERM göndermek onun başlattığı `sleep 120` çocuğunu durdurmuyordu.
Turn kapanmıyor, host 30 saniye sonra runner'ı sert kesiyordu. Yani ürün "kestim" diyordu
ama kullanıcı yarım dakika bekliyordu.

Düzeltme: Gemini süreci `detached: true` ile **kendi süreç grubunda** başlatılıyor ve sinyal
gruba gönderiliyor (`process.kill(-pid)`). Aynı kapı şimdi şunu ölçüyor:

```
mode = abort · 0 sn (bir saniyenin altında)
```

Bu, sahte koşum ortamıyla asla bulunamayacak bir hataydı: sahte runner'ın çocuk süreci yok.
Gerçek agent kapısının iki kontrol için ayrı tutulmasının gerekçesi de bu.

Kesilen mesaj **yeniden koşmaz**. İptal edilen, sunucu yeniden başlatmasıyla düşen mesaj da
koşmaz — Hafta 2'den gelen kural: agent işin yarısını yapmış olabilir.

## Sürücülük bir rol, kilit değil

Sürücü olmayan `member` odayı kullanmaya devam eder: mesaj yazar, kuyruğa girer, kendi
kaydını iptal eder. Sürücünün fazladan iki yetkisi var — koşan turn'ü kesmek ve başkasının
kuyruk kaydını iptal etmek.

- Devir **iki tık**: "Devret" → kişi seç. Aday listesini sunucu süzüyor (izleyici olamaz:
  kesme yetkisini yazma yetkisi olmayana vermek olurdu).
- `version` iyimser kilit: ekranda gördüğün sürücü artık başkası olabilir ve devir sessizce
  onun üstüne yazmamalı → `409`.
- Odaya ilk yönergeyi yazan kişi, sürücü boşsa **otomatik** sürücü olur. Sürücü varsa
  sessizce vazgeçilir: mesaj göndermek sürücülük kavgası açmamalı.
- Sürücünün presence'ı 60 saniye kayıpsa sürücülük düşer (`driver.released`, `left_room`).
  Presence geri gelirse sayaç **sıfırlanır** — her F5 sürücülüğü elinden almasın.

## Kapı neden gerçek agent'sız koşuyor

`gate:w5` sunucuyu `AGENT_FAKE_RUNTIME=1` ile kaldırıyor: hiçbir modele istek gitmiyor,
turn'ü N ms sonra bitiren bir sahte koşum ortamı devreye giriyor. Gerçek DB, gerçek kuyruk,
gerçek event log, gerçek SSE, gerçek yetki — sadece model yok.

Gerekçe: bu haftanın kanıtlaması gereken şey model çıktısı değil **sıralama**. Gerçek
agent'la ölçmek pahalı, yavaş ve yarış penceresini daraltıyor; sahte runner'la 5 paralel
mesaj yarış penceresini gerçeğinden **geniş** yapıyor ve kapı saniyeler içinde koşuyor.

Gerçek agent'ın kanıtlaması gereken iki şey ayrı kapıda (`gate:w5:agent`, iki istek harcar):
modelin `[İsim]: ` etiketini okuyup kime cevap verdiğini söylemesi ve **gerçekten koşan** bir
işin ortasında kesilme.

Sahte ortam `NODE_ENV=production` iken kurulmaz ve sunucu açılışta ekrana
`koşum ortamı SAHTE` yazar: sessizce sahte cevap veren bir sunucu, hiç cevap vermeyenden
kötüdür.

## Kaldırılan iki event

`driver.changed` ve `agent.interrupted` (Hafta 1 kataloğundan, hiç yazılmamış) kaldırıldı.
Bu haftanın `driver.claimed` / `driver.released` / `driver.handed_off` ve
`interrupt.requested` / `interrupt.applied` event'leriyle örtüşüyorlardı; iki üst üste binen
event tipi, ileride yanlışını yazmak için duran bir tuzaktır.

`PROTOCOL_VERSION` 2'ye çıktı: runner protokolü `interrupt` komutu kazandı, bayat bir oda
imajı sessizce değil açıkça düşsün (`npm run room:build` gerekir).

## Şemadan bir sapma

Görev tanımı `message.cancelled.by` alanını zorunlu bir kullanıcı olarak tanımlıyordu, ama
aynı event'in sebep listesinde `server_restart` ve `agent_failed` var — o iptalleri bir insan
yapmıyor. Alan `nullable` yapıldı; kaydın sahibini "iptal eden" diye yazmak log'u yalancı
yapardı.

## Kapı çıktısı (19 Eylül 2026)

| Kontrol | Sonuç |
| --- | --- |
| İki kişi aynı anda yazıyor | ikisi de `202`, `position` 1 ve 2 |
| Koşum boyunca iki `running` satır | **139 örneklemede en yüksek 1** |
| Event sırası | `queued → received → started`; ikinci turn birincinin bitişinden sonra |
| 5 paralel mesaj | 5 turn, sıra enqueue sırasıyla aynı, hiçbiri kayıp değil |
| Kuyruk sınırı | 11. mesaj `429` |
| İptal | kendi `200` · başkasının `403` · owner `200` · iptal edilen mesaj hiç çalışmadı |
| Aktör etiketi | `agent.text` içinde `Ayse` (16 kez) |
| Ham metin | 22 `message.queued` event, hiçbirinde önek yok |
| Sürücü | ikinci claim `409` + mevcut sürücü · devir yazıldı · eski sürücünün kesmesi `403` |
| Devir kontrolleri | eski `version` `409` · üye olmayan `400` · izleyici hedefi `400` |
| Kesme | `requested` hemen · `applied` + `turn.failed(interrupted)` 2 sn içinde · agent `idle` |
| Kesme sonrası | sıradaki mesaj kendiliğinden başladı |
| Kesme yetkisi | sürücü değil `403` · koşan turn yok `409` · izleyici `403` |
| Sunucu yeniden başlatma | koşan satır `cancelled(server_restart)`, bekleyenler korundu ve aktı, kesilen tekrar koşmadı |
| Agent `failed` | bekleyen 2 kayıt `cancelled(agent_failed)`, kuyruk boş |
| İzleyici | mesaj `403` · sürücülük `403` · kuyruk `200` |
| Sürücülük düşmesi | presence kaybından **61 sn** sonra (`driver.released · left_room`) |
| Regresyon | 226 birim test · Hafta 1, 3, 4 kapıları |

**Geçen: 25 · Kalan: 0.** Gerçek agent kapısı (Gemini): **5/5**.

Kapının kendisi üç koşumda oturdu ve üçü de kapı hatasıydı, ürün hatası değil:

1. **Çıplak `wait`** — hayatta kalan örnekleyici alt kabuğunu bekledi, kapı 10 dakika asılı
   kaldı. Bu tuzak devir notunda **yazıyordu** ve yine düşüldü; artık yalnızca kapının kendi
   başlattığı PID'ler bekleniyor.
2. **Örnek başına bir `docker compose exec`** — örnek başına ~1,5 sn, 3 saniyelik koşumda
   3 örnek. "İki `running` satır yok" iddiasını 3 örnekle kanıtlamak, ölçmemekle neredeyse
   aynı şey. Örnekleme Postgres'in içine taşındı (`\watch 0.1`) → 139 örnek.
3. **İptal kontrolü boş kuyrukta koşuyordu** — mesaj anında `running` olduğu için iptal
   `409` alıyordu. Ürün doğru davranıyordu; senaryo yanlıştı (önce agent meşgul edilmeli).

Ayrıca Hafta 4 kapısı düştü ve sebebi gerçek bir regresyon riskiydi: davetin varsayılan rolü
`member` olunca "izleyici yazamaz" kontrolü sessizce başka bir şeyi ölçmeye başladı. Kapı
artık rolü açıkça `viewer` veriyor.

## Kapı sonrası gelen dört düzeltme (elle test)

Kapılar geçtikten sonra arayüz elle denendi ve dört şey çıktı:

1. **Giriş ekranı yalan söylüyordu.** `AUTH_DEV_MODE` kapalıyken `/auth/request`
   `{ ok: true }` dönüyor, ekran "adresine bir bağlantı gönderdik" yazıyordu — oysa
   e-posta gönderimi henüz kurulmadı (Faz 3), yani giriş imkânsızdı. `npm run dev:all` bu
   değişkeni geçirmiyor ve elle test eden kişi bekleyen bir e-posta sandı. Uç artık `503` ve
   ne yapılacağını söylüyor: *"sunucuyu AUTH_DEV_MODE=true ile koş"*. `.env`'e de eklendi ki
   `dev:all` ile de geçerli olsun.
2. **Hafta 5'ten önce açılmış odalarda sürücü satırı yoktu** ve sürücü uçları `404`
   dönüyordu ("agent bulunamadı" — oysa agent orada). `005_driver_backfill.sql` mevcut
   odaları odanın AÇILDIĞI ANDAKİ konfigürasyonundan dolduruyor; ayrıca
   `getDriver`/`claimDriver` eksik satırı rol YAML'ından **kendi kendine tamir ediyor**
   (migration'ı koşturmayı unutan kurulum için).
3. **4xx'ler artık sunucu logunda.** "403 alıyorum" demek hangi uç olduğunu söylemiyor;
   sunucunun bildiği bir şeyi kullanıcıya aratmak yanlış. Üretim dışında her `HttpError`
   `403 GET /rooms/... — sebep` olarak loglanıyor.
4. **Gemini rol bağlamı** (`GEMINI.md`) — yukarıdaki Adım 7 satırı.

## Dogfood'un bulduğu iki şey (kod dışında)

Kapılar yeşilken yapılan ilk gerçek denemede iki şey çıktı ve ikisi de üründe düzeltildi:

**1. Kota turn değil İSTEK sayıyor.** "Django ile blog sitesi yaz" görevi tek başına kalan
günlük kotayı bitirdi: tool çağıran bir agentic turn modele birkaç kez gidiyor. Ekranda
görünen hata ise işe yaramıyordu —

```
● başarısız · sdk_error · gemini: error — sync file:///opt/runner/gemini/.../gemini-LUNNHKPJ.js:11868:26
```

Sebep (`code: 429` + kota metni) yığın izinin ortasındaydı, UI metnin başını gösteriyor.
`summarizeGeminiError` artık sebebi başa alıyor, yığın izi payload'da kalıyor. Yani Hafta 4
borcunu kapatırken sebep log'a taşınmıştı ama **okunur** hâle getirilmemişti.

**2. "Sınırsız yetki" oda imajıyla sınırlı.** Agent Django görevinde doğru davranıp durdu:
*"Python yüklü değil, sistem düzeyinde kurulum iznim yok."* Doğru teşhis — oda imajı Node
imajıydı. Ama kullanıcı tarafındaki his "sınırsız yetki verdim, yapamıyor" oldu.

İki taraflı düzeltildi: imaja Python 3 + hazır venv (`/opt/venv`, PATH'in başında, yani
`pip install django` doğrudan çalışıyor) ve `build-essential` girdi; runner da her
başlangıçta ortamdaki araçların sürümünü **ölçüp** rol bağlamına yazıyor. Elle yazılmış bir
liste imajla kayardı — `node --version` kayamaz. Eksik araç "ortamda YOK" diye yazılıyor ki
agent uydurma bir yol aramak yerine neyin eksik olduğunu söylesin.

Aynı metin iki koşum ortamına da gidiyor: Claude'da `systemPrompt.append`, Gemini'de
`GEMINI.md`. Tek kaynak `packages/protocol/src/prompts.ts`.

## Dogfood (20 Eylül 2026) — ölçülen sayılar

İki kişi (`kerem`, `deneme50`), iki ayrı cihaz, aynı yerel ağ üzerinden tek agent'a
(`backend`, `gemini-3.1-flash-lite`) 5 dakikada 7 mesaj. Event log'dan çıkan tablo:

| Ölçüm | Sonuç |
| --- | --- |
| Kesme gecikmesi | **109 ms** (`requested` → `applied`, `mode: abort`) |
| Kesilen turn | `turn.failed · reason: "interrupted"`, kendiliğinden yeniden koşmadı |
| Kesen kişi | devirden sonraki sürücü — devir kesme yetkisini gerçekten taşıdı |
| Sürücülük | ilk mesajla otomatik claim (34 ms) → devir → bırakma → yeni claim, 6 sn içinde |
| Eşzamanlı yazma | koşan turn sırasında gelen mesaj önceki `turn.completed`'dan 59 ms sonra alındı |
| Kuyrukta bekleme | 10,8 sn; sıra bozulmadı |
| Örtüşme | sıfır — hiçbir anda iki `running` satır yok |

Dört dogfood sorusunun hiçbirinde sorun çıkmadı: bekleme hissedilmedi, kuyruk ekranında eksik
bir bilgi rapor edilmedi, agent iki kişinin birbirinin işine dokunan silme isteklerini
karıştırmadı, devir iki tıkta bitti.

**Kapının ölçtüğü ile gerçek kullanımın ölçtüğü aynı çıktı.** Kapı kesmeyi `sleep 120` gibi
en kötü durumda ölçüyor (1 sn altı); gerçek kullanımda 109 ms. Burada yeni bir ürün hatası
çıkmaması, kapının doğru şeyi ölçtüğünün kanıtı — Hafta 4'te dogfood iki hata bulmuştu.

Dogfood'a girerken ayrı bir şey çıktı: Docker yeniden başladığında dünkü oda container'ı
`Exited` kalıyor ve arayüz ham Docker hatası gösteriyor
(`HTTP code 409 … is not running`). Sunucu container'ın var-ama-durmuş olduğunu biliyor;
kullanıcıya bunu insan diliyle söylemesi ya da container'ı kaldırması gerek. **Hafta 6'ya
borç.**

## Kalan iş

- **Streaming input'a geçilmedi.** Kesme `abortController` ile yapılıyor (`mode: "abort"`).
  Görev tanımı bu yolu açıkça izin veriyor; gerekçe karar notlarında.
- ~~Gemini'de sistem prompt'u yok~~ → **kapandı:** rol bağlamı `GEMINI.md` ile gidiyor.
  Gemini CLI'da sistem prompt'u bayrağı hâlâ yok; runner rol YAML'ını çalışma alanındaki
  bağlam dosyasına yazıyor ve kapı bunun modele ULAŞTIĞINI ölçüyor (agent doğrulama
  satırını yazdı). Claude yolundaki `systemPrompt.append` ile birbirinin yedeği.
- **`gate:w2` hâlâ koşulmadı** (Claude anahtarı yok) — Hafta 2'den kalan boşluk.
