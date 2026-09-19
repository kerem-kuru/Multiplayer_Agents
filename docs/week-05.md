# Hafta 5 — Yazma yetkisi, kuyruk, kesme

**Biten iş (kapı):** İki kişi aynı agent'a aynı anda yazıyor, çakışma yok, agent kime cevap
verdiğini biliyor. Sürücülük iki tıkta devrediliyor.

Hafta 4'ün sonunda ikinci kişi odaya girip canlı izliyordu ama hiçbir şeye dokunamıyordu.
Bu hafta izleyici katılımcıya dönüştü. Zor kısım UI değil **eşzamanlılık**: iki mesaj paralel
inference'a girerse agent'ın context'i bozulur ve hata **sessizce** oluşur.

## Görev listesi

| # | Adım | Durum |
| --- | --- | --- |
| 1 | Roller: `owner` / `member` / `viewer` | ✅ davet iki rol üretiyor, varsayılan `member` |
| 2 | Migration 004 (kuyruk + sürücü) | ✅ `agent_queue_single_running` dahil |
| 3 | Yeni event'ler | ✅ 7 yeni tip, `turn.failed` sebebine `interrupted` |
| 4 | Kuyruk ve zamanlayıcı | ✅ 12 birim test, gerçek DB + sahte runner |
| 5 | Sürücü | ✅ 8 birim test |
| 6 | Kesme (runner tarafı) | ✅ `abort` yolu; streaming input'a geçilmedi (karar notu) |
| 7 | Sistem prompt'u: odada birden fazla insan | ✅ Claude yolunda; Gemini'de sistem prompt'u yok (bilinen sınır) |
| 8 | API | ✅ mesaj/kuyruk/sürücü/kesme uçları |
| 9 | Projeksiyon | ✅ `SNAPSHOT_VERSION` 2, snapshot doğruluğu yeni alanlarla geçiyor |
| 10 | UI | ✅ Composer her zaman açık, QueueList, DriverBadge, kesme düğmesi |
| 11 | Kapı script'i | ✅ `gate:w5` (sahte koşum ortamı) + `gate:w5:agent` |
| 12 | Cuma dogfood | ⏳ iki kişi gerekiyor |
| 13 | README | ✅ |

## Tek koşan garantisi: üç katman, üçü de gerekli

```
1. bellekte agent başına promise zinciri   → tick aynı anda iki kez koşmaz
2. FOR UPDATE SKIP LOCKED                  → iki seçici aynı satırı alamaz
3. agent_queue_single_running (kısmi uniq)  → DB ikinci 'running' satırı REDDEDER
```

Üçüncüsü son sözü söylüyor ve testte bir kez **ihlal denenip reddedildiği** doğrulandı.
Birinci ve ikinci katman kodun dikkatine dayanır; üçüncüsü dayanmaz.

## Ölçerek bulunan hata: FIFO `enqueued_at` ile çalışmıyor

Kuyruk sırası ilk hâlde `ORDER BY enqueued_at, id` idi. 10 paralel `enqueue` ile koşturulan
birim test **sırayı bozuk** buldu: iki satır aynı mikrosaniyeye düştü ve sıra rastgele
UUID'ye kaldı — yani koşma sırası kuyruğa giriş sırasından farklı çıktı.

Tahminle yazılsa fark edilmezdi: iki kişi elle yazarken bu yarış neredeyse hiç görünmez.
Çözüm `agent_queue.ord` (artan sayaç); eşitlik artık imkânsız.

İkinci benzer hata presence tarafında çıktı (Hafta 4 borcu kapatılırken): `touched` alanı
`Date.now()` idi ve aynı milisaniyede iki sekme bakış değiştirdiğinde **eski** sekme
kazanıyordu. Sıra sorusunun cevabı duvar saati değil monoton sayaç.

## Kesme: iki event, sıfır olmayan bir aralık

```
interrupt.requested   → istek anında yazılır (sürücü bastı)
        │
        ├─ runner'a sinyal (abort / SIGTERM)
        │
interrupt.applied     → gerçekten durdu (mode: graceful | abort | hard_kill)
turn.failed           → reason: "interrupted"
```

UI aradaki süreyi **"Kesme istendi — agent şu an bir komutu bitiriyor"** olarak gösterir.
Uzun bir bash komutunun ortasında anlık durdurma sözü verilmiyor; 30 saniyede kapanmayan
turn için sert kesme var (`mode: hard_kill`) ve turn `interrupted` ile kapanır.

Kesilen mesaj **yeniden koşmaz**. İptal edilen, sunucu yeniden başlatmasıyla düşen mesaj da
koşmaz — Hafta 2'den gelen kural: agent işin yarısını yapmış olabilir.

## Sürücülük bir rol, kilit değil

Sürücü olmayan `member` odayı kullanmaya devam eder: mesaj yazar, kuyruğa girer, kendi
kaydını iptal eder. Sürücünün fazladan iki yetkisi var — koşan turn'ü kesmek ve başkasının
kuyruk kaydını iptal etmek.

- Devir **iki tık**: "Devret" → kişi seç. Aday listesini sunucu süzüyor (izleyici olamaz:
  kesme yetkisini yazma yetkisi olmayana vermek olurdu).
- `version` iyimser kilit: ekranda gördüğün sürücü artık başkası olabilir ve devir sessizce
  onun üstüne yazmamalı → `409`.
- Odaya ilk yönergeyi yazan kişi, sürücü boşsa **otomatik** sürücü olur. Sürücü varsa
  sessizce vazgeçilir: mesaj göndermek sürücülük kavgası açmamalı.
- Sürücünün presence'ı 60 saniye kayıpsa sürücülük düşer (`driver.released`, `left_room`).
  Presence geri gelirse sayaç **sıfırlanır** — her F5 sürücülüğü elinden almasın.

## Kapı neden gerçek agent'sız koşuyor

`gate:w5` sunucuyu `AGENT_FAKE_RUNTIME=1` ile kaldırıyor: hiçbir modele istek gitmiyor,
turn'ü N ms sonra bitiren bir sahte koşum ortamı devreye giriyor. Gerçek DB, gerçek kuyruk,
gerçek event log, gerçek SSE, gerçek yetki — sadece model yok.

Gerekçe: bu haftanın kanıtlaması gereken şey model çıktısı değil **sıralama**. Gerçek
agent'la ölçmek pahalı, yavaş ve yarış penceresini daraltıyor; sahte runner'la 5 paralel
mesaj yarış penceresini gerçeğinden **geniş** yapıyor ve kapı saniyeler içinde koşuyor.

Gerçek agent'ın kanıtlaması gereken iki şey ayrı kapıda (`gate:w5:agent`, iki istek harcar):
modelin `[İsim]: ` etiketini okuyup kime cevap verdiğini söylemesi ve **gerçekten koşan** bir
işin ortasında kesilme.

Sahte ortam `NODE_ENV=production` iken kurulmaz ve sunucu açılışta ekrana
`koşum ortamı SAHTE` yazar: sessizce sahte cevap veren bir sunucu, hiç cevap vermeyenden
kötüdür.

## Kaldırılan iki event

`driver.changed` ve `agent.interrupted` (Hafta 1 kataloğundan, hiç yazılmamış) kaldırıldı.
Bu haftanın `driver.claimed` / `driver.released` / `driver.handed_off` ve
`interrupt.requested` / `interrupt.applied` event'leriyle örtüşüyorlardı; iki üst üste binen
event tipi, ileride yanlışını yazmak için duran bir tuzaktır.

`PROTOCOL_VERSION` 2'ye çıktı: runner protokolü `interrupt` komutu kazandı, bayat bir oda
imajı sessizce değil açıkça düşsün (`npm run room:build` gerekir).

## Şemadan bir sapma

Görev tanımı `message.cancelled.by` alanını zorunlu bir kullanıcı olarak tanımlıyordu, ama
aynı event'in sebep listesinde `server_restart` ve `agent_failed` var — o iptalleri bir insan
yapmıyor. Alan `nullable` yapıldı; kaydın sahibini "iptal eden" diye yazmak log'u yalancı
yapardı.

## Kalan iş

- **Streaming input'a geçilmedi.** Kesme `abortController` ile yapılıyor (`mode: "abort"`).
  Görev tanımı bu yolu açıkça izin veriyor; gerekçe karar notlarında.
- **Gemini'de sistem prompt'u yok**: rol YAML'ındaki `system_prompt` ve çok kişili oda notu
  Gemini agent'ına ulaşmıyor (CLI'da karşılık gelen bir bayrak yok, `GEMINI.md` yolu
  kurulmadı). Gemini agent'ı kimin yazdığını yalnızca mesajın başındaki `[İsim]: `
  önekinden anlar.
- **`gate:w2` hâlâ koşulmadı** (Claude anahtarı yok) — Hafta 2'den kalan boşluk.
- Hafta 5 dogfood iki kişi gerektiriyor.
