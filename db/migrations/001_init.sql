-- 001_init.sql — Hafta 1: append-only omurga
--
-- Üç tablo yeter: rooms, sessions, session_events.
-- Geri kalan her şey (tasks, approvals, journal) bu log'un projeksiyonu olarak
-- ilerleyen haftalarda gelir. session_events'e UPDATE/DELETE yapılmaz.

CREATE TABLE IF NOT EXISTS rooms (
  id            uuid PRIMARY KEY,
  name          text        NOT NULL,
  repo_url      text,
  base_branch   text        NOT NULL DEFAULT 'main',
  -- Odanın açıldığı andaki rol konfigürasyonunun tamamı. YAML sonradan
  -- değişse bile bu oda kendi kopyasıyla çalışır.
  config        jsonb       NOT NULL,
  config_digest text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id           uuid PRIMARY KEY,
  room_id      uuid        NOT NULL REFERENCES rooms(id),
  container_id text,
  status       text        NOT NULL DEFAULT 'starting'
                 CHECK (status IN ('starting', 'running', 'ended')),
  -- seq dağıtıcısı: her append bu satırı kilitler, böylece iki paralel
  -- yazıcı asla aynı sırayı alamaz.
  next_seq     bigint      NOT NULL DEFAULT 1,
  started_at   timestamptz NOT NULL DEFAULT now(),
  ended_at     timestamptz
);

CREATE INDEX IF NOT EXISTS sessions_room_idx ON sessions (room_id, started_at DESC);

CREATE TABLE IF NOT EXISTS session_events (
  room_id    uuid        NOT NULL REFERENCES rooms(id),
  session_id uuid        NOT NULL REFERENCES sessions(id),
  seq        bigint      NOT NULL,
  ts         timestamptz NOT NULL DEFAULT now(),
  type       text        NOT NULL,
  actor      jsonb       NOT NULL,
  payload    jsonb       NOT NULL,
  PRIMARY KEY (session_id, seq)
);

-- `since=N` okuması bu index üzerinden gider.
CREATE INDEX IF NOT EXISTS session_events_since_idx ON session_events (session_id, seq);
CREATE INDEX IF NOT EXISTS session_events_type_idx  ON session_events (session_id, type, seq);

-- Append-only'yi veritabanı seviyesinde zorla. Uygulama hatası log'u bozamaz.
CREATE OR REPLACE FUNCTION session_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'session_events append-only: % engellendi', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS session_events_no_mutation ON session_events;
CREATE TRIGGER session_events_no_mutation
  BEFORE UPDATE OR DELETE ON session_events
  FOR EACH ROW EXECUTE FUNCTION session_events_append_only();
