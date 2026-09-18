# Multiplayer Agent Odaları

Bir **oda**, içinde birden çok Claude terminali barındıran izole bir container'dır. Her terminal bir rolü üstlenir (frontend, backend, güvenlik, planlama). Odaya giren birden çok geliştirici aynı anda bu agent'lara görev verir, işlerini canlı izler, yönlerini değiştirir ve sürücülüğü birbirine devreder.

Agent'lar birbirine mesaj atmaz. Ortak bir **oda defterine** yazar ve oradan okur.

> **Tez:** Gerçek birim agent değil, her agent'ın okuyup yazdığı tek paylaşılan bağlam deposudur.

Durum: **Hafta 3 bitti** — akış kapısı 11/11 (`gate:w3`) ve agent gerektiren iki tarayıcı
testi (`gate:w3:agent`) Gemini koşum ortamına karşı geçti. Tarayıcıda bir görev baştan sona
canlı izlenebiliyor; sayfa yenilendiğinde tek event eksilmiyor.

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
```

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

Agent meşgulken gelen ikinci mesaj **409** alır — kuyruk Hafta 5'te.

Docker'sız çalışmak için `SPAWN_CONTAINER=0` — oda kaydı ve klasörler kurulur, container açılmaz.

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
db/migrations/    Append-only şema
rooms/Dockerfile  Oda container imajı
config/           Örnek rol konfigürasyonu
scripts/          migrate, smoke, build-runner, validate-events, week1-gate, week2-gate
docs/             Haftalık kapılar
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
| Tool çıktısının metni | ✅ | ❌ sadece `status` |
| USD maliyet | ✅ | ❌ sadece token sayısı |
| SDK tool listesi | ✅ `turn.started.tools` | ❌ boş |

Ölçüm ayrıntıları ve entegrasyonda çıkan hatalar: `docs/runtime-gemini.md`.

Anahtarlar bağımsız: `ANTHROPIC_API_KEY` yokken Gemini agent'ları çalışır, tersi de geçerli. Her koşum ortamı yalnızca kendi anahtarını görür.

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
