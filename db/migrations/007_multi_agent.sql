-- 007_multi_agent.sql — Hafta 7: ikinci agent ve worktree izolasyonu
--
-- SAPMA (görev tanımı Adım 11): tanım bu dosyayı `006_multi_agent.sql` olarak
-- ve `rooms.status` sütunu VARMIŞ gibi yazıyor:
--
--     ALTER TABLE rooms DROP CONSTRAINT rooms_status_check;
--
-- İkisi de tutmuyor. 006 numarası Hafta 6'da (`006_diff_reviews.sql`) alındı,
-- bu yüzden 007. Daha önemlisi `rooms` tablosunda `status` sütunu HİÇ
-- yaratılmamıştı — 001'deki o CHECK `sessions` tablosuna ait. Düşürülecek bir
-- kısıt yok; sütun kısıtıyla birlikte EKLENİYOR.

ALTER TABLE rooms ADD COLUMN IF NOT EXISTS repo_source JSONB NOT NULL DEFAULT '{"kind":"empty"}';
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS base_sha TEXT;

ALTER TABLE rooms ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'creating';
ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_status_check;
ALTER TABLE rooms ADD CONSTRAINT rooms_status_check
  CHECK (status IN ('creating','running','failed','stopped','archived'));

-- Hafta 7 öncesi odalar desteklenmiyor: bind mount üzerine kurulmuşlar, tek
-- Unix kullanıcısıyla koşmuşlar ve `safe.directory=*` ile çalışmışlar. Yeni
-- izolasyonu görmeleri mümkün değil. `archived` işaretleniyor ki sweeper
-- onları "running ama container'ı yok" diye yeniden diriltmeye çalışmasın.
-- Migration tek işlemde koştuğu için bu UPDATE yalnızca mevcut satırlara değer.
UPDATE rooms SET status = 'archived';

ALTER TABLE agent_runtime ADD COLUMN IF NOT EXISTS uid INT;
ALTER TABLE agent_runtime ADD COLUMN IF NOT EXISTS branch TEXT;

-- Bir odada iki agent aynı uid'i alamaz: alırsa birinin dosyaları diğerinin
-- olur ve izolasyon sessizce çöker. uid NULL olan eski satırlar birbirini
-- engellemez (Postgres NULL'ları ayrı sayar).
CREATE UNIQUE INDEX IF NOT EXISTS agent_runtime_uid ON agent_runtime (room_id, uid);

-- Okunmamış takibi. Event log'a YAZILMAZ: bu kullanıcıya özel bir durum,
-- odanın ortak tarihi değil.
CREATE TABLE IF NOT EXISTS agent_reads (
  user_id       UUID NOT NULL REFERENCES users(id),
  room_id       UUID NOT NULL REFERENCES rooms(id),
  agent_name    TEXT NOT NULL,
  last_seen_seq BIGINT NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, room_id, agent_name)
);
