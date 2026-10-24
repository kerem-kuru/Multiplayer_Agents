-- 008_journal.sql — Hafta 8: oda defteri, iki parçalı model
--
-- SAPMA (görev tanımı Adım 2): tanım tek bir `journal_entries` tablosu ve
-- `007_journal.sql` adı veriyor. 007 Hafta 7'de alındı, bu yüzden 008.
-- Şekil de farklı (README "Hafta 8 kararları"):
--
-- - Tanımda her satır TAM kaydı taşıyor (kararlar ve sözleşmeler dahil) ve
--   eskisini `superseded_by` ile eskitiyor; kayıt başına 10 karar/10 sözleşme
--   tavanı yüzünden uzun bir projede en eski karar düşüyordu.
-- - Burada `journal_entries` bir yazımın DELTASINI ve o yazımdan sonraki
--   ANLIK KISMI taşır; birikimli kısım iki sicil tablosunda, toplam sınırı
--   yok. Satır eskitilmez: sürümler (1, 2, 3…) yan yana durur, güncel olan en
--   büyük sürümdür. `superseded_by` ve `journal_entries_current` gerekmiyor.
--
-- Değişmez Kural 7 ("silinmez, eskitilir") `journal_entries` için geçerli:
-- hiçbir satırı silinmez. Siciller güncel durumun projeksiyonudur
-- (Değişmez Kural 8); kaldırılan bir sözleşmenin izi kaldıran yazımın
-- `patch.remove_contracts`'ında ve event log'da durur.

CREATE TABLE IF NOT EXISTS journal_entries (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id    UUID NOT NULL REFERENCES rooms(id),
  agent_name TEXT NOT NULL,
  -- Agent başına sayaç. Yazım, agent'ın en büyük sürümüne +1 ekler; iki
  -- paralel yazım aynı sayıyı alırsa aşağıdaki index ikincisini reddeder.
  version    INT  NOT NULL CHECK (version > 0),
  -- Delta: kabul edilen `JournalPatch` (host alanları atılmış). Siciller bu
  -- satırlardan yeniden kurulabilir.
  patch      JSONB NOT NULL,
  -- Bu yazımdan sonraki `JournalSnapshot` (agent, status, headline, touched…).
  snapshot   JSONB NOT NULL,
  source     TEXT NOT NULL CHECK (source IN ('agent','auto','human')),
  -- Hangi turn'de yazıldı; insan yazımında null.
  message_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_version
  ON journal_entries (room_id, agent_name, version);

-- Kararlar: oda düzeyinde, birikimli. Kimlik sahip + `what`; aynısı yeniden
-- yazılınca satır güncellenir ve yeni sürümü alır.
CREATE TABLE IF NOT EXISTS decision_registry (
  room_id    UUID NOT NULL REFERENCES rooms(id),
  owner      TEXT NOT NULL,
  what       TEXT NOT NULL,
  why        TEXT NOT NULL,
  -- Boş dizi: odanın geneli. İlgi filtresi (`relevantDecisions`) SQL'de de
  -- yazılabilsin diye JSONB değil dizi.
  affects    TEXT[] NOT NULL DEFAULT '{}',
  -- Sahibinin defterinin hangi sürümü yazdı ve o yazımın içinde kaçıncı.
  -- Sahip içindeki sıra (version, ord).
  version    INT NOT NULL,
  ord        INT NOT NULL,
  PRIMARY KEY (room_id, owner, what),
  -- Her karar onu yazan defter satırına bağlı: sicilde kaynağı olmayan öğe olmaz.
  FOREIGN KEY (room_id, owner, version) REFERENCES journal_entries (room_id, agent_name, version)
);

-- Sözleşmeler: oda içinde ad tek. Değiştirmek ve kaldırmak yalnızca sahibine
-- açık; bu kural `core/journal.ts`'te, buradaki `owner` onun dayanağı.
CREATE TABLE IF NOT EXISTS contract_registry (
  room_id       UUID NOT NULL REFERENCES rooms(id),
  name          TEXT NOT NULL,
  owner         TEXT NOT NULL,
  shape         TEXT NOT NULL,
  file          TEXT,
  stability     TEXT NOT NULL CHECK (stability IN ('draft','agreed')),
  -- `file`'ın yazım anındaki sha256'sı; dosya değişip sicil güncellenmezse
  -- oda durumu metni "(dosya değişmiş)" der.
  source_sha256 TEXT CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  version       INT NOT NULL,
  -- İlk yazım sırası; güncelleme (ON CONFLICT DO UPDATE) sırayı değiştirmez,
  -- kaldırıp yeniden eklemek sona alır — `applyJournalWrite` ile aynı kural.
  seq           BIGINT GENERATED ALWAYS AS IDENTITY,
  PRIMARY KEY (room_id, name),
  FOREIGN KEY (room_id, owner, version) REFERENCES journal_entries (room_id, agent_name, version)
);
