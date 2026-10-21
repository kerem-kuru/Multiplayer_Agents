# Hafta 7 — İkinci agent ve worktree izolasyonu

**Biten iş (kapı):** İki agent aynı repoda paralel çalışıyor. Birine diğerinin dosyasını
değiştirmesini söylüyorsun, yapamıyor: izin hatası alıyor ve dosya değişmiyor. İki agent koşarken
oda görünümünde tek satır ham terminal çıktısı yok.

Hafta 6'nın sonunda tek bir agent vardı ve her şeye erişebiliyordu. Bu hafta izolasyon **yapısal**
hale geldi. "Backend'in dosyasına dokunma" cümlesi prompt'ta yazmıyor; dosya sistemi izin vermiyor.
Arayüz de iki seviyeye ayrıldı: oda görünümünde her agent bir kart, ham çıktı yalnızca detayda.

**Kapanış: 13 Ekim 2026.** Açık kalan tek kapı `gate:w7:agent` üç gün Google 503'ü, sonra bir ölçüm
kusuru (aşağıda) yüzünden geç kapandı.

## Görev listesi

| # | Adım | Durum |
| --- | --- | --- |
| 1 | Rol config: yazma ve okuma kuralları | ✅ başka agent'ın worktree'sine yazma config yüklenirken hata |
| 2 | İzin planı (saf) | ✅ `room-fs.ts`, birim testli |
| 3 | Oda volume'u ve plan uygulayıcı | ✅ named volume, agent başına uid (10001+), worktree `0750`, `contracts/` setgid `2775` |
| 4 | Depo kurulumu | ✅ merkez `repo.git` `rooms-integrator`'a ait, `clone --shared`, `refs/rooms/base/*` |
| 5 | Runner agent kimliğiyle | ✅ |
| 6 | Yeni event'ler | ✅ `contract.changed`, `conflict.detected/cleared`, `isolation.violation`, `agent.crashed` … |
| 7 | Contracts takibi | ✅ içerik değil `sha256` + `size` |
| 8 | Çakışma tespiti | ✅ `path_overlap`, `contracts_race` (60 sn) |
| 9 | İzin denetimi (turn sonu) | ✅ kayma tespit, düzeltme, `isolation.violation` |
| 10 | Oda silme ve temizlik | ✅ sweeper |
| 11 | Migration | ✅ **`007`** (sapma, aşağıda) |
| 12 | Projeksiyon ve kart modeli | ✅ kart sayısı `agents.map()` |
| 13 | Önceki kapılar volume'a | ✅ `GATE_W7_REGRESSION=1` |
| 14 | UI: iki seviyeli odaklanma | ✅ oda kartları + agent detayı |
| 15 | Kapı script'i | ✅ `gate:w7` **93/93** (modelsiz) · `gate:w7:agent` **16/0/1** |
| 16 | Cuma dogfood | ✅ Kerem'in kararıyla sayıldı (tek kişi, iki hesap, iki cihaz) + soru 3 kontrollü ölçüm |
| 17 | README | ✅ |

**493 birim test** (Hafta 6 sonunda 329'du). Protokol **8**, snapshot **10**, Gemini CLI **0.62.0**.

## Hafta Sonu Tanımı

| Madde | Kanıt |
| --- | --- |
| typecheck temiz, birim testler geçiyor | 13 Ekim: typecheck + web tsc temiz, 493/493 |
| `gate:w7` geçiyor; Hafta 1–6 kapıları volume tabanlı geçiyor | `gate:w7` 93/93 · regresyon: 23 Eylül `GATE_W7_REGRESSION=1` **98/0** (Hafta 1, 3, 4, 5, 6 volume tabanlı); UTF-8 göçünden sonra (13 Ekim) `gate:w5` 25/25 (içinde Hafta 1, 3, 4) ve `gate:w6` 13/13. Volume'dan sonra koşulmadı: `gate:w3:agent`, `gate:w5:agent` (model ister); `gate:w2` hiç koşulmadı |
| Merkez depo `rooms-integrator`'a ait, sertleştirme, `refs/rooms/base/*` | `gate:w7` G1–G7 |
| `safe.directory=*` hiçbir yerde yok | gitkit'ten kaldırıldı; tek istisna `/etc/gitconfig`'de tek yol (README "safe.directory") |
| İmajdaki git CVE durumu | README "İmajdaki git ve açık CVE'ler" |
| Hafta 9–10 entegrasyon modeli yazılı | README "Hafta 9–10 entegrasyon modeli" |
| İzin matrisi Linux dışı makinede | bütün koşumlar Windows Docker Desktop'ta |
| Agent ötekinin dosyasını değiştiremiyor, prompt'ta tek kelime yok | `gate:w7:agent` [5]: `isError: true`, sha256 aynı |
| Biri çökünce diğeri devam ediyor | `gate:w7:agent` [9]: backend `kill -9`, frontend turn'ünü bitirdi |
| Oda görünümünde ham çıktı yok (testli) | Playwright [17, 18, 21] |
| Kart sayısı config'ten | `gate:w7` [6] üçüncü agent |
| Agent deposunda root git çalışmıyor | `gate:w7` G7 |
| İki kişilik dogfood, notlar README'de | sayıldı (yukarıda), README "Hafta 7 dogfood notları" |
| Public repoya push | ✅ |

## Kararlar (gerekçeleri README'de)

- **Üç mimari karar:** izolasyon Unix kullanıcılarıyla, bind mount yerine named volume,
  `git worktree` yerine `git clone --shared`. README "Hafta 7 kararları".
- **Bilinçli sapma 1:** Gemini yeniden denemeleri stderr'den okunuyor ("metin kazıma yok" kuralına
  istisna; CLI bunu yapılandırılmış vermiyor).
- **Bilinçli sapma 2 (13 Ekim, Kerem):** Gemini'de config'teki model garanti değil. CLI flash ailesinde
  kendi seçtiğini koşturuyor; ürün çalışan modeli gösteriyor (protokol 8), engelleyemiyor. Koşum ortamı
  sözleşmesine 5. madde eklendi: çalışan modeli raporla.
- **Kural (13 Ekim):** HTTP gövdeleri UTF-8 ve bayt olarak. API geçersiz UTF-8'i 400 ile reddediyor.
  Bilinçli istisna: bu geçit kimlik kontrolünden önce çalışıyor.

## Görev tanımından sapmalar

| Sapma | Sebep |
| --- | --- |
| Migration `006` değil `007` | `006` Hafta 6'da alınmıştı |
| `rooms.status` DROP değil ADD COLUMN | Sütun hiç yaratılmamıştı |
| `journal` yazılamaz | Mimari `root:root 0755` istiyor |
| Dogfood tek kişiyle, iki hesap ve iki cihazla | Kerem'in kararı (30 Eylül). Soru 3 ayrıca kontrollü ölçüldü |
| Kapı Gemini ile koşuldu | Claude anahtarı yok. Model sapması README'de; frontend `gemini-3.8-flash` |

## Haftanın son günü bulunan ölçüm kusuru

Kapılar agent'a mesajı `curl -d` ile gönderiyordu. Git'in curl'ü argümanı Windows kod sayfasıyla
yolluyor, API de baytları sessizce `�` yapıyordu: 28 Eylül'den beri kapı mesajlarının çoğu modele
"olu�tur" diye gitti. Hiçbir kapı bunu yakalamadı; ölçen araç kusurluydu. Düzeltme iki taraflı:
API geçersiz UTF-8'i 400 ile reddediyor, script'ler gövdeyi `scripts/lib/post-json.mjs` ile stdin'den
bayt olarak gönderiyor. Bütün kapılar taşındı ve yeniden koşuldu; kontrol sayıları referansla aynı
(README "Kural: HTTP gövdeleri UTF-8 ve bayt olarak"). Soru 3 bulgusu sağlam metinle tekrarlandı.

## Hafta 8'e devredilenler

- **`contracts/` mesaj kutusu gibi kullanılıyor.** İzin sınırına takılan agent ötekinin dosyasına
  yazmayı denemiyor, `contracts/`'a bir **iş isteği** bırakıyor (`cors-request.md`). Ürün bunu
  `contract.changed` sayıyor. Defter tasarımında isteklerin ayrı bir tür mü olacağı kararı gerekiyor.
- **Oda "birlikte çalışıyor mu" sorusunu cevaplayamıyor.** İki agent "sözleşmeye uyumlu" dedi, çalıştığı
  ancak odanın dışında doğrulanabildi (README "Asıl bulgu").
- **Sessiz turn:** hiçbir şey yapmayan ve hiçbir şey söylemeyen turn kartta "başarılı" görünüyor.
- **Karttaki ham stack trace** (Kerem: Hafta 8 tasarımında).
- **API'de bozuk JSON sessizce `{}` oluyor:** 14 uç `c.req.json().catch(() => ({}))` kullanıyor.

## Açık borçlar (bilerek bırakıldı, kayıtlı)

- `gate:w2` hiç koşulmadı (Claude anahtarı yok).
- `gate:w6:agent` yorumdan düzeltmeye 42,4 / 59,6 sn (eşik 30 uyarı / 60 başarısız; Hafta 6'da 13,7).
  Model süresi.
- `gate:w4:agent` modelin `.env`'i yazmayı kabul etmesine bağlı. Reddederse redaction'ın canlı yolu sınanmıyor.
- `gate:w7:agent` [5] uyarısı: Gemini tool çıktısının metnini vermiyor, "Permission denied" görülemiyor.
- Gemini'de tool kapısı **engellemiyor, saptıyor** (`--allowed-tools`); sınır dosya izinleriyle sağlanıyor.
