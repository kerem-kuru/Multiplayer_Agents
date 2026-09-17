# Multiplayer Agent Odaları

Bir **oda**, içinde birden çok Claude terminali barındıran izole bir container'dır. Her terminal bir rolü üstlenir (frontend, backend, güvenlik, planlama). Odaya giren birden çok geliştirici aynı anda bu agent'lara görev verir, işlerini canlı izler, yönlerini değiştirir ve sürücülüğü birbirine devreder.

Agent'lar birbirine mesaj atmaz. Ortak bir **oda defterine** yazar ve oradan okur.

> **Tez:** Gerçek birim agent değil, her agent'ın okuyup yazdığı tek paylaşılan bağlam deposudur.

Durum: **Hafta 1 / 12 tamam** — iskelet, event log ve `POST /rooms`. `npm run gate` 10 kontrolden geçiyor. Henüz hiçbir agent koşmuyor; sadece kemikler.

## Hızlı başlangıç

Gereksinimler: Node 20+, Docker.

```bash
cp .env.example .env
npm install
npm run build
npm test             # 27 test — docker ve DB gerekmez

npm run verify       # tek komut: docker bekle → db → migrate → smoke → imaj → kapı
```

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

Docker'sız çalışmak için `SPAWN_CONTAINER=0` — oda kaydı ve klasörler kurulur, container açılmaz.

## Yapı

```
apps/
  api/            Hono. POST /rooms, GET events?since=N, stop
  web/            React + Vite iskeleti. Hafta 3: SSE istemcisi, xterm.js
  desktop/        Tauri 2 kabuğu, apps/web ile aynı bileşenler
packages/
  protocol/       Zod event şemaları — istemci ve sunucu aynı tipleri kullanır
  core/           YAML rol yükleyici, event store, oda düzeni, container
db/migrations/    Append-only şema
rooms/Dockerfile  Oda container imajı
config/           Örnek rol konfigürasyonu
scripts/          migrate, smoke, smoke-api, week1-gate, verify
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

## Event log

Her şey append-only; UI bunun projeksiyonudur. `session_events` üzerinde UPDATE ve DELETE veritabanı trigger'ı ile engellidir. `seq`, oturum başına `sessions.next_seq` satır kilidi üzerinden dağıtılır — iki paralel yazıcı asla aynı sırayı alamaz; `(session_id, seq)` unique index son savunma hattıdır.

Yeni bir durum eklemenin yolu yeni bir event tipi eklemektir, mevcut bir kaydı değiştirmek değil.

## Agent sayısı hiçbir yerde sabit değil

Roller `config/room.example.yaml` içinde bir dizidir. Kod her yerde bu diziyi dolaşır, UI `agents.map()` yapar, defter referansları isimle verilir. Üçüncü agent eklemek tek bir YAML bloğu olmalı — `roomConfig.test.ts` bunu test ediyor.

## Yol haritası

12 haftalık plan `docs/roadmap.md` içinde. Hafta 8 sonundaki kapı gerçek bir durak noktasıdır: *backend agent bir mimari karar alır, deftere yazar, frontend agent turn'üne başlarken onu okur ve sözleşmeye uygun kodu yazar — aralarında hiç mesaj geçmeden.* Bu çalışmadan 3. ve 4. agent eklemek sadece hatayı büyütür.

## Ölçülecek tek metrik

**Aynı oturuma iki farklı insanın yazdığı oturum sayısı, haftalık.** Kurulum sayısı değil, star sayısı değil.

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
