-- Hafta 6 — diff tabanı, checkpoint'ler ve satır yorumları.
--
-- `checkpoints` ve `reviews` tabloları Hafta 5'teki `agent_queue` gibidir:
-- İŞLETİM İÇİN OTORİTE, UI'a giden bilgi event'lerden gelir. AgentManager
-- `checkpoint.created` event'ini yazarken aynı transaction'da `checkpoints`
-- satırını da ekler; ikisi ayrı düşerse "hangi taban" sorusunun iki cevabı
-- olurdu.
--
-- NOT: görev tanımı bu dosyayı 005 diye adlandırıyor; 005 Hafta 5'te
-- `005_driver_backfill.sql` tarafından alınmıştı.

-- Agent'ın CANLI diff tabanı. NULL = taban henüz alınmadı (agent hiç
-- başlatılmadı) ve runner canlı diff yayımlamaz.
ALTER TABLE agent_runtime ADD COLUMN IF NOT EXISTS diff_base_checkpoint_id TEXT;

CREATE TABLE IF NOT EXISTS checkpoints (
  id          TEXT PRIMARY KEY,                 -- "cp_" + 12 hex
  room_id     UUID NOT NULL REFERENCES rooms(id),
  agent_name  TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('baseline','manual','turn')),
  label       TEXT NOT NULL,
  commit_sha  TEXT NOT NULL,
  tree_sha    TEXT NOT NULL,
  -- Turn checkpoint'inde dolu: hangi mesajdan sonra alındı.
  message_id  UUID,
  -- Manuel checkpoint'te dolu: kim aldı. baseline/turn'de NULL — o
  -- checkpoint'i bir insan almadı ve birini yazmak log'u yalancı yapardı.
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS checkpoints_agent
  ON checkpoints (room_id, agent_name, created_at DESC);

-- Bir inceleme = aynı kişinin aynı anda gönderdiği N satır yorumu, TEK turn.
--
-- `comments` JSONB: agent'a giden metin bu kayıttan SUNUCUDA kuruluyor.
-- İstemci hazır prompt göndermiyor — gönderseydi "agent'a ne söylendiği"
-- istemcinin insafına kalırdı.
CREATE TABLE IF NOT EXISTS reviews (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id     UUID NOT NULL REFERENCES rooms(id),
  agent_name  TEXT NOT NULL,
  author_id   UUID NOT NULL REFERENCES users(id),
  -- [{commentId, path, side, line, lineText, body}]
  comments    JSONB NOT NULL,
  message_id  UUID NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reviews_agent
  ON reviews (room_id, agent_name, created_at DESC);

-- Kuyruk kaydı düz mesaj mı inceleme mi. Varsayılan 'message': var olan
-- satırlar olduğu gibi kalır.
ALTER TABLE agent_queue ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'message';
ALTER TABLE agent_queue ADD COLUMN IF NOT EXISTS review_id UUID REFERENCES reviews(id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_queue_kind_check'
  ) THEN
    ALTER TABLE agent_queue
      ADD CONSTRAINT agent_queue_kind_check CHECK (kind IN ('message','review'));
  END IF;
END $$;

-- Yorumun durumu (çözüldü / yeniden açıldı) İNSAN KARARIDIR ve event log'dan
-- okunur; ayrı bir tablo tutulmuyor. Projeksiyon `comment.resolved` /
-- `comment.reopened` event'lerinden hesaplıyor — tek gerçek kaynak log.
