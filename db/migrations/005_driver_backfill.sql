-- 005_driver_backfill.sql — Hafta 5'ten ÖNCE açılmış odalara sürücü satırı
--
-- `agent_driver` satırları oda açılırken yazılıyor (004 + openRoom). Ama daha
-- önce açılmış odalarda satır YOK ve sürücü uçları o odalarda `404` dönüyordu:
-- elle test eden kişi "Sürücülüğü al"a bastığında "agent bulunamadı" görüyordu.
--
-- Agent adları odanın AÇILDIĞI ANDAKİ konfigürasyonundan (rooms.config)
-- okunuyor — YAML sonradan değişse bile o oda kendi kopyasıyla çalışır.
INSERT INTO agent_driver (room_id, agent_name)
SELECT r.id, a->>'name'
  FROM rooms r
  CROSS JOIN LATERAL jsonb_array_elements(r.config->'agents') AS a
 WHERE a->>'name' IS NOT NULL
ON CONFLICT (room_id, agent_name) DO NOTHING;
