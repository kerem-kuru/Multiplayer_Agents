# Multiplayer Agent Odaları

Bir **oda**, içinde birden çok Claude terminali barındıran izole bir container'dır. Her terminal bir rolü üstlenir (frontend, backend, güvenlik, planlama). Odaya giren birden çok geliştirici aynı anda bu agent'lara görev verir, işlerini canlı izler, yönlerini değiştirir ve sürücülüğü birbirine devreder.

Agent'lar birbirine mesaj atmaz. Ortak bir **oda defterine** yazar ve oradan okur.

> **Tez:** Gerçek birim agent değil, her agent'ın okuyup yazdığı tek paylaşılan bağlam deposudur.

Durum: **Hafta 5 bitti** — ürünün gerçek doğum haftası. İki kişi **aynı agent'a aynı anda**
yazıyor, mesajlar sıraya giriyor ve iki mesaj asla paralel inference'a girmiyor; agent kime
cevap verdiğini biliyor; sürücülük iki tıkta devrediliyor ve sürücü koşan turn'ü kesebiliyor.

Hafta 4'ten devam: paylaşım linkine tıklayan kişi saniyeler içinde odayı canlı izliyor ve
agent'a bilerek `.env` okutulduğunda secret ne ekranda ne veritabanında görünüyor.

Hafta 3'ten devam: akış kapısı 11/11 (`gate:w3`) ve iki tarayıcı testi (`gate:w3:agent`) geçiyor.

**Hafta 2 kapısı hâlâ koşulmadı:** kodu tamam ama `gate:w2` Claude Agent SDK ile gerçek çağrı
yapar ve `ANTHROPIC_API_KEY` ister; anahtar yok. Hafta 2'nin boru hattı Gemini koşum ortamıyla
uçtan uca doğrulandı (`npm run smoke:gemini`).

## Hızlı başlangıç

Gereksinimler: Node 20+, Docker. Agent koşumu için `ANTHROPIC_API_KEY` (BYOK — anahtar imaja veya compose'a gömülmez, sadece `.env`'de yaşar).

```bash
cp .env.example .env
npm install
npm run build
npm test             # 27 test — docker ve DB gerekmez

npm run verify       # tek komut: docker bekle → db → migrate → smoke → imaj → kapı
npm run gate:w2      # Hafta 2 kapısı — 14 kontrol, GERÇEK API çağrısı yapar
npm run gate:w3      # Hafta 3 akış kapısı — 11 kontrol, anahtar GEREKTİRMEZ
npm run gate:w3:agent # Hafta 3'ün agent gerektiren 2 tarayıcı testi (api + web ayakta olmalı)
npm run gate:w4      # Hafta 4 kapısı — 20 kontrol, anahtar GEREKTİRMEZ
npm run gate:w4:agent # gerçek agent'a .env okutup sızıntı kontrolü (anahtar ister, yoksa atlar)
```

## Tarayıcıda izle

```bash
npm run dev:all      # api (8787) + arayüz (5173)
```

Sonra `http://localhost:5173` — oda aç, agent'ı başlat, görev yaz, canlı izle.

Sekmeyi kapatıp açtığında tek bir event kaybolmaz: geçmiş REST'ten sayfalanır,
sonra SSE `since` ile kaldığı yerden devam eder.

`verify` her şeyi sırayla yapar. Ayrı ayrı koşturmak istersen kapıdan **önce** veritabanı gerekir:

```bash
npm run db:up        # postgres + redis
npm run db:migrate   # şema
npm run room:build   # oda imajı
npm run gate         # Hafta 1 kapısı — 10 kontrol
npm run gate:w5      # Hafta 5 kapısı — kuyruk, sürücü, kesme (agent gerektirmez)
```

`gate:w5` sunucuyu `AGENT_FAKE_RUNTIME=1` ile kaldırır: hiçbir modele istek gitmez, turn'ü
N ms sonra bitiren sahte bir koşum ortamı devreye girer. Ölçülen şey model çıktısı değil
**sıralama**; sahte runner'la yarış penceresi gerçeğinden geniş olur. Gerçek agent'ın
kanıtlaması gereken iki şey ayrı kapıda: `npm run gate:w5:agent` (modelin `[İsim]: `
etiketini okuması ve gerçekten koşan bir işin ortasında kesilme).

## Giriş, paylaşım ve izleyici

Hafta 4'ten itibaren **her uç oturum ister** — SSE dahil. Şifre yok: e-postaya tek
kullanımlık bir bağlantı gider.

```bash
# .env
APP_BASE_URL=http://localhost:5173   # magic link ve davet linklerinin gövdesi
AUTH_DEV_MODE=true                   # SADECE geliştirme: bağlantıyı yanıtta/logda göster
COOKIE_SECURE=false                  # HTTPS ardındaysan true
```

**E-posta gönderimi henüz yok (Faz 3).** Bu yüzden `AUTH_DEV_MODE=true` olmadan giriş
yapılamaz ve uç bunu açıkça söyler (`503`): eskiden `{ ok: true }` dönüp ekranda "bağlantı
gönderdik" yazıyordu — hiçbir bağlantı gitmediği hâlde. `.env` dosyasında durması
`npm run dev:all` ile de geçerli olmasını sağlar.

**`AUTH_DEV_MODE` yetkilendirmeyi ETKİLEMEZ.** Açıkken de her uç üyelik ve rol kontrolü
yapar; tek yaptığı, e-posta gönderimi olmadığı için giriş bağlantısını yanıtta göstermek.
Üretimde kapalı olmalı.

**Giriş:** arayüzde e-postanı yaz → bağlantıya tıkla. Terminalden:

```bash
TOKEN=$(node scripts/dev-login.mjs --base http://localhost:8787 --email sen@ornek.com)
curl -b "rooms_session=$TOKEN" http://localhost:8787/rooms
```

**Paylaşım:** oda sahibi "Paylaş" → link üretir. Link **çok kullanımlıktır** (ekibe tek link
atılır), sürelidir ve iptal edilebilir; magic link ise tek kullanımlıktır. Linke tıklayan kişi
odaya davetin rolüyle katılır.

**Roller (Hafta 5):**

| Rol | Yetki |
| --- | --- |
| `owner` | Her şey + davet üretme/iptal, agent start/stop, rol değiştirme |
| `member` | Kuyruğa mesaj ekleme, kendi kaydını iptal, sürücülüğü alma/devretme, sürücüyken kesme |
| `viewer` | Sadece izleme — kuyruğu görür, yazamaz |

Davetin varsayılan rolü **`member`**: kuyruk geldiği için iki kişinin aynı agent'a yazması
artık güvenli. "Sadece izlesin" istiyorsan paylaşım kutusunda `İzleyici` seç. Oda sahibi
sonradan da değiştirebilir: `PATCH /rooms/:id/members/:userId` (son owner'ın rolü düşmez).

Ham token hiçbir tabloda durmaz: `magic_links`, `auth_sessions` ve `room_invites` yalnızca
`sha256` taşır.

## Redaction — neyi korur, neyi korumaz

Her event, DB'ye **yazılmadan önce** tek geçitten (`appendEvent`) geçer: gitleaks'ten üretilmiş
198 kural + entropi taraması. Eşleşen değer `[redacted:<kural>:<hash8>]` ile değişir; anahtar
adı ekranda kalır, değer kaybolur. Aynı secret her yerde aynı işareti alır, yani "aynı anahtar
iki yerde geçmiş" bilgisi korunur.

**Korur:** event log, UI, snapshot, SSE akışı, sunucu logu (runner'ın stderr'i dahil) ve
`redaction_findings` (orada da sadece kural, yol, uzunluk ve hash'in ilk 8 hex'i durur).

**KORUMAZ: agent'ın kendi context'i.** Agent `.env` dosyasını okursa içerik modele gider. Bu
tasarım gereği — dosya okumasını engellemek onay kuyruğunun işi (Hafta 10). Bu hafta
garanti edilen şey, o içeriğin **log'a ve ekrana düşmemesi**.

Projeye özgü tekrar eden yanlış pozitifler oda YAML'ından susturulur:

```yaml
redaction:
  allow_patterns:
    - "^FIXTURE_"
```

Bu yalnızca entropi taramasını susturur; bilinen formatlı bir secret her zaman maskelenir.

## Oda aç

```bash
npm run api          # http://localhost:8787

curl -X POST http://localhost:8787/rooms \
  -H 'content-type: application/json' -H 'x-user-id: kerem' -d '{}'

curl 'http://localhost:8787/rooms/<id>/events?since=0'
curl  http://localhost:8787/rooms/<id>/journal
curl -X POST http://localhost:8787/rooms/<id>/stop
```

## Agent'a görev ver

```bash
curl -X POST http://localhost:8787/rooms/<id>/agents/backend/start

curl -X POST http://localhost:8787/rooms/<id>/agents/backend/message   -H 'content-type: application/json' -H 'x-user-id: kerem'   -d '{"text":"hello.js dosyası oluştur ve node ile çalıştır"}'
# → 202 {"messageId":"..."}  — turn'ün bitmesi beklenmez

curl  http://localhost:8787/rooms/<id>/agents            # durum: stopped/idle/busy/crashed
curl 'http://localhost:8787/rooms/<id>/events?since=0'   # her adım yapılandırılmış event
```

Agent meşgulken gelen mesaj **reddedilmez, kuyruğa girer** (Hafta 5). Yanıt
`202 {messageId, position}`; `position` 1 ise sıradaki ilk, koşan bir mesaj varsa o 1'dir.

```bash
curl  http://localhost:8787/rooms/<id>/agents/backend/queue      # koşan + bekleyenler
curl -X DELETE http://localhost:8787/rooms/<id>/queue/<messageId>  # kendi kaydını iptal
curl -X POST http://localhost:8787/rooms/<id>/agents/backend/driver/claim
curl -X POST http://localhost:8787/rooms/<id>/agents/backend/interrupt   # YALNIZCA sürücü
```

## Kuyruk, sürücü, kesme

**Agent başına aynı anda en fazla bir mesaj inference'ta.** İki mesaj paralel girerse
agent'ın context'i bozulur ve hata sessizce oluşur. Garanti üç katmanlı ve katmanlar
birbirinin yedeği:

1. bellekte agent başına promise zinciri — zamanlayıcı aynı anda iki kez koşmaz,
2. `FOR UPDATE SKIP LOCKED` — iki seçici aynı satırı alamaz,
3. `agent_queue_single_running` kısmi unique index — kodda bir yarış kalsa bile **DB**
   ikinci `running` satırı reddeder.

Kuyruk **DB'de** durur: sunucu yeniden başlayınca bekleyen mesajlar kaybolmaz ve kuyruk
herkese aynı görünür. Sıra **FIFO**; sürücünün mesajı da sıraya girer. Mesajlar
**birleştirilmez** — her mesaj kendi turn'ünü alır, yoksa agent kime cevap verdiğini
kaybeder.

Her mesaj agent'a `[İsim]: ...` olarak girer. Önek runner'a verilirken eklenir; event
log'daki metin **öneksiz** durur (kullanıcının yazdığı neyse o).

**Sürücülük bir rol, kilit değil.** Sürücü olmayan `member` yazmaya devam eder; sürücünün
fazladan iki yetkisi var: koşan turn'ü kesmek ve başkasının kuyruk kaydını iptal etmek.
Devir iki tık ("Devret" → kişi seç) ve `version` ile iyimser kilitli. Odaya ilk yönergeyi
yazan kişi, sürücü boşsa otomatik sürücü olur. Sürücünün presence'ı **60 sn** kayıpsa
sürücülük düşer; presence geri gelirse sayaç sıfırlanır.

**Kesme anında olmayabilir.** `interrupt.requested` ile `interrupt.applied` iki ayrı
event'tir; UI aradaki süreyi *"Kesme istendi — agent şu an bir komutu bitiriyor"* diye
gösterir. 30 saniyede kapanmayan turn için sert kesme var (`mode: hard_kill`). Kesilen,
iptal edilen veya sunucu yeniden başlatmasıyla düşen mesaj **asla yeniden koşmaz**.

Ölçüm (Gemini, `sleep 120` koşarken): kesme ilk hâlde **32 saniye** sürüyor ve `hard_kill`
ile bitiyordu — SIGTERM, CLI'nın başlattığı kabuk komutunu durdurmuyor. Süreç artık kendi
grubunda başlatılıyor ve sinyal gruba gidiyor; aynı ölçüm **1 saniyenin altında**
(`mode: abort`).

Docker'sız çalışmak için `SPAWN_CONTAINER=0` — oda kaydı ve klasörler kurulur, container açılmaz.

## İzleyiciden katılımcıya: yetki isteme

İzleyici diff'i ve akışı görür, yazamaz. Ekrandaki satır artık ne olduğunu söylemekle
kalmıyor, **yapma yolunu da veriyor**: "Yetki iste" düğmesi. İstek odanın sahibine üst
kısımda tek satır olarak düşer — *"Ayse katılımcı olmak istiyor"* — ve **Katılımcı yap** /
**Reddet** tek tık.

İstekler ayrı bir tabloda tutulmuyor: `access.requested` ve `access.resolved` event'leri
event log'a giriyor ve durum projeksiyondan okunuyor. Böylece rol değişikliğinin
**gerekçesi** de odanın tarihinde kalıyor ve ikinci bir gerçek kaynak doğmuyor.

Açık bir isteğin varken ikinci kez basmak yeni kayıt açmaz. İstenen rol yalnızca
`member` — `owner` istemek bir yetki devridir, istek değil.

## Diff, satır yorumu ve checkpoint

Agent detayında üç sekme var: **Etkinlik · Diff · Terminal**. Diff sekmesi agent'ın
**tabandan beri** değiştirdiği dosyaları gösterir ve herkeste aynı anda güncellenir.

**Taban nedir:** agent ilk başlatıldığında workspace'in o anki hâlinden bir checkpoint
alınır; diff hep ona göredir. Bu yüzden workspace'e **sonradan elle kopyalanan dosyalar
agent'ın değişikliği gibi görünür** — sıfırlamak için agent boştayken *Checkpoint al*
düğmesine basılır, taban oraya kayar ve diff boşalır.

**Satıra yorum:** satır numarasının üzerine gelince (veya klavyeyle odaklanınca) çıkan `+`
düğmesi. Yazdığını ya *Taslağa ekle* dersin (taslaklar yalnızca senin tarayıcında durur,
başkası görmez) ya da *Hemen gönder* — o da tek yorumlu bir incelemedir. Taslak varken
ekranın altında "N taslak yorum · Yorumları gönder (N)" çubuğu durur.

İnceleme gönderildiğinde agent'a **tek turn** olarak gider ve metni sunucu kurar:

```
1) src/order.js:14
   > function processOrder(order, db) {
   bunu böl
```

Yorum bir satır numarasına değil, **numara + satır metnine** çapalanır. Agent araya satır
eklerse yorum kaybolmaz: aynı metin başka tek bir satırda bulunursa yorum oraya taşınır ve
"satır yer değiştirdi" etiketi alır (`moved`); metin hiç yoksa veya birden çok kez geçiyorsa
dosyanın altındaki **"Eskimiş yorumlar"** bölümüne düşer (`outdated`). Belirsizlikte
tahmin yürütülmez.

Yorumu **çözmek ve yeniden açmak insanın işidir.** Agent cevabında uyguladığını söyleyebilir
ama yorumu kapatamaz. `viewer` diff'i ve yorumları görür, yazamaz — yetki sunucuda, `+`
düğmesinin gizlenmesinde değil.

**Güvenlik notu:** agent'ın workspace'i düşman bir depo sayılır. Agent oraya bir git hook'u
veya `core.fsmonitor` komutu yazabilir; host bu depoda `git` çalıştırsaydı o kod host'ta
çalışırdı. Bu yüzden **git yalnızca container içinde koşar**, sunucu ona `docker exec` ile
ulaşır ve çağrılar `core.hooksPath=/dev/null`, `core.fsmonitor=false` ile korunur.
Checkpoint alırken branch, `HEAD`, `.git/index` ve çalışma ağacı **değişmez** (ayrı bir
geçici index kullanılıyor). İmajdaki git sürümü: **2.39.5**.

```bash
npm run gate:w6          # 13/13, MODEL İSTEĞİ HARCAMAZ (~3 dk)
npm run gate:w6:agent    # 12/12, canlı diff + inceleme döngüsü; üç turn, kota yer
```

Son ölçüm: satıra yorum bırakıldıktan **13,7 saniye** sonra agent düzeltmeyi yayımladı;
`processOrder` üç fonksiyona bölündü ve yorumun çapası 15. satırdan 53'e **taşındı**
(`moved`), kaybolmadı.

## Yapı

```
apps/
  api/            Hono. POST /rooms, GET events?since=N, stop
  web/            React + Vite iskeleti. Hafta 3: SSE istemcisi, xterm.js
  desktop/        Tauri 2 kabuğu, apps/web ile aynı bileşenler
packages/
  protocol/       Zod event şemaları + host↔runner NDJSON protokolü + tool eşlemesi
  core/           YAML yükleyici, event store, oda düzeni, container, AgentManager
  runner/         Container İÇİNDE koşan süreç: Claude Agent SDK turn döngüsü
  runner-gemini/  Aynı protokol, Gemini CLI ile
  redact/         Secret maskeleme; appendEvent'in geçidi
  view/           Event log → projeksiyon (snapshot, diff, yorum çapaları)
  gitkit/         Checkpoint ve diff. Container İÇİNDE koşar: runner import eder,
                  sunucu `docker exec node /opt/runner/gitkit/dist/gitkit.js` ile
                  çağırır. Tek uygulama, iki giriş noktası.
db/migrations/    Append-only şema
test/fixtures/    Kapı testlerinin örnek projeleri (week6-repo)
rooms/Dockerfile  Oda container imajı
config/           Örnek rol konfigürasyonu
scripts/          migrate, smoke, build-runner, validate-events, sse-probe, week1..week6-gate
docs/             Haftalık kapılar (week-01 … week-06) ve devir notu (DEVAM.md)
```

## İki mimari kural

**1 — Kontrol düzlemi ile sunum düzlemini ayır.** Agent headless / stream-json modunda koşar; tool çağrıları ve dosya değişiklikleri yapılandırılmış JSON olarak gelir. Terminal görünümü bu akışın *render* edilmiş halidir. Hiçbir yerde metin kazıma yok — `packages/protocol` içinde `output.chunk` bu yüzden `PRESENTATION_ONLY` olarak işaretli, kontrol kararları ondan okumaz.

**2 — Sınırlanmış dünyada sınırsız yetki.** Kısıtlar sistem prompt'una yazılmaz; container sınırı, dosya izni ve hook olarak uygulanır. Her agent kendi worktree'sinde tam yetkilidir:

```
/room
├── worktrees/
│   ├── frontend/     branch: room-42/frontend   (tam yetki)
│   ├── backend/      branch: room-42/backend    (tam yetki)
│   └── security/     read-only
├── contracts/        herkese yazılabilir — API sözleşmeleri
└── journal/          oda defteri
```

### Sınırsız yetki neyle sınırlı: oda imajında ne varsa

"Sınırlanmış dünyada sınırsız yetki" cümlesinin ölçülmüş sınırı şu: agent container içinde
her şeyi yapabilir (dosya yaz, komut çalıştır, paket kur) ama **sistem paketi kuramaz** —
root değil, `apt` çalışmaz. Yani `rooms/Dockerfile`'a koymadığımız bir dil, agent için yok.

Gerçekte oldu: agent'a "Django ile blog sitesi yaz" dendi, agent doğru davranıp durdu ve
*"Python yüklü değil, sistem düzeyinde kurulum iznim yok"* dedi. Ekrandaki his "sınırsız
yetki verdim, hâlâ yapamıyor" oldu; oysa sınır yetkide değil kurulumdaydı.

İki taraflı düzeltildi:

1. **İmajda gerçekten var:** Node 22, Python 3 (+ hazır venv `/opt/venv`, PATH'in başında —
   `pip install django` doğrudan çalışıyor; Debian PEP 668 engeli aşılmış oluyor),
   `build-essential`, git, ripgrep, curl.
2. **Agent denemeden biliyor:** runner her başlangıçta bu araçların sürümünü **ölçüp**
   rol bağlamına yazıyor (`node --version` gibi). Elle yazılmış bir liste imajla kayardı;
   ölçüm kayamaz. Eksik olan araç "ortamda YOK" diye yazılıyor, böylece agent olmayan bir
   şeye uydurma yol aramak yerine neyin eksik olduğunu söylüyor.

Not: bu imaj değişikliği **yeni odalar** için geçerli. Var olan bir oda container'ı eski
imajdan yaratıldı; Python'ı görmesi için oda yeniden açılmalı (`npm run room:build` +
yeni oda).

Frontend agent, backend'in yazmakta olduğu koda **yazamaz**. Bu bir kısıt değil, mimarinin amacı: koordinasyon `contracts/` ve defter üzerinden yapılmak *zorunda* kalır. `mountPlan()` bu planı rol YAML'ından üretir ve test ediliyor — **uygulaması Hafta 7'de** (worktree yönetimi ve izinler). Bu hafta klasörler kuruluyor, izin zorlaması henüz yok.

## Kontrol düzlemi nasıl kuruluyor

Agent, host'ta değil **container içinde** koşar: SDK'nın `Bash` ve `Edit` tool'ları sürecin bulunduğu yerde çalışır, host'ta koşsaydı sandbox anlamsızlaşırdı.

```
host                                  container
────────────────────────────────      ──────────────────────────────
apps/api → AgentManager               /opt/runner/dist/runner.js
  ├─ dockerode exec ──────────────▶     ├─ stdin : NDJSON komut
  ├─ stdout satırları ◀───────────      ├─ stdout: NDJSON çıktı
  └─ appendEvent (SIRALI)               └─ Claude Agent SDK query()
```

Aradaki her satır bizim tanımladığımız bir şemadır ve Zod ile doğrulanır — bu **metin kazıma değildir**. Host, agent'ın ürettiği serbest metin üzerinde hiçbir zaman arama veya regex çalıştırmaz.

**Tool yetkisi üç katmanda**, hiçbiri sistem prompt'u değil: SDK `tools` (agent sadece bunları görür), `disallowedTools` (yasaklılar kaldırılır), `PreToolUse` hook'u (her çağrı YAML'a karşı son kez kontrol edilir, reddedilen `tool.denied` olarak log'a düşer).

## Model ve sağlayıcı bağımsızlığı

En iyi model her yıl değişiyor. Odanın değeri modelde değil, agent'ların okuyup yazdığı paylaşılan bağlamda — bu yüzden koşum ortamı değiştirilebilir.

**Model seçimi** rol YAML'ında agent başına (`model`), `AGENT_MODEL` ile global olarak ezilebilir.

**Sağlayıcı seçimi** ortam değişkeniyle; aynı modeller, farklı arka uç:

```bash
CLAUDE_CODE_USE_BEDROCK=1   # + AWS_REGION, AWS_ACCESS_KEY_ID, ...
CLAUDE_CODE_USE_VERTEX=1    # + ANTHROPIC_VERTEX_PROJECT_ID, GOOGLE_APPLICATION_CREDENTIALS
ANTHROPIC_BASE_URL=...      # + ANTHROPIC_AUTH_TOKEN  (kurumsal gateway)
```

Sağlayıcı seçiliyse `ANTHROPIC_API_KEY` gerekmez. `AWS_*` / `GOOGLE_*` değişkenleri container'a olduğu gibi geçer — SDK'nın bağlanabilmesi için başka yolu yok; Hafta 4'teki redaction bunları stream'e sızdırmamakla yükümlü.

**Farklı bir agent CLI'ı** (Codex, Gemini gibi) rol YAML'ındaki `runtime` alanıyla seçilecek. Bugün tek değer var: `claude`. Bu dikiş mimariyi değiştirmiyor — runner zaten container içinde ayrı bir süreç ve host ile arasındaki tek bağ NDJSON; host hangi binary'nin koştuğunu bilmiyor. Yeni bir koşum ortamının sağlaması gereken sözleşme `packages/protocol/src/runtime.ts` başında yazılı:

1. **Yapılandırılmış akış** — sadece insan için biçimlenmiş metin veren bir CLI kabul edilemez ("metin kazıma yok")
2. **Tool kapısı** — tool çalışmadan önce araya girilebilmeli ki YAML'daki yetki zorlanabilsin
3. **Oturum sürekliliği** — çökme sonrası sohbet sürsün
4. **NDJSON** — kendi akışını bizim event kataloğumuza çevirir

Katalog zaten sağlayıcı-bağımsız: `tool.call`, `tool.result`, `turn.completed` hiçbir yerde "Claude" demiyor.

**İki koşum ortamı yan yana çalışıyor.** Rol YAML'ında `runtime: claude` veya `runtime: gemini`:

| | Claude (Agent SDK) | Gemini (CLI) |
| --- | --- | --- |
| Yapılandırılmış akış | ✅ stream-json | ✅ stream-json |
| Tool kapısı | ✅ `PreToolUse` hook'u **engeller** | ⚠️ `--allowed-tools` kısıtlar; ihlal **saptanır**, engellenmez |
| Oturum sürekliliği | ✅ `resume` | ✅ `--session-id` / `--resume` |
| Rol prompt'u | ✅ `systemPrompt.append` | ✅ çalışma alanına yazılan `GEMINI.md` (CLI'da bayrak yok) |
| Tool çıktısının metni | ✅ | ❌ sadece `status` |
| USD maliyet | ✅ | ❌ sadece token sayısı |
| SDK tool listesi | ✅ `turn.started.tools` | ❌ boş |

Ölçüm ayrıntıları ve entegrasyonda çıkan hatalar: `docs/runtime-gemini.md`.

Anahtarlar bağımsız: `ANTHROPIC_API_KEY` yokken Gemini agent'ları çalışır, tersi de geçerli. Her koşum ortamı yalnızca kendi anahtarını görür.

**Rol bağlamı iki yoldan gidiyor ve ikisi birbirinin yedeği.** Claude tarafında rol
YAML'ındaki `systemPrompt` + çok kişili oda notu SDK'nın sistem prompt'una eklenir. Gemini
CLI'da sistem prompt'u veren bir bayrak yok; runner her başlangıçta agent'ın çalışma alanına
`GEMINI.md` yazar (rol prompt'u + aynı çok kişili not + bir kurulum doğrulama satırı) ve CLI
onu bağlam olarak okur. Dosya her başlangıçta üzerine yazılır: tek kaynak rol YAML'ı.

Doğrulama tahmine bırakılmadı: dosyada *"oda kurulumu dogru mu"* sorusuna
`ODA-KURULUMU-OK <rol>` cevabı bağlı ve `gate:w5:agent` hem dosyanın diskte olduğunu hem
modelin o satırı yazdığını ölçüyor. Bu sayede **Claude anahtarı beklemeden rol sistemi
doğrulanabiliyor**.

## Event log

Her şey append-only; UI bunun projeksiyonudur. `session_events` üzerinde UPDATE ve DELETE veritabanı trigger'ı ile engellidir. `seq`, oturum başına `sessions.next_seq` satır kilidi üzerinden dağıtılır — iki paralel yazıcı asla aynı sırayı alamaz; `(session_id, seq)` unique index son savunma hattıdır.

Yeni bir durum eklemenin yolu yeni bir event tipi eklemektir, mevcut bir kaydı değiştirmek değil.

## Agent sayısı hiçbir yerde sabit değil

Roller `config/room.example.yaml` içinde bir dizidir. Kod her yerde bu diziyi dolaşır, UI `agents.map()` yapar, defter referansları isimle verilir. Üçüncü agent eklemek tek bir YAML bloğu olmalı — `roomConfig.test.ts` bunu test ediyor.

Hafta 3'te bir kez elle de denendi: YAML'a üçüncü bir `docs` agent'ı eklendi, hiçbir koda
dokunulmadan arayüzde kendiliğinden üçüncü satır çıktı (`GET /rooms/:id/agents` üç agent
döndü, sol çubuk üçünü de çizdi). Kontrolden sonra geçici YAML silindi.

## Yol haritası

12 haftalık plan `docs/roadmap.md` içinde. Hafta 8 sonundaki kapı gerçek bir durak noktasıdır: *backend agent bir mimari karar alır, deftere yazar, frontend agent turn'üne başlarken onu okur ve sözleşmeye uygun kodu yazar — aralarında hiç mesaj geçmeden.* Bu çalışmadan 3. ve 4. agent eklemek sadece hatayı büyütür.

### Hafta 5

| Karar | Gerekçe |
| --- | --- |
| Kuyruk DB'de, bellekte değil | Bellekteki bir dizi ikinci kullanıcıya görünmez ve çökmede uçar. Sunucu yeniden başlayınca bekleyen mesajlar kaybolmamalı ve kuyruk herkese aynı görünmeli. |
| Tek koşan garantisi ÜÇ katman | Promise zinciri ve `SKIP LOCKED` kodun dikkatine dayanır; `agent_queue_single_running` kısmi unique index'i dayanmaz. İkisi birbirinin yedeği: biri kodda gözden kaçan yarışı, diğeri son hatayı yakalar. Testte bir kez ihlal denenip reddedildiği doğrulandı. |
| FIFO `enqueued_at` DEĞİL artan sayaç (`ord`) | 10 paralel `enqueue` ile koşan birim test sırayı bozuk buldu: iki satır aynı mikrosaniyeye düşünce sıra rastgele UUID'ye kalıyordu. Elle yazan iki kişide bu yarış neredeyse hiç görünmez — tahminle yazılsa fark edilmezdi. |
| Mesajlar birleştirilmiyor | A ve B arka arkaya yazdığında "ikisini tek prompt'ta gönderelim" cazip. Agent kime cevap verdiğini kaybeder ve iki yönerge tek turn'de karışır. Her mesaj kendi turn'ünü alır. |
| Doğrudan `sendMessage` yolu kaldırıldı | İki giriş kapısı olsaydı "agent başına tek koşan mesaj" garantisi ikisinin arasından sızardı. Yazmanın tek kapısı kuyruk. |
| `[İsim]: ` öneki runner'a verilirken ekleniyor | Event log kullanıcının YAZDIĞINI saklar. Öneki log'a yazmak, kullanıcının yazmadığı bir metni ona ait göstermek olurdu. |
| Kesme `abortController` ile, streaming input'a geçilmedi | Görev tanımı bu yolu açıkça izin veriyor. Kuyruk + kesme + kapı aynı hafta değişirken bir de runner'ın çalışma modelini değiştirmek, düşen bir kontrolün sebebini iki değişiklik arasında aramak demekti. Davranış aynı, kesme yalnızca daha sert (`mode: "abort"`); `graceful` streaming input'a geçince gelir. |
| Kesme iki event | `interrupt.requested` ile `interrupt.applied` arasındaki süre sıfır değil. Tek event yazmak "durdu" demek olurdu; agent uzun bir bash komutunun ortasında durmuyor ve UI o aralığı göstermek zorunda. |
| `message.cancelled.by` nullable yapıldı | Görev tanımında zorunlu bir kullanıcıydı ama aynı event'in sebepleri arasında `server_restart` ve `agent_failed` var — o iptalleri bir insan yapmıyor. Kaydın sahibini "iptal eden" diye yazmak log'u yalancı yapardı. |
| `driver.changed` ve `agent.interrupted` kaldırıldı | Hiç yazılmamış iki event, bu haftanın beş event'iyle örtüşüyordu. Üst üste binen event tipi, ileride yanlışını yazmak için duran bir tuzaktır. |
| Sürücülük bir rol, kilit değil | Sürücülüğü kilit yapmak, odaya ikinci kişiyi sokmanın anlamını yok ederdi. Sürücü olmayan yazar, kuyruğa girer; sadece kesemez. |
| Sürücülük presence kaybından 60 sn sonra düşüyor | Anında düşürmek her F5'te sürücülüğü elinden alırdı. Presence geri gelirse sayaç sıfırlanıyor. |
| Kapı gerçek agent'sız koşuyor (`AGENT_FAKE_RUNTIME=1`) | Ölçülen şey model çıktısı değil SIRALAMA. Sahte runner'la yarış penceresi gerçeğinden geniş, kapı ücretsiz ve deterministik. Üretimde kurulamaz ve sunucu açılışta "koşum ortamı SAHTE" yazar: sessizce sahte cevap veren bir sunucu, hiç cevap vermeyenden kötüdür. Modelin etiketi okuması ve gerçekten koşan bir işin kesilmesi ayrı kapıda. |
| Örnekleme Postgres'in içinde (`\watch`) | İlk hâl her örnek için yeni bir `docker compose exec` açıyordu: örnek başına ~1,5 sn, 3 saniyelik koşumda 3 örnek. "İki `running` satır yok" iddiasını 3 örnekle kanıtlamak ölçmemekle neredeyse aynı şey. |
| Gemini'de rol bağlamı `GEMINI.md` ile gidiyor | CLI'da sistem prompt'u bayrağı yok. Kullanıcı mesajının içine gizlice not eklemek event log'da görünmeyen bir davranış yaratırdı; bağlam dosyası diskte duruyor, okunabiliyor ve kapı hem dosyayı hem modelin onu okuduğunu ölçüyor. Rol sistemi böylece Claude anahtarı beklemeden doğrulanıyor. |
| Kurulum doğrulaması serbest metinle değil SABİT bir satırla | "Model rolünü biliyor mu" sorusunu cevabın üslubundan okumak güvenilmez: bilgiyi dosyadan mı mesajdan mı aldığı belirsiz kalır. Dosyada belirli bir soruya belirli bir cevap bağlı ve o cevabın tek kaynağı dosya. |
| E-posta gönderimi yokken `/auth/request` artık `503` | Eskiden `{ ok: true }` dönüyordu ve ekran "bağlantı gönderdik" yazıyordu: gönderici hiç kurulmadığı için giriş imkânsızdı ve arayüz kullanıcıya yalan söylüyordu (elle test ederken gerçekten oldu). "Yapamıyorum" demek doğrusu. |
| Eksik sürücü satırı kendini onarıyor | Hafta 5'ten önce açılmış odalarda `agent_driver` satırı yok ve sürücü uçları "agent bulunamadı" diyordu — oysa agent orada. Migration mevcut odaları dolduruyor; kod eksik satırı rol YAML'ından yeniden yazıyor. Eksik bir projeksiyon satırı, kullanıcıya olmayan bir sorun göstermemeli. |
| 4xx'ler sunucu loguna yazılıyor (üretim dışında) | "403 alıyorum" hangi uç olduğunu söylemiyor. Sunucunun bildiği bir şeyi kullanıcıya tarayıcı ağ sekmesinde aratmak yanlış. |

### Hafta 6

| Karar | Gerekçe |
| --- | --- |
| Git agent'ın deposunda YALNIZCA container içinde çalışıyor | Agent workspace'e `.git/hooks/post-commit` veya `core.fsmonitor = touch /tmp/pwned` yazabilir. Host orada `git` çalıştırsaydı agent'ın yazdığı kod host'un yetkileriyle çalışırdı. Kural bir güvenlik kuralıdır: "host'ta çalıştırmak daha kolay olurdu" gerekçe değil. Kapı bunu hem statik (`execFile("git"` araması) hem de ekilmiş hook'la ölçüyor. |
| Checkpoint ayrı bir index dosyasıyla alınıyor | Agent'ın `.git/index`'ini kullanmak, agent bir `git add` yapmışken onun kurduğu durumu bozardı. `.git/rooms-index` kalıcı tutuluyor (her seferinde silinse sonraki `add -A` tüm depoyu yeniden hash'lerdi) ve checkpoint HEAD'e, branch'e, çalışma ağacına dokunmuyor. |
| Taban runner'da değil SUNUCUDA alınıyor | Runner kendi tabanını üretseydi agent her yeniden başlatıldığında taban kayar ve önceki turn'lerin değişiklikleri sessizce kaybolurdu. Taban bir kez alınır, `agent_runtime.diff_base_checkpoint_id`'de durur. |
| Taban alınamazsa agent YİNE başlıyor | Diff bir sunum katmanı, agent'ın çalışmasının önkoşulu değil. Diff yayımlanmaz ve sebep log'a yazılır; agent'ı diff yüzünden başlatmamak orantısız olurdu. |
| Hook diff HESAPLAMIYOR, sadece bayrak kaldırıyor | Her `Edit` çağrısında tam bir `git add -A` + diff koşturmak on dosyaya dokunan turn'de agent'ı bekletir. Hesap 300 ms debounce'lu bir işe düşüyor; turn sonunda `flush` BEKLENİYOR ki "bu diff hangi turn'ün işi" sorusu cevapsız kalmasın. |
| Yorum çapası numara + METİN | Agent araya üç satır eklerse 42 artık başka bir satırdır; yalnızca numaraya güvenmek yorumu sessizce yanlış yere taşır. Metin birden çok kez geçiyorsa `outdated` sayılıyor: iki adaydan birini seçmek yanlış satıra yapışmanın kibar hâli olurdu. |
| İnceleme metni SUNUCUDA kuruluyor | İstemci hazır prompt gönderseydi "agent'a ne söylendiği" tarayıcının insafına kalırdı ve event log'daki `message.received.text` ile gerçekte gönderilen ayrışabilirdi. |
| İnceleme ayrı bir yol değil, Hafta 5'in KUYRUĞU | `agent_queue.kind` alanı eklendi. İkinci bir giriş kapısı açmak "agent başına tek koşan" garantisini ikisinin arasından sızdırırdı. |
| Yorumu agent KAPATAMAZ | Durum bir insan kararı. Agent "uyguladım" diyebilir; uygulayıp uygulamadığına bakan kişi kapatır. Otomatik çözme, okunmamış bir düzeltmeyi çözülmüş göstermenin yoludur. |
| İsteğe bağlı diff event log'a YAZILMIYOR | "Ayşe'nin 14:02 checkpoint'inden beri" kullanıcıya özel bir görünüm, herkesin durumu değil. Event log herkesin gördüğü şeydir; kişisel bir sorgu oraya girmemeli. Sonuç 30 sn önbellekleniyor ve anahtarda ağaç sha'sı var — yoksa önbellek bayat bir diff dönerdi. |
| Kapı İKİYE bölündü | Canlı `diff.updated` modelsiz ölçülemez: diff'i runner yayımlıyor ve tetiği bir tool çağrısı. `gate:w6` (13 kontrol) hiç model isteği harcamıyor — gerçek container, gerçek git, gerçek gitkit, dosyalar `docker exec` ile değişiyor. Gerçekten modele bağlı olanlar (canlı yayım, artımlı filtre, yorumdan düzeltmeye SÜRE) `gate:w6:agent` içinde ve anahtar yoksa atlıyor. |
| Kapı git'i ürünle AYNI bayraklarla okuyor | İlk koşumda kontrol 1 "dubious ownership" ile düştü: workspace bind mount üzerinden geliyor, uid eşleşmiyor ve gitkit zaten `safe.directory=*` ile çağırıyordu. Kapının okuması üründen farklı bir koşulda olsaydı, ölçtüğü şey ürünün davranışı olmazdı. |

### Hafta 6 sonrası — anahtar, sağlayıcı ve yetki

| Karar | Gerekçe |
| --- | --- |
| Kimlik doğrulaması agent BAŞLATILMADAN kontrol ediliyor | Gemini anahtarı tanımlıyken Claude runtime'lı bir agent başlatılabiliyordu: yönetici kuruluydu, container açıldı, runner kalktı ve hata ancak container İÇİNDE oluştu ("Not logged in · Please run /login"). SDK bunu normal metin olarak döndürdüğü için turn `completed` yazıldı ve ekranda YEŞİL bir "tamamlandı" göründü — sıfır token, 52 ms. Yapılandırma eksikliği bir sonuç değil önkoşuldur. |
| Anahtar eksikliği `503`, container sorunu `409` | İkisine aynı kodu döndürmek, arayüzün anahtar eksikliğinde de "odayı yeniden aç" demesi demekti. |
| Her koşum ortamı yalnızca KENDİ anahtarına bakar | Claude anahtarının varlığı bir Gemini agent'ını başlatmak için gerekçe değil. Sağlayıcı arka uçlarında (Bedrock/Vertex/gateway) anahtar ARANMAZ; orada kimlik dışarıdan gelir ve anahtar istemek çalışan bir kurulumu kırardı. |
| Durmuş container KENDİLİĞİNDEN başlatılmıyor | O container eski imajdan yaratılmış olabilir; bayat imajla agent `stopped`da kalıp "protokol sürümü uyuşmuyor" yazar. Sessizce ayağa kaldırmak, sebebi görünmeyen ikinci bir hata üretirdi. Bunun yerine insan diliyle "oda kapandı, yeni oda aç" deniyor. |
| `AGENT_MODEL` koşum ortamına özel hâle geldi | Tek değer iki koşum ortamına da gidiyordu: odada bir Gemini bir Claude agent'ı varken `AGENT_MODEL=gemini-3.1-flash-lite` Claude agent'ına da gidiyordu. `AGENT_MODEL_CLAUDE` / `AGENT_MODEL_GEMINI` eklendi, global olan yedek kaldı (kapılar onu kullanıyor). |
| Yetki istekleri ayrı tabloda DEĞİL, event log'da | Rol değişikliğinin gerekçesi de odanın tarihidir. Ayrı tablo "tabloda bekliyor ama log'da çözülmüş" çelişkisini mümkün kılardı. |
| Kabulde rol ÖNCE değişiyor, event SONRA yazılıyor | Event "oldu" demektir, "olacak" demek değil. Ters sırada bir hata, log'da olmuş görünen ama gerçekleşmemiş bir yetki bırakırdı. |
| Kapı durumu `/snapshot`'tan değil CANLI görünümden okuyor | O uç saklanan snapshot'ı döndürüyor ve event log'un gerisinde olabilir. Bir kapı koşumunda yorum seq 48'de yazıldı, snapshot seq 34'te kaldı ve kapı "projeksiyonda yorum yok" dedi — ürün doğruydu. `scripts/room-view.mjs` snapshot + sonraki event'leri projeksiyondan geçiriyor: tarayıcının yaptığının aynısı. |
| Çapa kontrolü sabit beklentiden çıkarıldı | "Yorum `current` kalırsa başarısız" ölçütü, agent'ın satırı kaydırmasını varsayıyor; gerçek modelde bu bir şans işi. Ölçülen şey artık projeksiyonun çapa kuralının patch'in gerçeğiyle aynı sonucu verip vermediği. |

## Ölçülecek tek metrik

**Aynı oturuma iki farklı insanın yazdığı oturum sayısı, haftalık.** Kurulum sayısı değil, star sayısı değil.

## Hafta 3 dogfood notları

18 Eylül 2026 · gerçek bir iş, **ekrandan** izlendi (psql'den değil) · koşum ortamı
**Gemini** (Claude anahtarı yok) · oda `3437e583`.

Kendi FastAPI projem (`main.py`, `models.py`, `database.py` — 118 satır, secret yok)
worktree'ye kopyalandı ve gerçekten ihtiyacım olan iş verildi: *"sadece POST uçları var;
GET listeleme uçlarını ekle, randevu açarken `pet_id` yoksa 404 dön."* Agent 52,9 sn'de
bitirdi, `main.py` doğru değişti (üç GET ucu + 404 kontrolü). Ardından ikinci bir görevle
kabuk yolu da denendi (`wc -l`, 11,2 sn).

**Neyi görmek için Terminal sekmesine geçmek zorunda kaldın?**
Hiçbir şeyi — ve sorun tam olarak bu. Bu koşum ortamında Terminal sekmesi etkinlik
akışından **daha boş**: `$ wc -l /room/worktrees/backend/*.py` satırı var, çıktısı yok
(Gemini `tool_result` metnini vermiyor, sadece `status`). Satır sayılarını agent'ın düz
metin cevabından okudum. Yani Terminal şu an Claude koşum ortamı için hazır bir görünüm;
Gemini'de bilgi taşımıyor. **Hafta 6-7 için:** sekme, koşum ortamı çıktı vermiyorsa
kendini gizlemeli veya nedenini söylemeli; kullanıcıyı boş bir panele göndermemeli.

**Hangi bilgiyi ekranda bulamayıp DB'ye (dosyaya) baktın?**
`replace` satırı "worktrees/backend/main.py · 1 dosya" diyor; **ne değiştiğini**
söylemiyor. Değişikliğin doğruluğunu ekrandan doğrulayamadım, host'ta `diff` çektim.
Agent'ın kendi özeti tek kanıttı ve onu doğrulayacak yer ekranda yok. Diff görünümü
zaten Hafta 6'da — bu dogfood onun en çok istenen şey olduğunu doğruluyor. İkinci eksik:
turn başlığında **saat yok**, sadece süre var; "bu ne zaman oldu" sorusu ekrandan
cevaplanamıyor.

**5 dakika sonra ekranda gürültü olmaya başlayan ne vardı?**
1. **`update_topic` satırları.** Gemini'nin iç defter tutma tool'u; 7 satırlık turn'ün
   3'ü bu (yaklaşık %43) ve özet sütunu `Object.keys(input)`'ten ibaret:
   `title, summary, strategic_intent`. Kullanıcıya hiçbir şey anlatmıyor.
   **Hafta 6-7:** koşum ortamına özgü "iç" tool'lar varsayılan olarak katlanmalı.
2. **Agent'ın son metni ham markdown.** `###`, `**`, ``` ``` ``` işaretleri tek bir
   paragraf bloğu olarak düşüyor; cevap uzadıkça okunaksızlaşıyor.
3. **Her satır aynı görsel ağırlıkta.** Dosyayı *okumak* ile dosyayı *değiştirmek*
   aynı boyda: gözün "burada bir şey değişti" diye takılacağı yer yok.

## Hafta 4 dogfood notları

18 Eylül 2026 · **iki kişi, iki ayrı makine**, aynı yerel ağ üzerinden
(`http://<lan-ip>:5173`). İkinci kişi hiçbir kurulum yapmadan davet linkine tıkladı,
odaya izleyici olarak girdi ve agent'ın çalışmasını canlı izledi. Turn gerçek bir dosya
yazdı (`hello.js`), ikisi de aynı anda gördü, presence iki kişiyi de gösterdi.

**Karşı taraf ekrana bakınca ilk 10 saniyede neyi anlamadı?**
İki şey, ikisi de "ne olduğunu söylemeyen durum" ailesinden:

1. **Başarılı bir girişten sonra ekranda duran yanlış hata:** *"Sunucuya ulaşılamadı —
   `npm run api` çalışıyor mu?"* Sunucu çalışıyordu, giriş de başarılıydı. Sebebi iki hatanın
   üst üste binmesiydi (StrictMode açılış effect'i iki kez koşuyor + magic link tek
   kullanımlık + oda listesi HER hatayı "sunucu kapalı" diye gösteriyor). İkisi de
   düzeltildi. Kaydedilmeye değer yanı: o sırada 194 test ve üç kapı script'i geçiyordu;
   hiçbiri bunu yakalamadı, çünkü hepsi "giriş başarılı mı" diye soruyordu, **hiçbiri
   ekranda ne yazdığına bakmıyordu.**
2. **`● bitti · error · 0 ms`** — turn neden bittiğini söylemiyor. Sebep (Gemini günlük
   kotası, `429`) yalnızca sunucu logunda. Ekran event log'un projeksiyonu olduğu için
   asıl eksik log'da: Gemini runner'ı `result` satırındaki `status`'u yazıyor ama hata
   metnini taşımıyor. **Hafta 5/6'nın işi:** turn sonucuna sebep alanı eklemek.

**Hangi anda "şunu ben yazayım" dedi?**
İzleyici ekranını görür görmez, daha bir şey denemeden: *"şu an sanırım izleyiciye
müdahale etme yetkisini vermiyoruz."* Hafta 5'in (yazma yetkisi, kuyruk, sürücü devri)
gerekçesi olarak bundan iyisi yok. İzleyicinin gördüğü "Bu odayı izliyorsun" satırı **ne
olduğunu** söylüyor ama **ne zaman değişeceğini** söylemiyor; oraya "yetki iste" eylemi
girmeli.

**Redaction bir şeyi gereksiz yere maskeledi mi?**
Hayır. Ekranda `scripts/demo-redaction.mjs` ile denendi: `.env` değerleri maskelendi,
yanındaki git sha, UUID, uzun `node_modules` yolu ve semver dokunulmadan kaldı. Bir kusur
çıktı ama maskelemede değil, **isimlendirmede**: AWS anahtarı `env-assignment` diye
işaretleniyordu. Denetim kaydında "bir env değeri sızmış" ile "bir AWS anahtarı sızmış"
arasında dağlar kadar fark var; artık aynı aralığı iki kural yakalarsa spesifik olan
isim veriyor.

### Dogfood'un asıl bulduğu şey: tünel seçimi bir mimari karar

İlk deneme **Cloudflare hızlı tüneli** (`trycloudflare.com`) ile yapıldı ve izleyici odayı
görüyor ama **hiçbir canlı güncelleme almıyordu** — presence yok, yeni event yok. Ölçüm:

| Yol | SSE frame'leri |
| --- | --- |
| Doğrudan API (`:8787`) | akıyor |
| Vite vekili (`localhost:5173`) | akıyor |
| Cloudflare hızlı tünel | **25 saniyede tek byte yok** |
| Cloudflare, `--protocol http2 --no-chunked-encoding` | yine yok |
| Yerel ağ (`<lan-ip>:5173`) | akıyor |

Yani sunucu doğru gönderiyordu, tünel tamponluyordu. **Olay akışı tabanlı bir arayüz,
yanıtı tamponlayan hiçbir vekilin arkasında çalışmaz** — ve bu, kapı testleriyle
görülemeyecek bir şeydi: kapılar hep aynı makinede koşuyor. Uzak erişim gerektiğinde
akışı geçiren bir tünel (ngrok gibi) ya da doğrudan ağ yolu kullanılmalı.

## Hafta 5 dogfood notları

**20 Eylül 2026, 20:04–20:09.** İki kişi (`kerem`, `deneme50`), iki ayrı cihaz, aynı yerel
ağ, tek agent (`backend`, Gemini, `gemini-3.1-flash-lite`). 7 mesaj, 6 turn tamamlandı,
1 turn kesildi. Aşağıdaki sayılar histen değil **event log'dan** çıkarıldı.

| Ölçüm | Sonuç |
| --- | --- |
| Kesme gecikmesi | `interrupt.requested` → `interrupt.applied` **109 ms**, `mode: abort` |
| Kesilen turn | `turn.failed · reason: "interrupted"`, mesaj **yeniden koşmadı** |
| Kesen kişi | `deneme50` — devrettikten sonraki sürücü |
| Sürücülük | ilk mesajla otomatik claim (34 ms) → `handed_off` → `released(manual)` → yeni sürücü `claimed` |
| Eşzamanlı yazma | koşan turn sırasında gelen mesaj, önceki `turn.completed`'dan **59 ms sonra** alındı |
| Kuyrukta bekleme | **10,8 saniye** — sıra bozulmadı, mesaj kaybolmadı |
| Örtüşme | sıfır: hiçbir anda iki `running` satır yok |

Dört sorunun cevabı — **hiçbirinde sorun çıkmadı**, ürün beklendiği gibi davrandı:

1. **Kesmek istediğinde kaç saniye bekledin, sinir bozucu muydu?** Bekleme hissedilmedi.
   Ölçüm 109 ms; "kesme kuyruğa alındı" ara durumu pratikte görülmeden turn kapandı. Kapıdaki
   1 sn altı ölçümü gerçek kullanımda da tuttu.
2. **Kuyrukta beklerken ne bilmek istedin de ekranda yoktu?** Eksik bir şey rapor edilmedi;
   10,8 saniyelik bekleme sırasında kuyruk görünümü yeterli geldi.
3. **Agent iki kişiye birden cevap verirken karıştı mı?** Karışmadı. İki kişi arka arkaya
   birbirinin işine dokunan mesajlar yazdı (`"Yazılan ts dosyasını sil"`,
   `"bubble sort dosyasını sil"`) ve agent doğru dosyayı hedefledi.
4. **Sürücülüğü devretmek gerçekten 2 tık mıydı?** Evet. Devir, bırakma ve yeniden alma
   olayları 6 saniyelik bir aralıkta art arda yazıldı.

Kesmenin ölçülmüş geçmişi de burada duruyor: `gate:w5:agent` ilk koşumda kesmenin
`sleep 120` koşan bir Gemini agent'ında **32 saniye** sürdüğünü ve `hard_kill` ile bittiğini
gösterdi — SIGTERM, CLI'nın başlattığı kabuk komutunu durdurmuyordu. Süreç artık kendi
grubunda başlatılıyor ve sinyal gruba gidiyor; aynı ölçüm **1 saniyenin altına** indi
(`mode: abort`). Sahte koşum ortamıyla bulunamayacak bir hataydı: sahte runner'ın çocuk
süreci yok.

### Dogfood'dan önce çıkan bir şey: durmuş oda container'ı

Dogfood'a girerken dünkü oda açılmak istendi ve arayüz şunu gösterdi:

```
container'a bağlanılamadı: Error: (HTTP code 409) container stopped/paused —
container b1b953eb5428... is not running
```

Docker yeniden başlatıldığında oda container'ları `Exited` kalıyor; sunucu container'ın
**var ama durmuş** olduğunu biliyor ve kullanıcıya ham Docker hatasını veriyor. Kullanıcının
bilmesi gereken şey "oda kapandı, yeni oda aç" ya da container'ın kendiliğinden kaldırılması.
Dogfood yeni odada yapıldı; bu madde **Hafta 6'ya borç** olarak taşındı.

## Hafta 6 dogfood notları

22 Eylül, iki hesap (`deneme201` owner, `deneme50` member), Gemini
`gemini-3.1-flash-lite`, gerçek iş: sıfırdan bir `index.html`. Sayılar event
log'dan ölçüldü, gözle değil.

| Soru | Cevap | Kanıt |
| --- | --- | --- |
| Yorumdan düzeltmeye kaç sn? | **32 sn** | `review.submitted` 13:44:18 → `file.changed` 13:44:50 |
| Kaç yorum yanlış satıra uygulandı? | **0** | çapa `index.html:5`, `lineText` = `<title>Merhaba</title>` — doğru satır |
| "Eskimiş" işareti doğru muydu? | **ölçülmedi** | yorum 13:44:25'te elle çözüldü, düzeltme 13:44:50'de geldi; `outdated` durumu hiç tetiklenmedi |
| Composer'a dönmek zorunda kalındı mı? | **evet, 1 kez** | son istek (13:46:31, "buton ekle") diff'ten değil composer'dan gitti |

**32 saniye, 30 sn uyarı eşiğinin hemen üstünde** — kapıda (`gate:w6:agent`) aynı ölçüm
13,7 sn idi. Fark ürünün yavaşlaması değil: agent düzeltmeden önce Gemini CLI'nin kendi
`update_topic` defter tutma tool'unu çağırdı (13:44:32) ve 18 saniyeyi ona harcadı. Yani
aradaki fark modelin araya soktuğu bir tur, bizim kod yolumuz değil.

**Dogfood'un asıl kanıtladığı şey — agent kime cevap verdiğini biliyor.** Yorumu
`deneme50` yazdı, sürücü `deneme201` idi. Agent cevabını `[deneme50]: Yorumunla ilgili
açıklamam...` diye **yorumu yazana** adresledi, sürücüye değil. Hafta 5'in çok kişili
bağlam iddiası ilk kez iki gerçek insanla doğrulandı.

**İkinci gözlem: agent yorumu körü körüne uygulamadı.** Yorum `<title>Merhaba</title>`
satırına "bunu yuvarlak kırmızı bir div'in içine yaz" diyordu. Agent `<title>`in `<head>`
içinde olduğunu ve yalnızca metin taşıyabileceğini açıklayıp itiraz etti, sonra isteneni
gövdede yaptı. Çapa doğruydu; yanlış olan insanın seçtiği satırdı. İnceleme akışının
"agent'a emir değil bağlam veriyoruz" tasarımı burada işe yaradı.

**Açık kalan:** `outdated` çapa durumu dogfood'da tetiklenmedi. Kapıda 12/12 yeşil
(`gate:w6:agent`), yani mekanizma ölçülü; eksik olan iki insanla tekrarı. Hafta 7
dogfood'unda tekrar denenecek.

### Bir bulgu: `GEMINI.md` diff'te agent'ın değişikliği gibi görünüyor

İlk `diff.updated` event'inde (seq 15) dosya listesi `GEMINI.md, index.html` idi. `GEMINI.md`
runner'ın her başlangıçta workspace'e yazdığı rol bağlamı dosyası — altyapı, agent'ın işi
değil. Taban checkpoint'i runner başlamadan önce alındığı için dosya "agent ekledi" gibi
görünüyor. Artımlı filtre doğru çalışıyor (sonraki iki diff'te yok) ama ilk diff'i
kirletiyor. Çözüm yeri: `.git/info/exclude` ya da diff'in yok sayma listesi — Hafta 7'de
`contracts/` takibiyle birlikte ele alınacak.

### Gemini 503 — kota değil, geçici yük

Dogfood sırasında runner `503 "This model is currently experiencing high demand"` aldı ve
kendi backoff'uyla toparladı; turn düşmedi. `429` (kota) ile karıştırılmamalı: 429 günlük
hakkın bitmesi, 503 geçici. `summarizeGeminiError` ikisini de sebebi başa alarak gösteriyor.

## Karar notları

Hafta 1 görev tanımından bilinçli olarak ayrılan noktalar ve gerekçeleri.

| Karar | Gerekçe |
| --- | --- |
| npm workspaces (pnpm değil) | Mimariye etkisi yok; pnpm makinede kurulu değildi. Değiştirmek kod değil araç değişikliği olurdu. |
| `tsc -b` build adımı (`tsx` değil) | Hafta 12'nin "npx ile ayağa kalkan CLI" maddesi derlenmiş çıktı istiyor. tsx şimdi kolaylık sağlar, o hafta yine build eklemek gerekirdi. |
| `pg` (porsager `postgres` değil) | Ergonomi farkı, mimari fark değil. Pub/sub yol haritasında Redis'e verilmiş, yani `LISTEN/NOTIFY` bağımlılığı yok. |
| `dockerode` (docker CLI değil) | **Görev tanımına dönüldü.** Hafta 2-3 agent çıktısını uzun ömürlü exec stream'i olarak okuyacak, Hafta 11 container istatistiği isteyecek. İkisi de kütüphane üzerinden nesne/stream veriyor; CLI tarafında metin ayrıştırması olurdu — "metin kazıma yok" kuralı tam da bunun için var. |
| Postgres 5433, db `agent_rooms` | Makinede lokal Postgres varsa 5432 çakışır. |
| `apps/api` (`apps/server` değil), `@agent-rooms/*` | Sadece isimlendirme; proje kendi içinde tutarlı. |
| Event kataloğu 22 tip | Yol haritasının ileri haftaları (diff, yorum, defter, onay, presence) bu tipleri gerektiriyor. Katalog planın veri modeli hâli; boş tipler bugün kod gerektirmiyor. |
| `actor` düz metin değil, ayrık birleşim | Hafta 5'teki `[Ali]: ...` etiketi ve sürücü devri için insan/agent/sistem ayrımı tipte lazım. |
| POSIX agent izolasyonu **geri alındı** | Yazılmış ve çalışıyordu, ama hem yol haritası hem görev tanımı bunu **Hafta 7'ye** koyuyor. Kapsam dışıydı; Hafta 7'de yeniden yazılacak. |

### Hafta 2

| Karar | Gerekçe |
| --- | --- |
| SDK `0.3.274` tam sabitlendi | Görev tanımının istediği her seçenek (`tools`, `allowedTools`, `disallowedTools`, `permissionPrompts`, `systemPrompt` preset+append, `resume`, `settingSources`, `maxTurns`, `maxBudgetUsd`, `abortController`, `hooks`) kurulu sürümde birebir var — **tek sapma yok**. `permissionPrompts: 'none'` mevcut olduğu için dokümanın önerdiği `canUseTool` yedek planı gerekmedi. |
| `mapMessage` bilinmeyen mesaj tiplerini sessizce atlar | Kurulu SDK'da `SDKMessage` 4 değil **~38 üyeli** bir birleşim. Doküman 4'ünü anlatıyor; geri kalanı bizi ilgilendirmiyor, hata değil. |
| `Options.env` HİÇ set edilmiyor | Kurulu sürümün tipinde yazıyor: verilirse alt süreç ortamını birleştirmez, **tamamen değiştirir**. Set etseydik `PATH` ve `ANTHROPIC_API_KEY` kaybolurdu. |
| `NewRoomEvent` dağıtımlı Omit ile tanımlandı | Düz `Omit<Union, K>` birleşimi çökertiyor ve `type` üzerinden daraltma çalışmıyordu; `e.type === "tool.call" && e.payload.tool` derlenmiyordu. Runner testlerini typecheck'e dahil edince ortaya çıktı. |
| DoD'un `grep "query("` kontrolü uyarlandı | Bizim yığınımızda `pg` var, `pool.query(` ve `c.req.query(` yanlış pozitif veriyor. Niyet "SDK host'ta çağrılmasın"; doğru ölçüm `grep -rn "claude-agent-sdk" apps/api/src packages/core/src` — sonuç boş. |
| Canlılık ölçümü heartbeat'e değil **herhangi bir satıra** bağlandı | Tek mesaj tipine bağlamak kırılgan: iş üretip heartbeat'i kaçıran bir runner boşuna öldürülürdü. |
| Exec katmanı gelen satırları tamponluyor | Akış `startRunnerExec` dönmeden akmaya başlıyor; çağıran `onLine`'ı ancak sonra kaydedebiliyor. Arada kaybolan bir `ready` satırı agent'ı 30 sn "starting"de bırakıyordu — canlı testte bir kez gözlendi, tamponlama sonrası tekrarlanmadı. |
| Sağlayıcı dikişi Hafta 2'de açıldı | Yol haritası "Agent runtime: Claude Agent SDK" diyor ve bu korundu. Ama `runtime` alanı ve sağlayıcı env geçişi şimdi eklendi: en iyi model her yıl değişiyor, dikişi sonradan açmak mevcut kodu yeniden yazmak demekti. İkinci koşum ortamı **eklenecek**, hiçbir şey değişmeyecek. |
| Hafta 3 kapısı agent'a bağlanmadı | Bu haftanın konusu agent değil AKIŞ. Event üretmek için dev ucu kullanılıyor: gerçek event, gerçek DB, gerçek SSE — ama deterministik ve ücretsiz. Canlı agent'a bağlamak testi yavaşlatıp kararsızlaştırırdı, ölçtüğü şeye hiçbir şey katmadan. Agent gerektiren 2 kontrol ayrı: `gate:w3:agent`. |
| SSE geri baskısı `res.write()` dönüşüyle değil, bekleyen tampon boyutuyla ölçülüyor | Hono'nun `writeSSE`'si await edilebiliyor; yazım beklerken bus'tan gelenler tamponda birikiyor. Ölçülmesi gereken zaten o tampon: yavaş istemci sunucunun belleğini şişirmemeli. 5 MB'ı aşınca `overflow` + kapat. |
| Tek sunucu örneği varsayımı | `AgentManager` bellekte. İkinci bir sunucu örneği açılış mutabakatında birincinin runner'larını öldürür. Çok sunuculu dağıtım Redis ile sonraki fazlarda — o zamana kadar tek örnek koş. |

### Hafta 3 — tarayıcı kapısı koşulduktan sonra

| Karar | Gerekçe |
| --- | --- |
| Gönderme alanı `starting` durumunda da kilitli | Tarayıcı testi ilk koşumda buna düştü: "başlat"a basıldıktan sonra alan açık görünüyordu ama sunucu `409 (starting)` dönüyordu. Alanın "açık" olması "gönderilebilir" demek olmalı; aksi hâlde kullanıcı yazdığını reddedilmiş görüyor. |
| Tarayıcı testi agent çubuğundaki `idle`'ı bekler, alanın etkinliğini değil | Aynı yarış testin içindeydi: durum event'i gelmeden alan zaten etkin görünüyor. Hazır olmanın tek dürüst kanıtı `agent.ready` event'inin ekrana düşmesi. |
| `başlat` seçicisi `nav`'a daraltıldı | İki düğmede geçiyor (agent çubuğu ve gönderme alanı); Playwright ad eşlemesi büyük/küçük harfe duyarsız olduğu için "strict mode violation" veriyordu. |
| Kapının agent kısmı Gemini ile kapatıldı | `gate:w3:agent`'ın ölçtüğü şey akışın uçtan uca UI'da göründüğü: hangi koşum ortamı olduğu bu kontrolde önemsiz. Claude anahtarı gelince aynı test `E2E_AGENT` ile Claude odasına da koşulur. |

### Hafta 4

| Karar | Gerekçe |
| --- | --- |
| Kural seti gitleaks'ten ÜRETİLİYOR, elle yazılmıyor | 198 servis formatını elde tutmak imkânsız. `scripts/import-gitleaks.mjs` indirip `rules.generated.ts` üretiyor; dosya repoda duruyor ki build ağ istemesin. |
| RE2'nin `\A` / `\z` çapaları ATLANMADI, ÇEVRİLDİ | `m` bayrağı olmadan JS'te `^`/`$` tam olarak girdinin başı ve sonudur — RE2'nin anlamıyla birebir aynı. Atlasaydık 153 kural (setin yarısından fazlası) kaybolurdu. Karakter sınıfı içindekiler yine atlanıyor; `(?i)` ortada olan 22 kural da atlanıyor, çünkü orada çeviri uydurma olurdu. |
| Tek yakalama grubu olan kurallara `secretGroup=1` türetiliyor | gitleaks kuralları secret'ı tek gruba alıp çevresine bağlam yazıyor ama TOML'da `secretGroup` çoğunda yok. Kullanmayınca `generic-api-key` `DB_PASSWORD=...` satırının TAMAMINI maskeliyordu; "çevresindeki metin korunur" kuralı böyle bozuluyordu. |
| Entropi eşikleri test setine göre seçildi | 12 pozitif, 20 negatif. Ölçmeden tahmin etseydik üç hatayı bulamazdık: tokenizer'da ortadaki `=`, "`/` varsa yoldur" varsayımı (AWS secret'ı da `/` içeriyor) ve SRI `sha512-...`. |
| "Kural başına bir pozitif test" 198 kural için uygulanmadı | gitleaks kuralları örnek değer taşımıyor; 198 fixture elde yazmak ölçtüğü şeye bir şey katmaz. Bunun yerine 15 yaygın servis formatı + motorun tüm davranışları test ediliyor, ayrıca 198 kuralın **hepsinin** derlendiği ve doğru bayrakları taşıdığı otomatik doğrulanıyor. |
| Presence frame'i `id:` taşımıyor | `id` yalnızca event sırasını ilerletir. Presence'a id verseydik yeniden bağlanan istemcinin `Last-Event-ID` imleci bozulur ve gerçek event'ler atlanırdı. |
| `allow_patterns` yalnızca entropi katmanını susturur | Bilinen formatlı bir secret hiçbir ayarla maskelenmekten kurtulmamalı; aksi hâlde ayar dosyası bir sızıntı yoluna dönüşür. |
| Var olmayan oda `404` değil `403` | `404` dönmek hangi oda kimliklerinin var olduğunu sızdırır. Üye olmayan için ikisi de aynı görünmeli. |
| Kapı script'leri auth'u ATLATMIYOR, kullanıyor | `scripts/dev-session.mjs` magic link akışının tamamını koşuyor. Bir bypass eklemek, kapının "oturumsuz istek 401 alır" kontrolünü anlamsız kılardı. |
| Hafta 4 kapısı da agent'a bağlanmadı | Redaction'ın ölçtüğü şey GEÇİT: `appendEvent`. Event'i dev ucundan yazmak aynı geçitten geçiyor — gerçek DB, gerçek SSE, gerçek redaction, ama deterministik ve ücretsiz. Gerçek agent'ın dosya okumasıyla yapılan kontrol ayrı: `gate:w4:agent`. |
| Uzak erişim için tünel seçimi mimari karar sayıldı | Cloudflare hızlı tüneli SSE'yi tamponluyor: izleyici odayı görüyor ama canlı akış hiç ulaşmıyor. Akışı geçirmeyen bir vekilin arkasında bu arayüz çalışmaz; ölçüm README "Hafta 4 dogfood notları"nda. |
| Hafta 4 kapısındaki davetler artık rolü AÇIKÇA söylüyor | Hafta 5'te davetin varsayılanı `member` oldu ve kapının "izleyici yazamaz" kontrolü sessizce anlamını yitirdi (bir koşumda düştü, sebebi buydu). Varsayılana güvenen test, varsayılan değişince başka bir şeyi ölçmeye başlar. |
| Magic link hız sınırı kapı e-postalarını da vurdu | Sabit e-postayla kapıyı 5 dakikada iki kez koşturmak sınırı tetikliyordu. Sınırı gevşetmek yerine kapılar her koşumda benzersiz e-posta üretiyor: koruma gerçek kalsın. |
