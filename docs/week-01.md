# Hafta 1 — İskelet ve event log

**Biten iş (kapı):** Oda yaratma isteği bir container ayağa kaldırıyor, DB'de kaydı duruyor, elle event yazıp `since=N` ile geri okuyabiliyorsun.

Bu hafta hiçbir agent çalışmıyor. Sadece üstüne her şeyin kurulacağı append-only omurga.

## Görev listesi

| # | Görev | Gün | Durum |
| --- | --- | --- | --- |
| 1 | Monorepo: `apps/web`, `apps/desktop`, `packages/core`, `packages/protocol` | 1 | ✅ |
| 2 | Postgres şeması: `rooms`, `sessions`, `session_events` + `(session_id, seq)` unique | 1 | ✅ |
| 3 | Event tipleri `packages/protocol` içinde Zod şeması | 1 | ✅ |
| 4 | Rol konfigürasyonu YAML yükleyici — agent sayısı sabit değil | 1 | ✅ |
| 5 | docker-compose: postgres + redis + oda container imajı | 1 | ✅ |
| 6 | `POST /rooms` → container spawn, worktree klasör yapısı | 2–3 | ✅ |

## Gün 1'de yapılanlar

**Monorepo.** npm workspaces (pnpm kurulu değildi). `packages/protocol` ve `packages/core` TypeScript project references ile bağlı; `apps/*` şimdilik yer tutucu.

**Event kataloğu — `packages/protocol/src/events.ts`.** 22 event tipi, ortak zarf (`seq`, `roomId`, `sessionId`, `ts`, `actor`) + tip başına Zod payload'ı, `type` üzerinde discriminated union. İki karar:

- `output.chunk` `PRESENTATION_ONLY` olarak işaretli. Ham PTY byte'ı taşır, kontrol düzlemi ondan asla okumaz. Kod gözden geçirmede "bu karar hangi event'ten geldi?" sorusunun cevabı hiçbir zaman burası olamaz.
- `NewRoomEvent` = `seq` ve `ts` olmadan. Sıra ve saat sunucunun, çağıranın değil.

**Rol konfigürasyonu — `packages/core/src/config/loadRoomConfig.ts`.** YAML → Zod. `.strict()` kullanılıyor: `tools_allow` yazıp `toolsAllow` demeyi unutmak sessizce yutulmaz, hata verir. `superRefine` iki kuralı zorluyor: agent adları tekil, ve bir agent kendi workspace'i / `contracts` / `journal` dışına yazma izni isteyemez.

**Şema — `db/migrations/001_init.sql`.** Üç tablo. `session_events` üzerinde `BEFORE UPDATE OR DELETE` trigger'ı append-only'yi veritabanı seviyesinde zorluyor — uygulama hatası log'u bozamaz. Bu yüzden foreign key'lerde `ON DELETE CASCADE` yok: oda silinmez, arşivlenir.

**Sıra dağıtımı — `packages/core/src/db/eventStore.ts`.** `UPDATE sessions SET next_seq = next_seq + 1 ... RETURNING` tek transaction'da satır kilidi alır; iki paralel yazıcı aynı `seq`'i alamaz. `MAX(seq)+1` yaklaşımı yarış durumuna açıktı, kullanılmadı.

**Testler.** 15 test, ikisi de saf (DB gerektirmiyor): event şeması reddetme davranışı ve rol YAML'ının kırılma noktaları — üçüncü agent'ı eklemenin tek blok olduğu dahil.

## Yeniden başlattıktan sonra

Docker Desktop'ın WSL sorunu elle çözüldü, makine yeniden başlatılacak. Açılışta tek komut kapıyı doğrular:

```bash
cd ~/Desktop/agent-rooms
npm run verify
```

Sırayla: docker daemon'u bekler (3 dk'ya kadar) → postgres + redis kaldırır → healthy bekler → migration uygular → smoke koşar → oda imajını build eder → Hafta 1 kapısını (10 kontrol) koşar. Çıktının sonunda `HAFTA 1 KAPISI GEÇİLDİ.` görmen gerekiyor. Görmezsen hangi adımda durduğu yazıyor.

## Gün 2–3'te yapılanlar

**`apps/api` — Hono.** Fastify yerine Hono seçildi: Hafta 3'te yazılacak SSE için `hono/streaming` hazır geliyor, paket küçük, Zod ile tip çıkarımı doğrudan çalışıyor. Fastify'ın plugin ekosistemine bu projede ihtiyaç yok.

Uçlar:

| Uç | İş |
| --- | --- |
| `POST /rooms` | YAML → oda → oturum → klasör düzeni → container → event'ler |
| `GET /rooms` | Oda listesi |
| `GET /rooms/{id}` | Oda + son oturum + container durumu |
| `GET /rooms/{id}/events?since=N` | Event okuma. `nextSince` imleci döner; Hafta 3'te aynı sözleşmeyle SSE'ye geçilecek |
| `GET /rooms/{id}/journal` | Defter iskeleti — `backend: "filesystem-stub"`, Hafta 8'de tabloya döner |
| `POST /sessions/{sid}/events` | Sadece geliştirme — elle event yaz |
| `POST /rooms/{id}/stop` | `session.ended` + container silme. Oda kaydı DURUR |

**Orkestrasyon `core/room/openRoom.ts` içinde, API'de değil.** HTTP olmadan da test edilebilsin ve Hafta 12'deki CLI aynı fonksiyonu çağırsın diye. Sıra: oda+oturum → klasörler → `room.created` → container → `session.started`. Container adımı patlarsa `session.started` hiç yazılmaz, yerine `session.ended{reason:"crashed"}` düşer — log'da "başladı" görünüp aslında başlamamış oturum kalmaz.

**`agent.spawned` event'i YAZILMIYOR.** Gün 1'in smoke'u bunu elle yazıyordu, o bir simülasyondu. Gerçek API'de bu hafta hiçbir agent koşmuyor, o yüzden event de yok. Hafta 2'de Agent SDK ile gelecek.

### Kapı script'i — `npm run gate`

Haftanın kabul kriteri artık tek komut. 10 kontrol, her biri ✓/✗ basıyor, biri düşerse `exit 1`:

| # | Kontrol | Ne kanıtlıyor |
| --- | --- | --- |
| 1 | `POST /rooms` → 201 | Oda, oturum ve agent listesi döndü |
| 2 | `docker ps --filter label=agent-rooms.room=<id>` | Container gerçekten çalışıyor |
| 3 | Klasör düzeni | YAML'daki her agent için worktree + contracts + journal |
| 4 | `events?since=0` | `1:room.created 2:session.started` |
| 5 | Elle event + `since=2` | Haftanın "biten iş" cümlesinin tam karşılığı |
| 6 | **50 istek, 20 paralel** | `count = count(DISTINCT seq) = max(seq)` |
| 7 | `{"type":"uydurma"}` | 400 döner ve DB'ye satır yazılmaz |
| 8 | `UPDATE session_events` | Trigger reddeder |
| 9 | 3. agent, ayrı port + `ROOM_CONFIG` | **Kod değişmeden** çalışır |
| 10 | Temizlik | Script'in açtığı container'lar silinir |

**6. kontrol bu haftanın en değerli testi.** Kilitli sayaç Gün 1'de yazılmıştı ama paralel yük altında hiç sınanmamıştı. Sonuç: `count=53 distinct=53 max=53` — tek bir çakışma veya boşluk yok. `MAX(seq)+1` yaklaşımı bu testte kesin düşerdi.

**9. kontrol** "agent sayısı hiçbir yerde sabit değil" kuralını ölçüyor: script geçici bir YAML yazıp ikinci bir sunucuyu farklı portta `ROOM_CONFIG` ile açıyor, `worktrees/security` klasörünün açıldığını doğruluyor. Tek satır kod değişmiyor.

jq yerine `node` kullanılıyor — node zaten projenin çalışma zamanı, jq her makinede yok.

### Docker erişimi: CLI → dockerode

İlk uygulama `docker` CLI'ını `child_process` ile çağırıyordu. Kütüphaneye geçildi çünkü:

- **Hafta 2-3** agent çıktısını uzun ömürlü bir exec stream'i olarak okuyacak. dockerode gerçek stream nesnesi veriyor; CLI'da süreç başına bir `docker exec` sarmalayıcısı yönetmek gerekirdi.
- **Hafta 11** container istatistiği isteyecek (`container.stats()`); CLI'da bu metin ayrıştırması olurdu — ki "hiçbir yerde metin kazıma yok" kuralı tam da bunun için var.
- Hata nesneleri durum kodu taşıyor (404 = yok), `docker` binary'sinin PATH'te olması gerekmiyor.

Yan fayda: Git Bash'in yol dönüştürmesi (`/room` → `C:/Program Files/Git/room`) CLI çağrılarını bozuyordu, kütüphanede o sorun yok.

### İzolasyon geri alındı

Gün 3'te POSIX tabanlı agent izolasyonu yazılmıştı: agent başına OS kullanıcısı, `ownershipPlan()`, container içinde yazma denemesiyle doğrulama. Çalışıyordu — Windows bind mount'un `metadata` seçeneği sayesinde sahiplik gerçekten uygulanıyordu, ve ara dizin (`worktrees/`) açığı da bulunup kapatılmıştı.

**Ama kapsam dışıydı.** Hem yol haritası (Hafta 7: *"Container içi mount izinleri: kendi worktree'si rw, diğerleri ro"*) hem görev tanımı (*"Gerçek git worktree yönetimi ve read-only mount'lar — Hafta 7"*) bunu aynı haftaya koyuyor. Kod kaldırıldı; Hafta 7'de worktree yönetimiyle birlikte yeniden yazılacak. Bulgular `docs/week-07-notlar.md`'ye taşınmadı, git geçmişinde `8fbbded` commit'inde duruyor.

### Diğer eklemeler

- **`POST /sessions/:sid/events`** — sadece geliştirme (`NODE_ENV=production` iken uç hiç tanımlanmaz). Haftanın "elle event yaz" maddesi bunu kullanıyor. `debug.note` event tipi eklendi.
- **`GET /health` artık DB'ye dokunuyor** — `SELECT 1`. Ayakta olmak "yazabiliyorum" demek; DB yoksa 503.
- **`.env` Node'un kendi yükleyicisiyle okunuyor** (`process.loadEnvFile`), dotenv bağımlılığı yok. Ortamda tanımlı değişkenler ezilmiyor.
- **`apps/web`** artık gerçek bir React + Vite iskeleti; `/rooms` ve `/health` için proxy ayarlı, Hafta 3'te doldurulacak.

### Doğrulama

```
npm test          27 test (saf — docker/DB gerekmez)
npm run gate      10/10
npm run verify    docker → db → migrate → smoke → oda imajı → kapı
```

## Sıradaki iş — Hafta 2

1. Claude Agent SDK entegrasyonu, headless / stream-json modu
2. Agent süreç yöneticisi: spawn, kill, sağlık kontrolü, çökme sonrası durum
3. SDK'dan gelen her event'i `session_events`'e yaz — tool çağrısı, sonuç, dosya değişikliği
4. `POST /rooms/{id}/agents/{aid}/message`
5. Rol YAML'ından `toolsAllow` / `toolsDeny` uygulaması

Agent süreçleri `docker exec -u agent-<rol>` ile başlatılacak — kullanıcılar ve izinler bu hafta hazırlandı.

**Hafta 2 kapısı:** curl ile görev veriyorsun, agent gerçekten kod yazıyor, attığı her adım DB'de yapılandırılmış event olarak duruyor. Hiçbir yerde metin kazıma yok.

## Not

`npm audit` 5 zafiyet bildiriyor (3 orta, 1 yüksek, 1 kritik) — hepsi `vitest@2` altındaki dev bağımlılıklardan geliyor, üretim koduna girmiyor. Hafta 2'de vitest 3'e çıkıldığında temizlenir.
