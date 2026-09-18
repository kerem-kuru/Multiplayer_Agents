-- Hafta 4 — redaction bulguları, snapshot'lar, insan oturumları ve oda üyeliği.
--
-- NOT: `sessions` AGENT oturumudur (Hafta 1'den). İnsan oturumu `auth_sessions`.
-- İkisini karıştırmamak için isim bilerek ayrıldı.

-- gen_random_uuid() için (Postgres 13+ çekirdekte var, yine de garanti).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Redaction ───────────────────────────────────────────────────────────────
-- Bu tablo ASLA ham secret içermez: kural, payload içindeki yol, uzunluk ve
-- sha256'nın ilk 8 hex'i. "Aynı anahtar iki yerde geçmiş" bilgisi hash8 ile
-- korunur, değerin kendisi kaybolur.
CREATE TABLE IF NOT EXISTS redaction_findings (
  session_id UUID NOT NULL REFERENCES sessions(id),
  seq        BIGINT NOT NULL,
  rule       TEXT NOT NULL,
  path       TEXT NOT NULL,
  hash8      TEXT NOT NULL,
  length     INT  NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS redaction_findings_session ON redaction_findings (session_id, seq);

-- ── Snapshot ────────────────────────────────────────────────────────────────
-- Yeni katılan `since=0`'dan replay yapmasın diye. `version` projeksiyon
-- sürümü: kod değişince eski snapshot okunmaz, tam replay'e düşülür.
CREATE TABLE IF NOT EXISTS snapshots (
  session_id UUID NOT NULL REFERENCES sessions(id),
  seq        BIGINT NOT NULL,
  version    INT NOT NULL,
  state      JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, seq)
);

-- ── İnsanlar ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ham token DB'de DURMAZ: sadece sha256'sı. Tek kullanımlık (`used_at`).
CREATE TABLE IF NOT EXISTS magic_links (
  token_hash TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS magic_links_email ON magic_links (email, created_at DESC);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Oda üyeliği ─────────────────────────────────────────────────────────────
-- Bu hafta iki rol: owner ve viewer. Hafta 5'te yazma rolleri gelecek; alan
-- metin + CHECK olduğu için genişletmek tek satır.
CREATE TABLE IF NOT EXISTS room_members (
  room_id   UUID NOT NULL REFERENCES rooms(id),
  user_id   UUID NOT NULL REFERENCES users(id),
  role      TEXT NOT NULL CHECK (role IN ('owner', 'viewer')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);

-- Davet linki magic link'ten FARKLI: çok kullanımlık (ekibe tek link atılır),
-- süreli ve iptal edilebilir. `token_prefix` sadece listede göstermek için;
-- tek başına giriş sağlamaz.
CREATE TABLE IF NOT EXISTS room_invites (
  token_hash   TEXT PRIMARY KEY,
  token_prefix TEXT NOT NULL,
  room_id      UUID NOT NULL REFERENCES rooms(id),
  role         TEXT NOT NULL CHECK (role IN ('viewer')),
  created_by   UUID NOT NULL REFERENCES users(id),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS room_invites_room ON room_invites (room_id, created_at DESC);

ALTER TABLE rooms ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id);
