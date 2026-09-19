-- 004_queue_driver.sql — Hafta 5: yazma yetkisi, mesaj kuyruğu, sürücü
--
-- Bu haftanın tek cümlelik özeti: İKİ KİŞİ AYNI AGENT'A YAZABİLİR ama iki
-- mesaj asla paralel inference'a girmez. Sıralamayı sunucu garanti eder ve
-- garanti KODA BIRAKILMAZ — aşağıdaki kısmi unique index son sözü söyler.

-- ── Roller ──────────────────────────────────────────────────────────────────
-- Hafta 4'te iki rol vardı (owner, viewer) ve izleyici hiçbir şeye
-- dokunamıyordu. Araya `member` giriyor: kuyruğa mesaj ekler, kendi kaydını
-- iptal eder, sürücülüğü alır/devreder, sürücüyken keser. Oda ayarları,
-- davet ve agent start/stop yine yalnızca `owner`.
ALTER TABLE room_members DROP CONSTRAINT IF EXISTS room_members_role_check;
ALTER TABLE room_members
  ADD CONSTRAINT room_members_role_check CHECK (role IN ('owner', 'member', 'viewer'));

-- Davet artık iki rol üretebilir. Varsayılan `member`: Hafta 4 dogfood'unda
-- odaya giren ilk kişinin ilk sorusu "neden yazamıyorum" oldu.
ALTER TABLE room_invites DROP CONSTRAINT IF EXISTS room_invites_role_check;
ALTER TABLE room_invites
  ADD CONSTRAINT room_invites_role_check CHECK (role IN ('member', 'viewer'));

-- ── Kuyruk ──────────────────────────────────────────────────────────────────
-- KUYRUK DB'DE, bellekte değil: sunucu yeniden başlayınca bekleyen mesajlar
-- kaybolmasın ve kuyruk HERKESE aynı görünsün. Bellekteki bir dizi ikinci
-- kullanıcıya görünmez ve çökmede uçar.
--
-- Bu tablo event log DEĞİL; kuyruğun güncel durumu. Tarihçenin cevabı her
-- zaman session_events (message.queued / message.cancelled / message.received).
CREATE TABLE IF NOT EXISTS agent_queue (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id     UUID NOT NULL REFERENCES rooms(id),
  agent_name  TEXT NOT NULL,
  -- Event'lerdeki messageId ile AYNI değer: kuyruk kaydı ile turn arasındaki
  -- bağ bu. UNIQUE, çünkü bir mesaj iki kez kuyruğa girmez.
  message_id  UUID NOT NULL UNIQUE,
  user_id     UUID NOT NULL REFERENCES users(id),
  -- Kullanıcının yazdığı HAM metin. `[Ayse]: ` öneki burada DEĞİL, runner'a
  -- verilirken eklenir.
  text        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued'
              CHECK (status IN ('queued','running','done','cancelled')),
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at  TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

-- Sıradaki mesajı seçen sorgunun index'i. FIFO: (enqueued_at, id).
CREATE INDEX IF NOT EXISTS agent_queue_pick
  ON agent_queue (room_id, agent_name, status, enqueued_at, id);

-- BU HAFTANIN EN ÖNEMLİ SATIRI.
-- Aynı agent'ta aynı anda yalnızca bir 'running' satır olabilir. Kodda bir
-- yarış durumu kalsa bile veritabanı ikinci `running` satırını REDDEDER.
-- `FOR UPDATE SKIP LOCKED` ile bu index birbirinin yedeği: biri kodda gözden
-- kaçan yarışı, diğeri son hatayı yakalar.
CREATE UNIQUE INDEX IF NOT EXISTS agent_queue_single_running
  ON agent_queue (room_id, agent_name) WHERE status = 'running';

-- ── Sürücü ──────────────────────────────────────────────────────────────────
-- Sürücülük bir KİLİT DEĞİL, bir ROL: sürücü olmayan da odayı kullanmaya
-- devam eder (mesaj yazar, kuyruğa girer); sadece koşan turn'ü kesemez ve
-- başkasının kuyruk kaydını iptal edemez.
CREATE TABLE IF NOT EXISTS agent_driver (
  room_id    UUID NOT NULL REFERENCES rooms(id),
  agent_name TEXT NOT NULL,
  -- NULL = sürücü yok. Oda açılırken her agent için NULL satır yazılır.
  user_id    UUID REFERENCES users(id),
  since      TIMESTAMPTZ,
  -- Devirde iyimser kilit: iki kişi aynı anda devretmeye çalışırsa biri 409.
  version    INT NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, agent_name)
);
