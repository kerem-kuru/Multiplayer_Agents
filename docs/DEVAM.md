# Kaldığımız yer — 24 Eylül 2026, gece yarısı

Bu dosya oturum devir notudur. Yeni bir oturum **buradan** başlar.

## Proje ne, neden

Bir **oda**, içinde birden çok agent barındıran izole bir container'dır. Odaya giren birden
çok geliştirici aynı anda bu agent'lara görev verir, işlerini canlı izler, yönlerini
değiştirir.

> **Tez:** Gerçek birim agent değil, her agent'ın okuyup yazdığı **tek paylaşılan bağlam
> deposudur.** Agent'lar birbirine mesaj atmaz; ortak oda defterine yazar ve oradan okur.

**Ölçülecek tek metrik:** aynı oturuma iki farklı insanın yazdığı oturum sayısı, haftalık.

12 haftalık plan `docs/roadmap.md` içinde. Haftalık görev tanımları Downloads klasöründeki
`HAFTA-<N>-GOREV.md` dosyalarından geliyor (Hafta 7 için `HAFTA-7-GOREV (1).md`).

## Durum

| Hafta | Konu | Durum |
| --- | --- | --- |
| 1 | İskelet ve event log | ✅ `gate` 10/10 (volume) |
| 2 | Tek agent, headless koşum | ⏳ `gate:w2` **koşulmadı** (Claude anahtarı yok) |
| 3 | Stream ve terminal görünümü | ✅ `gate:w3` 11/11 |
| 4 | Redaction ve ikinci izleyici | ✅ `gate:w4` 22/22 |
| 5 | Yazma yetkisi, kuyruk, kesme | ✅ `gate:w5` 25/25 |
| 6 | Diff görünümü ve satır yorumu | ✅ `gate:w6` 13/13 · dogfood ✅ |
| 7 | **İkinci agent ve worktree izolasyonu** | 🔶 **`gate:w7` 93/93 · agent kapısı + dogfood kaldı** |

**436 test**, `npm run typecheck` temiz. Paketler: `protocol`, `redact`, `view`, `gitkit`,
`core`, `runner`, `runner-gemini`.

---

## Hafta 7 — nerede kaldık

**Adım 1–15 ve 17 kod olarak bitti.** Kalanlar:

| # | İş | Neye bağlı |
| --- | --- | --- |
| 1 | **`npm run gate:w7:agent`** koşulacak — yazıldı, HİÇ KOŞULMADI | Gemini kotası (TSİ ~10:00 sıfırlanır) |
| 2 | **Adım 16 dogfood** — iki kişi, API ucu backend'de, ekran frontend'de, sözleşme `contracts/`'ta | Kerem + ikinci kişi |
| 3 | README "Hafta 7 dogfood notları" (4 soru görev tanımında) + yol haritasında Hafta 7 ✓ | 1 ve 2 |
| 4 | **Push** — 23 Eylül gecesinin 6 commit'i yerel, `origin/main` hâlâ `0c060fa` | Kerem'in onayı |

**Açık bulgu (24 Eylül 00:45, elle test): Google'ın 503'ü ekranda GÖRÜNMÜYOR.** Model
`gemini-3.5-flash`'a alındıktan hemen sonra iki agent'ın turn'ü de "çalışıyor"da asılı kaldı.
Sebep kod değil: Google her isteğe `503 This model is currently experiencing high demand`
(arada `fetch failed`) döndü; Gemini CLI hata vermek yerine backoff'la tekrar deniyor.
Container'ın ağı sağlamdı, `429` yoktu. **Kusur bizde:** "Attempt N failed with status 503"
satırları yalnızca sunucu logunda (runner stderr). Kullanıcı 4+ dakika boyunca sebebini
bilmeden bekledi — Hafta 4'teki "sebep ekranda yazar" dersinin aynısı. Düzeltme (Kerem
"sonra" dedi): runner stderr'deki deneme satırlarını bir event'e çevir, kartta ve Özet'te
"Google yoğun (503) · 3. deneme" yaz. Runner değişeceği için `npm run room:build` gerekir.

**Model kararı:** Kerem 24 Eylül gecesi `.env`'i `AGENT_MODEL=gemini-3.5-flash` ve
`ROOM_CONFIG=config/room.week7.yaml` yaptı (API ve arayüz bununla yeniden başlatıldı).
Önceki not: dogfood `gemini-3.5-flash` ile mi (öneri — `flash-lite` araç
çağırmak yerine metin yazıyordu), `flash-lite` ile mi. `.env`'deki `AGENT_MODEL` YAML'ı ezer.

### Yarının ilk işi: `gate:w7:agent`

```bash
# TSİ 10:00'dan sonra, kota tazeyken. İki agent'a AYRI model veriyor (kotaları ayrı):
npm run gate:w7:agent
# varsayılanlar: GATE_FRONTEND_MODEL=gemini-3.5-flash GATE_BACKEND_MODEL=gemini-3.1-flash-lite
```

~11 turn, ~20+ model isteği. Ölçtükleri: [5] agent'ın kendisi izin hatası alıyor, [8]
örtüşen turn'ler, [9] turn ortasında kill -9, [10] path_overlap + cleared, [11-12]
contracts_race + içeriksiz event, [13] turn sonu denetimi, Playwright [17, 18, 21].
Script'te `warn` = model araç çağırmadı (model davranışı, geçti SAYILMAZ, kaldı da sayılmaz);
turn `429` ile düşerse kapı bunu ayrıca yazıyor. **İlk koşuda kapının kendi hataları
çıkabilir** — `gate:w7` ilk koşusunda 3 tane çıktı (hepsi ölçüm hatası, ürün değil).

---

## 23 Eylül gecesi ne yapıldı

### `gate:w7` — 93 kontrol, model isteği harcamaz

`scripts/week7-gate.sh`. İzin matrisi kodda tablo (16 satır, döngü). Kurulum 1-3, matris +
G3, sözleşme ucunda symlink, G1-G7, [6] üçüncü agent, [7] geçersiz config → 400, [9] kill
-9 ile çökme yalıtımı (modelsiz: frontend aynı süreç kalıyor), [13] sunucu denetimi, [14-15]
silme + sweeper, Playwright [16, 17, 19, 20] (`apps/web/tests/week7.spec.ts`).

`GATE_W7_REGRESSION=1 npm run gate:w7` → **98 geçti, 0 kaldı** (93 + gate 10/10, w3 11/11,
w4 22/22, w5 25/25, w6 13/13 — hepsi volume tabanlı). Windows Docker Desktop'ta koştu, yani
DoD'deki "Linux dışı makinede" maddesi de ölçüldü.

### Bulunan ve düzeltilen hatalar

| Hata | Sonuç |
| --- | --- |
| **Sözleşme okuma ucu symlink ile izolasyonu deliyordu** (`GET /rooms/:id/contracts/*` root ile `cat`). Frontend `contracts/leak -> backend/secret.txt` yapınca uç backend'in dosyasını ve `/etc/shadow`'u döndürdü — canlı ölçüldü. | `nobody:rooms-contracts` + realpath (`packages/core/src/contracts-read.ts`), kapıda kontrol |
| Geçersiz config 500 dönüyordu | 400 + kural cümlesi, sunucu yolu sızmıyor |
| Özet sekmesi Adım 14'e uymuyordu ("Etkinlik" adı, turn'ler hep açık) | "Özet", turn'ler kapalı başlıyor, koşan açık; `summarizeTurn` |
| **Okunmamış işareti başka agent koşarken hiç sönmüyordu** (seen debounce'u her event'te sıfırlanıyordu) | throttle |
| Kapı: `taskkill //PID` NO_PATHCONV altında reddediliyordu → vite sızıp sonraki kapının build'ini düşürdü | `taskkill /PID` + port bazlı temizlik |
| Kapı: `MSYS_NO_PATHCONV` alt kapılara sızınca Hafta 6 kapısı `C:\c\Users\...` yoluna yazmaya çalıştı | alt kapılar `env -u MSYS_NO_PATHCONV` ile |

**Eskiyen probe:** `scripts/week7-fs-probe.mjs` 8. kontrolü "sistemde safe.directory YOK"
bekliyor; imajda artık bilinçli olarak tek kayıt var (`/room/repo.git`). Probe'lar kapıya
taşındı, yeniden koşulmaları gerekmiyor; koşulursa o satır düşer.

---

## Hafta 7, Gün 1–5'te ne yapıldı (22 Eylül ve öncesi)

### Üç mimari karar (README "Hafta 7 kararları"nda gerekçeleriyle)

1. **İzolasyon mount ile değil Unix kullanıcılarıyla.** Agent başına uid (10001+), worktree
   `0750`, `contracts/` setgid `2775`, merkez depo `rooms-integrator`'a ait.
2. **Bind mount yerine named volume.** Docker Desktop'ta bind mount üzerinde `chown` ve izin
   bitleri güvenilir çalışmıyor; izolasyon Linux'ta çalışıp Mac'te sessizce çalışmayabilirdi.
   **Bedeli:** host oda dosyalarını göremiyor, her inceleme `docker exec` ile
   (`scripts/lib/room-exec.sh`).
3. **`git worktree` yerine `git clone --shared`.** worktree'de tüm ağaçlar tek `.git`
   paylaşır; bir agent diğerinin branch'ini silebilir ya da ortak config'e hook ekleyebilirdi.

### Ölçülen sayılar

```
gate 10/10 · gate:w3 11/11 · gate:w4 22/22 · gate:w5 25/25 · gate:w6 13/13   (81 kontrol)
week7-fs-probe   11/11   (izin planı, canlı container)
week7-repo-probe 26/26   (merkez depo, klonlar, G1/G3/G4/G7)
week7-day4-probe 14/14   (izin kayması, oda silme, sweeper)
429 birim test
```

### `safe.directory` — kuralın istisnası ve gerekçesi

Değişmez Kural 9 `safe.directory=*`'ı yasaklıyor ve o yasak duruyor (gitkit'ten kaldırıldı).
Ama merkez depo tasarım gereği `rooms-integrator`'a ait ve agent ondan klonlamak zorunda;
git'in sahiplik kontrolü klonu reddediyor. **Ölçüldü:**

| Yöntem | Sonuç |
| --- | --- |
| düz `git clone` | `dubious ownership` |
| `git -c safe.directory=<yol>` | `dubious ownership` — git `-c`'den OKUMUYOR |
| `/etc/gitconfig`'de tek yol | çalışıyor |

Git bu ayarı yalnızca korumalı config'ten okur (bir depo kendini beyaz listeye alamasın
diye). İstisna imajda, **sistem düzeyinde, tek yol için**: `rooms/Dockerfile` içinde
`git config --system safe.directory /room/repo.git`. O deponun agent tarafından
yazılamadığı izin matrisinde ayrıca ölçülüyor.

### Görev tanımından sapmalar

| Sapma | Sebep |
| --- | --- |
| Migration `006` değil **`007`** | `006_diff_reviews.sql` Hafta 6'da alınmıştı |
| `rooms.status` DROP değil **ADD COLUMN** | Görev tanımı sütun varmış gibi yazıyor; `rooms`ta `status` hiç yaratılmamıştı (001'deki CHECK `sessions`'a ait) |
| `journal` artık **yazılamaz** | Mimari `journal`ı `root:root 0755` yapıyor; eski şema `writable: [journal]`e izin veriyordu |

---

## Koşturmadan bulunamayan beş hata (hepsi düzeltildi)

Bu liste yarın için önemli: aynı sınıf hatalar Adım 15'te de çıkabilir.

1. **Kapı kendi ölçümünü kirletiyordu.** Hafta 6 kapısı depoya `core.fsmonitor = touch
   /tmp/pwned` ekiyor ve "ürün tetiklemiyor" diyor. Hafta 7'de klon sonrası index dolu
   olduğu için **kapının kendi `git status`'u** fsmonitor'ü çalıştırdı. Ürün doğruydu,
   ölçen yanlıştı. `cgit` artık gitkit ile aynı bayrakları taşıyor.
   **Kural: bir kapı ekilmiş kodu test ediyorsa, kapının kendi okuma komutları da nötr olmalı.**
2. **`project()` bilinmeyen event'te `console.debug` ile STDOUT'a yazıyordu** ve
   `room-view.mjs`'in JSON çıktısını kirletiyordu. Uyarı stderr'e alındı.
3. **Oda düzeyi event'ler projeksiyonda işlenmiyordu.** `room.repo_initialized`,
   `conflict.detected`, `conflict.cleared` `agent` alanı taşımıyor ve
   `if (!agentName) continue` satırına takılıyorlardı — **çakışma uyarısı ekranda hiç
   görünmeyecekti.** `detectConflicts`in 9 birim testi yakalayamazdı: orada görünüm elle
   kuruluyor, event'lerden üretilmiyor. `week7-projection.test.ts` eklendi.
4. **Düzeltmeden sonra da görünmedi:** `SNAPSHOT_VERSION` artırılmamıştı, eski (hatalı)
   snapshot taban olarak kullanılmaya devam ediyordu. **Kod doğruydu, veri bayattı.**
   Sürüm 6. **Kural: görünümün ŞEKLİ değil DAVRANIŞI değişince de sürüm artar.**
5. **`ContractsWatcher` boş klasörde ilk sözleşmeyi duyurmuyordu.** "İlk tarama mı" sorusu
   harita boyutundan çıkarılıyordu ama `contracts/` boş başlıyor. Açık `baseline` bayrağı.

---

## Elle testte çıkan iki şey (22 Eylül gecesi, Kerem)

### 1. `GEMINI.md` SAHTE çakışma üretiyordu — düzeltildi

Ekranda şu yazıyordu: *"backend ve frontend aynı dosyayı değiştiriyor: GEMINI.md"* ve her
kart "1 dosya" gösteriyordu. `GEMINI.md` runner'ın her başlangıçta yazdığı rol bağlamı
dosyası — altyapı, agent'ın işi değil. İki agentlı odada ikisi de kendi kopyasını yazınca
`path_overlap` tetiklendi.

`GEMINI.md` ve `CLAUDE.md` artık `DEFAULT_EXCLUDES` içinde. Ölçüldü: önce 1 çakışma /
"1 dosya", sonra **0 çakışma / "0 dosya"**.

**İkinci faydası:** agent hiçbir şey yazmadığında kart artık "0 dosya" diyor. Önceden
gürültü yüzünden bir şey yazılmış gibi duruyordu.

### 2. Agent odanın yapısını bilmiyordu — düzeltildi

Backend agent'ı frontend'in kodunu kendi klasöründe aradı ve sordu: *"dosyaları görmem için
bana bir yol verebilir misin?"* **İzolasyon doğru çalışıyordu** — göremediği için göremedi.
Eksik olan, agent'ın içinde bulunduğu dünyayı bilmemesiydi: rol bağlamında `<rol>` literal
yazıyordu, mutlak yol yoktu, başka agent olduğundan söz edilmiyordu ve `contracts/`in ne işe
yaradığı yazmıyordu.

`roomLayoutNote()` eklendi (`packages/protocol/src/prompts.ts`); `ROOM_PEERS`,
`ROOM_CONTRACTS`, `ROOM_READABLE` ortamdan geliyor. **Kural 2 ihlali değil:** bu bir kısıt
değil yön tarifi — metin silinse davranış değişmez, agent sadece boşa turn harcar.

### Açık kalan gözlem: model araç kullanmıyor

Frontend agent'ı "index.html oluşturdum" dedi ama **turn'de tek bir `tool.call` yok** —
düz metinle cevap verdi. Aynı odada backend üç tool çağırdı, yani tool yolu çalışıyor
(`edit` → `write_file` eşlemesi doğrulandı). Bu **model davranışı**:
`gemini-3.1-flash-lite` ailenin en zayıfı ve araç çağırmak yerine yazmaya meyilli.

**Yarın karar verilecek:** dogfood hangi modelle? `.env`'deki
`AGENT_MODEL=gemini-3.1-flash-lite` satırı YAML'daki `model: auto`'yu eziyor.
`gemini-3.5-flash` kotayı daha hızlı yer ama Hafta 7'nin tezi "iki agent gerçekten dosya
yazsın" olduğu için dogfood'un anlamlı olma şansı yüksek. **Kerem'e soruldu, cevap
beklemede.**

---

## Makinede ne kaldı (24 Eylül, gece yarısı)

- **Push EDİLMEDİ:** 6 commit yerel (`origin/main` = `0c060fa`). Çalışma ağacı temiz.
- `postgres` (5433) + `redis` (6380) ayakta.
- **API 8787 ve arayüz 5173 ayakta ama BAYAT.** Makine 23 Eylül akşamı yeniden başlamış; bu
  süreçler bu gecenin düzeltmelerinden (symlink, 400, Özet, throttle) önce kalkmış ve
  `.env`'deki **tek agent'lı** `config/room.gemini.yaml` ile koşuyor olabilir. Elle test
  öncesi ikisini de yeniden başlat, API'yi `ROOM_CONFIG=config/room.week7.yaml` ile.
- 22 Eylül'deki "hazır oda" (`e58e8619…`) ÖLDÜ — container'ı yok. Yeni oda aç.
- 10 `room-*` volume duruyor; sweeper saatte bir topluyor.
- DB: `archived` 353, `failed` 323, `running` 8, `creating` 7.
- **`rooms-data/` (29 MB) hâlâ duruyor ve ÖLÜ.** Kerem "silme" dedi, dokunulmadı.

Yeni giriş bağlantısı gerekirse:

```bash
curl -s -X POST http://localhost:8787/auth/request \
  -H "Content-Type: application/json" -d '{"email":"keremkuru2007@gmail.com"}'
```

---

## Çalıştırma

```bash
npm run db:up                                     # postgres + redis
npm run build                                     # paketler
npm run room:build                                # ODA İMAJI — runner/gitkit değiştiyse ŞART
ROOM_CONFIG=config/room.week7.yaml node apps/api/dist/index.js    # API 8787
WEB_HOST=1 WEB_ALLOWED_HOSTS="192.168.1.114,localhost" npm run dev:web   # arayüz 5173

npm run gate / gate:w3 / gate:w4 / gate:w5 / gate:w6   # modelsiz, model isteği harcamaz
npm run gate:w7                                        # Hafta 7, 93 kontrol, modelsiz
GATE_W7_REGRESSION=1 npm run gate:w7                   # + Hafta 1-6 kapıları
npm run gate:w7:agent                                  # MODEL İSTER (~20 istek, iki model)
node scripts/room-view.mjs <oda> --base <url> --session <çerez>   # CANLI durum
```

**Gemini kotası** ücretsiz katmanda model başına günde **20 MODEL İSTEĞİ** — turn değil.
Tool çağıran tek bir agentic turn modele birkaç kez gidiyor. Pasifik gece yarısı
(≈ TSİ 10:00) sıfırlanıyor.

---

## Tuzaklar

Hafta 1–6 tuzakları geçerliliğini koruyor. Bu hafta eklenenler:

1. **`packages/runner*` veya `packages/gitkit` değiştiyse `npm run build` YETMEZ**,
   `npm run room:build` gerekir. `PROTOCOL_VERSION` bu hafta **4**'e çıktı: bayat imajla
   agent `stopped`da kalır.
2. **Sunucu süreci eski kodu koşar.** `npm run build` sonrası API'yi YENİDEN BAŞLAT. Bugün
   iki kez buna takıldık: bir kere `ROOM_PEERS` boş geldi, bir kere düzeltilmiş projeksiyon
   görünmedi. Port doluysa `taskkill //PID <pid> //F`.
3. **Snapshot bayatlığı.** Projeksiyonun davranışı değişince `SNAPSHOT_VERSION` artmalı,
   yoksa eski snapshot yanlış durumu taşımaya devam eder ve düzeltme "işe yaramadı" gibi
   görünür.
4. **Sweeper Hafta 7 öncesi odaların container'larını siler.** Migration 007 onları
   `archived` işaretledi; sweeper canlı olmayan odaların container'ını topluyor. Doğru
   davranış ama sürpriz olmasın.
5. **`docker exec` ve MSYS yol dönüşümü.** Git Bash `/room/...` yollarını
   `C:/Program Files/Git/room/...` yapıyor. `export MSYS_NO_PATHCONV=1` şart —
   `scripts/lib/room-exec.sh` bunu kendisi yapıyor.
6. **Kabuk heredoc'u backslash yiyor.** `python - <<'PY'` içine `\\n` ya da `\\` yazmak
   dosyada tek backslash bırakıyor ve TS/JS dosyasını sessizce bozuyor. Bugün altı kez
   ısırdı. **Kaçış içeren dosyaları Write aracıyla yaz**, heredoc'la değil.
7. **Windows'ta `MSYS_NO_PATHCONV=1` iki şeyi değiştirir.** (a) `taskkill //PID` artık
   `/PID`'e çevrilmez ve reddedilir — tek eğik çizgi yaz. (b) Bu değişken dışa aktarılmışken
   npm'in başlattığı bash `pwd`'yi `/c/Users/...` verir; node o yolu `C:\c\Users\...` okur.
   Bir kapıdan başka bir kapıyı `env -u MSYS_NO_PATHCONV npm run ...` ile çağır.
8. **Python heredoc'u Türkçe karakterleri bozuyor** (Windows kod sayfası). `ı`, `ş` içeren bir
   metni heredoc'taki Python ile aramak eşleşmiyor. Metni dosyaya Write ile yaz, satır
   numarasıyla `sed 'Nr dosya'` ile ekle. Python `open(..., 'w')` Windows'ta CRLF yazar;
   `.sh` dosyası CRLF olursa bash bozulur (`.gitattributes` repoda düzeltir, çalışma
   kopyasında düzeltmez).

---

## Bilinen ve kabul edilmiş sınırlar

- **Cloudflare hızlı tüneli SSE'yi TAMPONLUYOR.** Yerel ağ ve vite vekili sorunsuz.
- **Redaction agent'ın context'ini korumaz** — engellemek onay kuyruğunun işi (Hafta 10).
- **Gemini'de sistem prompt'u yok**: rol bağlamı `GEMINI.md` üzerinden gidiyor.
- **Gemini tool çıktısının metnini vermiyor**, sadece `status`.
- **Oda imajında ne varsa o var**: Node 22, Python 3 + `/opt/venv`, build-essential, git,
  ripgrep, curl. İmajdaki git **1:2.39.5-0+deb12u3**; Debian takipçisinde üç açık CVE var
  (2024-52005, 2018-1000021, 2022-24975), üçü de **"unimportant"** ve üçü de kötü niyetli
  bir UZAK sunucu gerektiriyor. Hafta 7'de tek uzak yol `repo.kind: "git"`.
- **Tek sunucu örneği varsayımı** — `AgentManager`, presence ve sürücü izleyicisi bellekte.
- **`npm audit`** dev bağımlılıklarında zafiyet bildiriyor.
- **Hafta 7 öncesi odalar desteklenmiyor.** Migration 007 hepsini `archived` işaretledi.

---

## Okuma sırası (yeni bir oturum buradan başlarsa)

1. Bu dosya
2. `README.md` — özellikle **"Hafta 7 kararları"** bölümü (üç karar, `safe.directory`
   istisnası, sapmalar, "kapı kendi ölçümünü kirletiyordu")
3. `Downloads/HAFTA-7-GOREV (1).md` — Adım 16 (dogfood) ve DoD listesi
4. `docs/roadmap.md` — 12 haftalık plan
5. `docs/week-01.md` … `docs/week-06.md` — hafta hafta ne yapıldı ve **neden**

## Çalışma tarzı (yeni oturum bunu bilmeli)

- Her adımın **kabul kriteri doğrulanmadan** sonrakine geçilmez; "çalışıyor gibi duruyor"
  yeterli değil, **ölçüm** gerekir.
- Birim test yeterli değilse **canlı container'da probe yaz** — bu hafta beş hata yalnızca
  öyle bulundu.
- Değişmez kurallarla çelişen bir kısayol gerekirse durup README "Karar notları"na yazılır.
- Kapsam dışı listesindeki hiçbir şeye "hazırlık" amacıyla bile başlanmaz.
- Her adım sonunda anlamlı bir commit; hafta sonunda kapı script'i + dogfood + README.
