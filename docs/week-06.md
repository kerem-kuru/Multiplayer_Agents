# Hafta 6 — Diff görünümü ve satır yorumu

**Biten iş (kapı):** Bir satıra "bunu böl" yazılıyor, agent düzeltiyor, ikinci kullanıcı
bunu canlı görüyor. Kimse terminale komut yazmadı.

Hafta 5'in sonunda iki kişi aynı agent'a yazabiliyordu ama konuştukları şey bir
**transkript**ti. Bu hafta konuşmanın konusu **kod** oldu: agent'ın değiştirdiği satırlar
herkesin ekranında güncelleniyor ve insanlar satırın kendisine yorum bırakıyor.

## Görev listesi

| # | Adım | Durum |
| --- | --- | --- |
| 1 | Workspace'i depoya çevir, tabanı al | ✅ taban agent'ın ilk başlangıcında, sunucu tarafından |
| 2 | Korumalı git çağrısı (`gitkit/git.ts`) | ✅ `hooksPath=/dev/null`, `fsmonitor=false`, `safe.directory=*` |
| 3 | Geçici index ile ağaç ve checkpoint | ✅ `.git/rooms-index`; branch, HEAD, index, çalışma ağacı değişmiyor |
| 4 | Dosya bazlı diff | ✅ added/modified/deleted/renamed/binary, 32 KB kırpma |
| 5 | Yeni event'ler | ✅ `diff.updated`, `comment.on_line`, `review.submitted`, `comment.resolved`, `comment.reopened`, `checkpoint.created` |
| 6 | Runner: canlı diff yayımı | ✅ tek yayımcı, iki koşum ortamı ortak |
| 7 | Migration 006 | ✅ `checkpoints`, `reviews`, `agent_queue.kind/review_id`, `agent_runtime.diff_base_checkpoint_id` |
| 8 | İnceleme → agent metni | ✅ saf fonksiyon, metin SUNUCUDA kuruluyor |
| 9 | İnceleme ve yorum API'si | ✅ `member`+ yazar, `viewer` yalnızca görür |
| 10 | Checkpoint ve isteğe bağlı diff API'si | ✅ 30 sn önbellek, anahtarda ağaç sha'sı var |
| 11 | Projeksiyon | ✅ diff, checkpoint, yorum ve çapa durumları |
| 12 | UI: Diff sekmesi | ✅ `DiffView`, `DiffFile`, `LineComment`, `ReviewTray`, `CheckpointPicker` |
| 13 | Kapı script'i | ✅ `gate:w6` **13/13** (modelsiz) · `gate:w6:agent` **12/12** (üç turn) |
| 14 | Cuma dogfood | ⬜ iki kişi gerekiyor |
| 15 | README | ✅ |

**329 test** (Hafta 5 sonunda 233'tü). İmajdaki git: **2.39.5**.

## Neden host'ta git çalışmıyor

Agent'ın workspace'i **düşman bir depo** sayılır: agent oraya `.git/hooks/post-commit`
yazabilir veya `core.fsmonitor = touch /tmp/pwned` ekleyebilir. Host bu depoda `git`
çalıştırsaydı, agent'ın yazdığı kod **host'ta ve host'un yetkileriyle** çalışırdı.

Bu yüzden git yalnızca container içinde koşuyor; sunucu ona `docker exec` ile ulaşıyor:

```
apps/api            →  docker exec node /opt/runner/gitkit/dist/gitkit.js <komut>
packages/runner     →  aynı kodu import ediyor (tek uygulama, iki giriş noktası)
```

Kapının 4. kontrolü bunu statik olarak da ölçüyor: `execFile("git"` araması yalnızca
`packages/gitkit/src/git.ts` dönmeli. Kural bir **güvenlik** kuralıdır, performans kuralı
değil; "host'ta çalıştırmak daha kolay olurdu" bir gerekçe değildir.

Korumalı çağrı dört bayrakla yapılıyor:

```
-c core.hooksPath=/dev/null   ekilmiş hook çalışmaz
-c core.fsmonitor=false       ekilmiş fsmonitor komutu çalışmaz
-c safe.directory=*           bind mount'ta uid eşleşmiyor; olmadan git reddediyor
```

## Checkpoint depoya dokunmuyor

Checkpoint = bir ağaç nesnesi + onu tutan bir commit + `refs/rooms/checkpoints/<id>` altında
bir ref. Agent'ın branch'i, `HEAD`'i, `.git/index`'i ve çalışma ağacı **değişmez** — ağaç
ayrı bir index dosyasıyla (`.git/rooms-index`) üretiliyor.

Ref'ler bilinçli: `git gc` nesneleri silmesin diye. Geçici index de bilinçli olarak
**kalıcı**; her seferinde silinse sonraki `add -A` bütün dosyaları yeniden hash'lerdi.

Kapının 3. kontrolü checkpoint öncesi/sonrası `rev-parse HEAD`, `status --porcelain` ve
`.git/index`'in md5'ini karşılaştırıyor. Üçü de aynı.

## Taban: "diff neye göre" sorusunun tek cevabı

Taban checkpoint'i agent'ın **ilk** başlatılmasında, runner'dan **önce**, sunucu tarafından
alınır ve `agent_runtime.diff_base_checkpoint_id`'de durur.

Runner kendi tabanını üretseydi agent her yeniden başlatıldığında taban kayardı ve önceki
turn'lerin değişiklikleri sessizce kaybolurdu.

**Tuzak:** workspace'e sonradan elle kopyalanan dosyalar agent değişikliği gibi görünür.
Sıfırlamak için manuel checkpoint alınır (taban oraya kayar). Kapı script'i de fixture'ı
agent'ı başlatmadan **önce** kopyalıyor; sonra kopyalasaydı bütün proje diff'e düşerdi.

Taban alınamazsa agent **yine başlar**: diff bir sunum katmanı, agent'ın çalışmasının
önkoşulu değil. Yalnızca canlı diff yayımlanmaz ve sebep log'a yazılır.

## Canlı diff: hook hesaplamaz

```
tool çağrısı → PostToolUse → publisher.markDirty()   (sadece bayrak)
                                    │ 300 ms debounce
                                    ▼
                            git add -A (geçici index) → ağaç → diff → diff.updated
turn sonu   → publisher.flush()  (beklenir: "hangi turn'ün işi" sorusu cevapsız kalmasın)
```

Her `Edit` çağrısında tam bir diff koşturmak on dosyaya dokunan bir turn'de agent'ı
bekletirdi. Yayım **artımlı**: dosya başına parmak izi tutuluyor, değişmeyen dosya ikinci
kez gönderilmiyor. Bütçeyi (256 KB) aşan dosyalar ertelenir ve parmak izleri
işaretlenmez — sonraki turda tekrar giderler.

Sınırlar: patch başına **32 KB** (aşarsa `truncated: true`), event başına **256 KB**,
1000 satırdan uzun ve üretilmiş dosyalar (`*.lock` vb.) kapalı başlar.

**Diff'i yalnızca runner yayımlar.** Kapının modelsiz bölümü bu yüzden canlı yayımı
ölçemiyor: tetik bir tool çağrısı, tool çağrısı da modele bağlı. Modelsiz kapı diff
doğruluğunu isteğe bağlı diff ucundan (`GET .../diff?from=<checkpointId>`) ölçüyor — aynı
gitkit, aynı container, yayım yolu olmadan.

## Yorum çapası: satır numarası değil, numara + metin

Agent araya üç satır eklerse 42. satır artık başka bir satırdır. Yalnızca numaraya güvenmek
yorumu **sessizce** yanlış yere taşır. Çapa bu yüzden ikisini birden tutuyor:

| Durum | Ne zaman | UI'da |
| --- | --- | --- |
| `current` | aynı numarada aynı metin | satırın altında |
| `moved` | metin dosyada başka **tek** bir satırda | yeni satırın altında, "satır yer değiştirdi" etiketiyle |
| `outdated` | metin yok, ya da **birden çok** kez geçiyor | dosyanın altında "Eskimiş yorumlar", alıntıyla |

Belirsizlik (`hits.length > 1`) bilerek `outdated` sayılıyor: iki adaydan birini seçmek
yanlış satıra yapışmanın kibar hâli olurdu.

## İnceleme → agent metni: sunucuda kurulur

```
POST /rooms/:id/agents/:aid/reviews   { comments: [{ path, side, line, lineText, body, diffSeq }] }
        │  member+; viewer 403
        │  lineText diff ile doğrulanır (uyuşmazsa 400)
        ▼
comment.on_line ×N  →  review.submitted  →  message.queued (kind: review)
        │
        ▼  kuyruk sırası geldiğinde — Hafta 5'in kuyruğu, ayrı yol değil
message.received.text:

    Diff üzerine 2 satır yorumu:

    1) src/order.js:14
       > function processOrder(order, db) {
       bunu böl

    Her yorumu uygula. Uygulayamadığın veya katılmadığın bir yorum varsa,
    numarasıyla birlikte nedenini yaz.
    Satır numaraları yorumun yazıldığı andaki haline göredir; satır yer
    değiştirmiş olabilir, alıntılanan metni esas al.
```

İstemci **hazır prompt göndermiyor**. Gönderseydi "agent'a ne söylendiği" tarayıcının
insafına kalırdı ve event log'daki metinle gerçekte gönderilen ayrışabilirdi.

`[İsim]: ` öneki bu metne girmiyor; onu kuyruk runner'a verirken koyuyor (Hafta 5 kuralı:
event log'daki metin **ham** kalır).

Yorumlar dosya yoluna, sonra satır numarasına göre sıralanıyor — agent dosyada yukarıdan
aşağı ilerlesin, oraya buraya zıplamasın diye.

## Kapı neden ikiye bölündü

`gate:w6` **hiç model isteği harcamıyor.** Agent başlatılıyor (taban checkpoint'i orada
alınıyor) ama runner'ın ayağa kalkması modele gitmiyor; dosya değişiklikleri `docker exec`
ile yapılıyor ve diff isteğe bağlı diff ucundan okunuyor.

`gate:w6:agent` üç gerçek turn koşuyor ve **kotayı yiyor**: Gemini ücretsiz katmanında
günlük sınır 20 **model isteği** — turn değil. Tool çağıran tek bir agentic turn modele
birkaç kez gidiyor. Anahtar yoksa atlar, başarısız saymaz.

Ölçtüğü şeyler modelsiz ölçülemez: canlı `diff.updated`, artımlı yayım (arka arkaya iki
gerçek turn gerekiyor) ve **yorumdan düzeltmeye geçen süre** — haftanın vaadi bu.

## Ölçülen sayı: yorumdan düzeltmeye 13,7 saniye

Haftanın vaadi buydu ve `gate:w6:agent` onu sayıyla kapatıyor. Son koşum
(Gemini, `gemini-3.1-flash-lite`):

| Ölçüm | Değer |
| --- | --- |
| `review.submitted` → sonraki `diff.updated` | **13,7 sn** (eşik: 30 sn uyarı, 60 sn başarısız) |
| `src/order.js` içindeki `function` sayısı | 1 → **3** (agent gerçekten böldü) |
| Yorumun çapası | `moved`, satır **15 → 53** |
| Turn başına checkpoint | 4 turn, 4 turn checkpoint'i |

## Kapı üç koşumda kendi üç hatasını buldu

Hiçbiri üründe değildi; üçü de "ölçtüğümü sandığım şey" ile "gerçekten
ölçtüğüm şey" arasındaki fark:

1. **Yorum satırı workspace dosyasından seçiliyordu.** İnceleme *"src/order.js:15
   diff'te böyle bir satır yok"* ile reddedildi — haklı olarak: unified diff
   yalnızca hunk'ları taşır. Yorum yalnızca diff'te görünen satırlara bırakılır,
   yani kapı da satırı **patch'ten** seçmeli.
2. **SSE probe'ları dosyayı ancak süre dolunca yazıyor.** Uzun süreli iki probe
   başlatıp ortada okumak "dosya yok" demekti. Probe'lar artık `--since 0` ile
   geçmişi tekrar oynatıyor.
3. **Durum `/rooms/:id/snapshot`'tan okunuyordu.** O uç SAKLANAN snapshot'ı
   döndürür, canlı durumu değil. Bir koşumda yorum seq 48'de yazıldı, snapshot
   seq 34'te kalmıştı ve kapı "projeksiyonda yorum yok" dedi. Ürün doğruydu.
   `scripts/room-view.mjs` eklendi: snapshot + sonraki event'ler → `project()`,
   yani **tarayıcının yaptığının aynısı**. İki kapı da onu kullanıyor.

Çapa kontrolü de sabit beklentiden çıkarıldı. Görev tanımı "current kalırsa
başarısız" diyor; bu, agent'ın satırı kaydırmasını varsayıyor ve gerçek modelde
bu bir şans işi. Ölçülen şey artık: projeksiyonun çapa kuralı patch'in
gerçeğiyle aynı sonucu veriyor mu.

## Kapsam dışı bırakılanlar (bilerek)

Sözdizimi renklendirme, yan yana görünüm, yorum dizileri, emoji tepkileri, "önerilen
değişiklik" blokları, hunk bazında kabul/ret, diff'te olmayan dosyaya yorum, agent'ın
yorumu otomatik çözmesi. Yorum durumu bir **insan** kararıdır; agent cevabında uyguladığını
söyleyebilir ama yorumu kapatamaz.
