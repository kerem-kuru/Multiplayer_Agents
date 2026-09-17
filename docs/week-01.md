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
| 6 | `POST /rooms` → container spawn, worktree klasör yapısı | 2–3 | ⏳ |

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

## Gün 2–3 için sıradaki iş

1. `apps/api` paketi (Fastify veya Hono) + `POST /rooms`:
   - YAML yükle → `createRoom` → `createSession`
   - `scaffoldRoomLayout()` ile klasörleri kur
   - `docker run` ile oda container'ı ayağa kaldır, `attachContainer()`
   - `room.created` + `session.started` event'lerini yaz
2. `GET /rooms/{id}/journal` ve `GET /rooms/{id}/events?since=N` iskeletleri (SSE Hafta 3'te).
3. Oda imajını build et: `docker compose --profile build-only build room`.
4. **Cuma dogfood kapısı:** gerçek bir repo ile oda aç, klasör düzeninin ve mount izinlerinin container içinde doğru olduğunu elle doğrula.

## Not

`npm audit` 5 zafiyet bildiriyor (3 orta, 1 yüksek, 1 kritik) — hepsi `vitest@2` altındaki dev bağımlılıklardan geliyor, üretim koduna girmiyor. Hafta 2'de vitest 3'e çıkıldığında temizlenir.
