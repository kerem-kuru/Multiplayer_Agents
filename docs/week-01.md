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

Sırayla: docker daemon'u bekler (3 dk'ya kadar) → postgres + redis kaldırır → healthy bekler → migration uygular → smoke koşar. Çıktının sonunda `Hafta 1 kapısı geçildi.` görmen gerekiyor. Görmezsen hangi adımda durduğu yazıyor.

## Gün 2–3'te yapılanlar

**`apps/api` — Hono.** Fastify yerine Hono seçildi: Hafta 3'te yazılacak SSE için `hono/streaming` hazır geliyor, paket küçük, Zod ile tip çıkarımı doğrudan çalışıyor. Fastify'ın plugin ekosistemine bu projede ihtiyaç yok.

Uçlar:

| Uç | İş |
| --- | --- |
| `POST /rooms` | YAML → oda → oturum → klasör düzeni → container → provision → event'ler |
| `GET /rooms` | Oda listesi |
| `GET /rooms/{id}` | Oda + son oturum + container durumu |
| `GET /rooms/{id}/events?since=N` | Event okuma. `nextSince` imleci döner; Hafta 3'te aynı sözleşmeyle SSE'ye geçilecek |
| `GET /rooms/{id}/journal` | Defter iskeleti — `backend: "filesystem-stub"`, Hafta 8'de tabloya döner |
| `GET /rooms/{id}/isolation` | Cuma dogfood kapısı, endpoint hâli |
| `POST /rooms/{id}/stop` | `session.ended` + container silme. Oda kaydı DURUR |

**Orkestrasyon `core/room/openRoom.ts` içinde, API'de değil.** HTTP olmadan da test edilebilsin ve Hafta 12'deki CLI aynı fonksiyonu çağırsın diye. Sıra: oda+oturum → klasörler → `room.created` → container+provision → `session.started`. Container adımı patlarsa `session.started` hiç yazılmaz, yerine `session.ended{reason:"crashed"}` düşer — log'da "başladı" görünüp aslında başlamamış oturum kalmaz.

**`agent.spawned` event'i YAZILMIYOR.** Gün 1'in smoke'u bunu elle yazıyordu, o bir simülasyondu. Gerçek API'de bu hafta hiçbir agent koşmuyor, o yüzden event de yok. Hafta 2'de Agent SDK ile gelecek.

### Agent izolasyonu: mount ile değil, POSIX ile

Bir oda = bir container = **tek dosya sistemi**. Agent başına rw/ro mount vermek oda başına N container demekti, bu da mimarinin temel kararını bozardı. Bunun yerine her agent kendi OS kullanıcısı (`agent-frontend`) altında koşuyor, klasör sahipliği kısıtı uyguluyor:

| Durum | Sahiplik | Mod |
| --- | --- | --- |
| Tek yazıcı (`worktrees/frontend`) | `agent-frontend:room` | `2750` |
| Çok yazıcı (`contracts`) | `root:room` | `2770` |
| Yazıcı yok (`journal`) | `root:room` | `2750` |

setgid biti (`2xxx`) şart: içeride yaratılan yeni dosyalar `room` grubunu miras alsın ki diğer agent'lar okuyabilsin. `ownershipPlan()` bu tabloyu konfigürasyondan üretiyor ve `mountPlan()` ile aynı gerçeği söylediği test ediliyor.

### Dogfood kapısında çıkan iki bulgu

**1 — Windows bind mount POSIX sahipliğini taşıyor.** Beklenti aksiydi. Docker Desktop'ın WSL2 backend'i `C:\` sürücüsünü `metadata` seçeneğiyle bağlıyor:

```
C:\ on /room type 9p (...;metadata;...)
```

`metadata` sayesinde sahiplik ve mod NTFS genişletilmiş özniteliklerinde saklanıyor, `chown`/`chmod` gerçekten uygulanıyor. Yani izolasyon Windows host'ta da sahici — named volume'a geçmeye gerek kalmadı. Bu seçenek kapalı bir makinede kapı düşer; `GET /rooms/{id}/isolation` bunu söyler.

**2 — Ara dizinler açık kalmıştı.** İlk uygulamada `worktrees/` `0777` kalıyordu. Bir dizin girdisini **silme ve yeniden adlandırma yetkisi o girdinin kendi izinlerinden değil, üst dizininin yazma yetkisinden gelir** — yani `agent-frontend`, `worktrees/backend` klasörünün *içine* yazamasa da onu `mv` ile taşıyabilirdi. İlk izolasyon testi bunu kaçırmıştı, çünkü sadece kardeş klasörün içine yazmayı deniyordu.

Düzeltme: ara dizinler (`/room`, `worktrees`) `root:room 2755`. `chown` bunlarda **`-R` olmadan** koşuyor — oda kökünde recursive olsaydı alttaki agent sahipliklerini silerdi. `verifyIsolation()` artık her agent için ara dizinlere girdi açmayı da deniyor.

### Doğrulama

`npm run verify` zinciri uzadı:

```
docker bekle → db kaldır → migrate → smoke (çekirdek)
  → oda imajını build et → smoke (api)
```

API smoke'un kanıtladıkları: `POST /rooms` 201 dönüyor, container `running`, event'ler `1:room.created 2:session.started`, `since=1` tek event + `nextSince=2`, defter iskeleti cevap veriyor, izolasyon iki agent için de tutuyor, `POST /stop` `session.ended` yazıp container'ı siliyor.

31 test geçiyor (Gün 1: 15). Yeni testlerin hepsi saf — docker veya DB gerektirmiyor.

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
