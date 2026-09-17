# Multiplayer Agent Odaları

Bir **oda**, içinde birden çok Claude terminali barındıran izole bir container'dır. Her terminal bir rolü üstlenir (frontend, backend, güvenlik, planlama). Odaya giren birden çok geliştirici aynı anda bu agent'lara görev verir, işlerini canlı izler, yönlerini değiştirir ve sürücülüğü birbirine devreder.

Agent'lar birbirine mesaj atmaz. Ortak bir **oda defterine** yazar ve oradan okur.

> **Tez:** Gerçek birim agent değil, her agent'ın okuyup yazdığı tek paylaşılan bağlam deposudur.

Durum: **Hafta 1 / 12** — iskelet ve event log. Henüz hiçbir agent çalışmıyor; sadece kemikler.

## Hızlı başlangıç

```bash
cp .env.example .env
npm install
npm run build

npm test             # şema ve konfigürasyon testleri (DB gerekmez)
npm run verify       # docker bekle → db kaldır → migrate → uçtan uca smoke
```

`verify` yerine adım adım: `npm run db:up`, `npm run db:migrate`, `npm run smoke`.

## Yapı

```
apps/
  web/            Hafta 3: SSE istemcisi, xterm.js, event → görsel eşleme
  desktop/        Tauri 2 kabuğu, apps/web ile aynı bileşenler
packages/
  protocol/       Zod event şemaları — istemci ve sunucu aynı tipleri kullanır
  core/           YAML rol yükleyici, event store, oda klasör düzeni
db/migrations/    Append-only şema
rooms/Dockerfile  Oda container imajı
config/           Örnek rol konfigürasyonu
scripts/          migrate, smoke
docs/             Haftalık kapılar
```

## İki mimari kural

**1 — Kontrol düzlemi ile sunum düzlemini ayır.** Agent headless / stream-json modunda koşar; tool çağrıları ve dosya değişiklikleri yapılandırılmış JSON olarak gelir. Terminal görünümü bu akışın *render* edilmiş halidir. Hiçbir yerde metin kazıma yok — `packages/protocol` içinde `output.chunk` bu yüzden `PRESENTATION_ONLY` olarak işaretli, kontrol kararları ondan okumaz.

**2 — Sınırlanmış dünyada sınırsız yetki.** Kısıtlar sistem prompt'una yazılmaz; container sınırı, mount izni ve hook olarak uygulanır. Her agent kendi worktree'sinde tam yetkilidir:

```
/room
├── worktrees/
│   ├── frontend/     branch: room-42/frontend   (tam yetki)
│   ├── backend/      branch: room-42/backend    (tam yetki)
│   └── security/     read-only mount
├── contracts/        herkese yazılabilir — API sözleşmeleri
└── journal/          oda defteri
```

Frontend agent, backend'in yazmakta olduğu kodu göremez. Bu bir kısıt değil, mimarinin amacı: koordinasyon `contracts/` ve defter üzerinden yapılmak *zorunda* kalır. `mountPlan()` bu planı rol YAML'ından üretir.

## Event log

Her şey append-only; UI bunun projeksiyonudur. `session_events` üzerinde UPDATE ve DELETE veritabanı trigger'ı ile engellidir. `seq`, oturum başına `sessions.next_seq` satır kilidi üzerinden dağıtılır — iki paralel yazıcı asla aynı sırayı alamaz; `(session_id, seq)` unique index son savunma hattıdır.

Yeni bir durum eklemenin yolu yeni bir event tipi eklemektir, mevcut bir kaydı değiştirmek değil.

## Agent sayısı hiçbir yerde sabit değil

Roller `config/room.example.yaml` içinde bir dizidir. Kod her yerde bu diziyi dolaşır, UI `agents.map()` yapar, defter referansları isimle verilir. Üçüncü agent eklemek tek bir YAML bloğu olmalı — `roomConfig.test.ts` bunu test ediyor.

## Yol haritası

12 haftalık plan `docs/roadmap.md` içinde. Hafta 8 sonundaki kapı gerçek bir durak noktasıdır: *backend agent bir mimari karar alır, deftere yazar, frontend agent turn'üne başlarken onu okur ve sözleşmeye uygun kodu yazar — aralarında hiç mesaj geçmeden.* Bu çalışmadan 3. ve 4. agent eklemek sadece hatayı büyütür.

## Ölçülecek tek metrik

**Aynı oturuma iki farklı insanın yazdığı oturum sayısı, haftalık.** Kurulum sayısı değil, star sayısı değil.
