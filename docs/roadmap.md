# 12 Haftalık Yol Haritası

Kaynak: *Multiplayer Agent Odaları — Teknik Yol Haritası* (Eylül 2026). Bu dosya repo içindeki çalışma kopyasıdır; haftalık kapılar `docs/week-NN.md` içinde açılır.

## Yöntem

- **Event sourcing.** Her şey append-only log; UI bunun projeksiyonu. Multiplayer'ı sonradan eklemenin tek yolu.
- **Wizard of Oz önce.** Kod yazmadan önce mekaniği elle simüle et.
- **Spike-first.** Ürünü değil, en çok bilinmeyeni önce kodla; spike kodu atılır.
- **Haftalık dogfood kapısı.** Her cuma kendi ekibinde gerçek bir görev koştur. Koşturamadıysan o hafta başarısızdır; yeni özellik ekleme.
- **Build in public.** Repo hafta 1'de açık olsun, boş bile olsa.

## Faz 1 · Çekirdek altyapı

| Hafta | Konu | Biten iş |
| --- | --- | --- |
| 1 | İskelet ve event log | Oda yaratma isteği container kaldırıyor, DB'de kaydı duruyor, elle event yazıp `since=N` ile geri okunuyor |
| 2 | Tek agent, headless koşum | curl ile görev veriyorsun, agent kod yazıyor, her adım DB'de yapılandırılmış event. Hiçbir yerde metin kazıma yok |
| 3 | Stream ve terminal görünümü | Tarayıcıda canlı izleniyor; sekme kapanıp açılınca tek event kaybolmadan devam ediyor |

## Faz 2 · Multiplayer

| Hafta | Konu | Biten iş |
| --- | --- | --- |
| 4 | Redaction ve ikinci izleyici | İkinci kişi 3 saniyede senkron; bilerek `.env` okutuluyor, ekranda görünmüyor |
| 5 | Yazma yetkisi, kuyruk, kesme | İki kişi aynı agent'a yazıyor, çakışma yok; sürücülük 2 tıkta devrediliyor |
| 6 | Diff görünümü ve satır yorumu | Satıra "bunu böl" yazılıyor, agent 30 sn'de düzeltiyor, ikinci kullanıcı canlı görüyor |

## Faz 3 · Çoklu agent

| Hafta | Konu | Biten iş |
| --- | --- | --- |
| 7 | İkinci agent ve worktree izolasyonu | İki agent paralel; birine diğerinin dosyasını değiştirtemiyorsun — izin hatası. Ekranda tek satır ham terminal yok |
| 8 | Oda defteri | Aşağıdaki kapıyı geçmek |
| 9 | Görev panosu | Agent görevini alıp kanıtla kapatıyor; kanıtsız görev kapanmıyor |
| 10 | Onay kuyruğu | `git push` onay bekliyor, iki kişi aynı anda basıyor, çift işlem olmuyor. Oturum başına 5'ten az onay |

> ### Kapı — bütün planın kırılma noktası
> Kanıtlanması gereken tek şey: *backend agent bir mimari karar aldı, deftere yazdı, frontend agent turn'üne başlarken onu okudu ve sözleşmeye uygun kodu yazdı — aralarında hiç mesaj geçmeden.*
> Hafta 9'a geçmeden bu senaryoyu üst üste **5 kez** başarıyla koştur.

## Faz 4 · Ölçek ve dışarı çıkış

| Hafta | Konu | Biten iş |
| --- | --- | --- |
| 11 | 3. ve 4. rol, maliyet, gözlemlenebilirlik | 4 agent bir arada, bütçe dolunca temiz duruyor, her kararın izi sürülebiliyor |
| 12 | Kurulum, BYOK, ilk dış kullanıcılar | Tanımadığın biri linkten kuruyor, ikinci kişiyi davet ediyor. Hedef: senin içinde olmadığın 3 oturum |

## Teknoloji yığını

| Katman | Seçim |
| --- | --- |
| Desktop | Tauri 2 |
| Web istemci | React + Vite |
| Terminal render | xterm.js |
| PTY | node-pty / portable-pty (sadece sunum) |
| Agent runtime | Claude Agent SDK (TS), headless mod |
| Event log | Postgres append-only tablo |
| Realtime | SSE (stream) + REST (komut) |
| Pub/sub | Redis |
| Sandbox | Docker (lokal) → Fly Machines / E2B (bulut) |
| Şema doğrulama | Zod |
| Redaction | gitleaks kuralları + entropy taraması |
| Gözlemlenebilirlik | Langfuse veya OpenTelemetry |

## Risk listesi

| Risk | Önlem |
| --- | --- |
| Secret sızıntısı — 4 terminal, 2+ izleyici | Stream'e girmeden zorunlu redaction. Hafta 4'te, sonraya bırakma |
| Özet kayması — eski karar okunuyor | `version` + `superseded_by`; agent sadece güncel durumu okur |
| Sessiz sapma — 40 dk yanlış yön | Planner'ın periyodik "plan vs gerçeklik" kontrolü |
| Gözlemlenemezlik | UI ham çıktı değil özet akışı gösterir; terminal tıklayınca açılır |
| Kontrolsüz token yanması | Container başına hard stop — Faz 2'de yaz |
| Onay yorgunluğu | Sadece geri alınamaz eylemler onaya düşsün |
| Repo erişim sürtünmesi | GitHub App + OAuth |

## Maliyet

Orta zorlukta bir full-stack SaaS projesi ≈ 4.000–8.000 turn. Karışık model stratejisi (kod Opus+Sonnet, planner/security Haiku) ile **$240–480**. Harcamanın %95'i token, container maliyeti $20–50 — optimizasyon eforunu altyapıya değil token'a harca: agresif prompt caching, model yönlendirme, event-driven uyanma.

Ürün tarafında BYOK seç; token maliyetini taşıma.

## Ölçülecek metrik

**Aynı oturuma iki farklı insanın yazdığı oturum sayısı, haftalık.** İkincil: oturum başına ikinci kişinin bıraktığı yönerge sayısı — 0 ise o kişi izleyicidir, katılımcı değil.
