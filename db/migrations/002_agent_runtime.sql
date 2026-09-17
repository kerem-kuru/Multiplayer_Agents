-- 002_agent_runtime.sql — Hafta 2: agent çalışma durumu
--
-- Bu tablo event log DEĞİL. session_events append-only ve değişmez; burası
-- güncel durumun hızlı okunabilir PROJEKSİYONU ve mutasyona açık.
-- Tarihçe sorusunun cevabı her zaman event log'dur, burası değil.

CREATE TABLE IF NOT EXISTS agent_runtime (
  room_id            uuid        NOT NULL REFERENCES rooms(id),
  agent_name         text        NOT NULL,
  status             text        NOT NULL DEFAULT 'stopped'
                       CHECK (status IN ('stopped','starting','idle','busy','crashed','failed')),
  -- SDK oturumu: runner çökse de sohbet buradan devam eder.
  sdk_session_id     text,
  current_message_id uuid,
  restart_count      integer     NOT NULL DEFAULT 0,
  last_exit_code     integer,
  last_error         text,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, agent_name)
);

-- Sunucu açılışındaki mutabakat bu index üzerinden gider.
CREATE INDEX IF NOT EXISTS agent_runtime_status_idx ON agent_runtime (status);
