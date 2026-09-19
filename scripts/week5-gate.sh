#!/usr/bin/env bash
#
# Hafta 5 kapısı — yazma yetkisi, kuyruk, kesme, sürücü.
#
#   npm run gate:w5
#
# GERÇEK AGENT GEREKTİRMEZ ve bu bilinçli: bu haftanın kanıtlaması gereken şey
# model çıktısı değil SIRALAMA. Sunucu `AGENT_FAKE_RUNTIME=1` ile kalkar —
# hiçbir modele istek gitmez, turn'ü N ms sonra biten sahte bir koşum ortamı
# devreye girer. Gerçek DB, gerçek kuyruk, gerçek event log, gerçek SSE,
# gerçek yetki; sadece model yok. Yarış penceresi de gerçeğinden GENİŞ olur.
#
# Gerçek agent'ın kanıtlaması gereken iki şey ayrı kapıda: modelin `[İsim]: `
# etiketini okuyup kime cevap verdiğini söylemesi ve uzun bir bash komutunun
# ortasında kesilmesi → npm run gate:w5:agent
set -uo pipefail
export MSYS_NO_PATHCONV=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${GATE_PORT:-8797}"
BASE="http://localhost:$PORT"
export DATABASE_URL="${DATABASE_URL:-postgres://rooms:Kk2007..@localhost:5433/agent_rooms}"
AGENT="${GATE_AGENT:-backend}"
# Sürücülük düşme süresi: ÜRÜNDE 60 sn. Kapı gerçek değeri ölçer.
DRIVER_GRACE_MS="${DRIVER_GRACE_MS:-60000}"

PASS=0; FAIL=0
SERVER_PID=""; SAMPLER_PID=""
ROOM=""; SID=""
TMP=".gate5-tmp-$$"
rm -rf "$TMP"; mkdir -p "$TMP"

ok()   { echo "  ✓ $1"; PASS=$((PASS + 1)); }
no()   { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }
step() { echo ""; echo "$1"; }

jget() {
  node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const o = JSON.parse(s);
        const v = process.argv[1].split(".").reduce((a, k) => (a == null ? a : a[k]), o);
        console.log(v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
      } catch { console.log(""); }
    });' "$1"
}

psql_q() { docker compose exec -T postgres psql -U rooms -d agent_rooms -tA -c "$1" 2>&1 | tr -d ' \r'; }

start_server() {
  AUTH_DEV_MODE=true SPAWN_CONTAINER=0 AGENT_FAKE_RUNTIME=1 AGENT_FAKE_TURN_MS=1200 \
    DRIVER_GRACE_MS="$DRIVER_GRACE_MS" PORT="$PORT" \
    node apps/api/dist/index.js >>"$TMP/server.log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 40); do
    [ "$(curl -s --max-time 5 "$BASE/health" | jget ok)" = "true" ] && return 0
    sleep 0.5
  done
  return 1
}

stop_server() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  for _ in $(seq 1 20); do
    curl -s --max-time 2 "$BASE/health" >/dev/null 2>&1 || return 0
    sleep 0.5
  done
}

cleanup() {
  step "20) Temizlik"
  [ -n "$TMP" ] && touch "$TMP/sampler.stop" 2>/dev/null
  [ -n "$SAMPLER_PID" ] && kill "$SAMPLER_PID" 2>/dev/null
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  rm -rf "$TMP"
  local removed=0
  if [ -n "$ROOM" ]; then
    for c in $(docker ps -aq --filter "label=agent-rooms.room=$ROOM"); do
      docker rm -f "$c" >/dev/null 2>&1 && removed=$((removed + 1))
    done
  fi
  ok "temizlendi (container: $removed)"
}
trap cleanup EXIT

echo "Hafta 5 kapısı — $BASE  (sahte koşum ortamı: hiçbir modele istek gitmiyor)"

# --- ön koşullar -----------------------------------------------------------
if ! docker compose exec -T postgres pg_isready -U rooms -d agent_rooms >/dev/null 2>&1; then
  echo "  ✗ postgres ayakta değil — önce: npm run db:up"; exit 1
fi
# Portta kalmış eski sunucu kapıyı ESKİ derlemeyi ölçmeye iter (Hafta 4'te iki
# kez oldu): baştan reddet.
if curl -s --max-time 2 "$BASE/health" >/dev/null 2>&1; then
  echo "  ✗ $PORT zaten dinleniyor — eski sunucuyu kapat"; exit 1
fi
npm run build >/dev/null 2>&1 || { echo "build başarısız"; exit 1; }
npm run db:migrate >/dev/null 2>&1 || { echo "migration başarısız"; exit 1; }

start_server || { echo "sunucu kalkmadı"; tail -20 "$TMP/server.log"; exit 1; }

# --- üç kullanıcı: A owner, B member (Ayse), C viewer ----------------------
STAMP="$$-$(date +%s)"
A=$(node scripts/dev-login.mjs --base "$BASE" --email "gate5a-$STAMP@rooms.local")
B=$(node scripts/dev-login.mjs --base "$BASE" --email "gate5b-$STAMP@rooms.local")
C=$(node scripts/dev-login.mjs --base "$BASE" --email "gate5c-$STAMP@rooms.local")
D=$(node scripts/dev-login.mjs --base "$BASE" --email "gate5d-$STAMP@rooms.local")
if [ -z "$A" ] || [ -z "$B" ] || [ -z "$C" ] || [ -z "$D" ]; then echo "giriş başarısız"; exit 1; fi

acurl() { curl -s --max-time 30 -b "rooms_session=$A" "$@"; }
bcurl() { curl -s --max-time 30 -b "rooms_session=$B" "$@"; }
ccurl() { curl -s --max-time 30 -b "rooms_session=$C" "$@"; }

CREATE=$(acurl -X POST "$BASE/rooms" -H 'content-type: application/json' -d '{}')
ROOM=$(echo "$CREATE" | jget room.id)
SID=$(echo "$CREATE" | jget session.id)
[ -n "$ROOM" ] || { echo "oda açılamadı: $CREATE"; exit 1; }

# B katılımcı, C izleyici olarak davet edilir.
INV_M=$(acurl -X POST "$BASE/rooms/$ROOM/invites" -H 'content-type: application/json' -d '{"role":"member"}' | jget url)
INV_V=$(acurl -X POST "$BASE/rooms/$ROOM/invites" -H 'content-type: application/json' -d '{"role":"viewer"}' | jget url)
TOK_M="${INV_M##*token=}"; TOK_V="${INV_V##*token=}"
B_ROLE=$(bcurl -X POST "$BASE/invites/accept" -H 'content-type: application/json' -d "{\"token\":\"$TOK_M\"}" | jget role)
C_ROLE=$(ccurl -X POST "$BASE/invites/accept" -H 'content-type: application/json' -d "{\"token\":\"$TOK_V\"}" | jget role)

B_ID=$(bcurl "$BASE/auth/me" | jget id)
# Görünen ad "Ayse" olsun: aktör etiketi kontrolü (7) ismin agent'a ulaştığını
# ölçüyor. Kullanıcı adı e-postanın yerel kısmından türüyor ve kapı her koşumda
# benzersiz e-posta kullanmak ZORUNDA (magic link hız sınırı, Hafta 4 dersi).
psql_q "UPDATE users SET name='Ayse' WHERE id='$B_ID'" >/dev/null
A_ID=$(acurl "$BASE/auth/me" | jget id)
D_ID=$(curl -s -b "rooms_session=$D" "$BASE/auth/me" | jget id)

send() { # <cookie> <text> → yanıt gövdesi
  curl -s --max-time 30 -b "rooms_session=$1" -X POST \
    "$BASE/rooms/$ROOM/agents/$AGENT/message" \
    -H 'content-type: application/json' -d "{\"text\":$(node -e 'console.log(JSON.stringify(process.argv[1]))' "$2")}"
}

queue_rows() { psql_q "SELECT count(*) FROM agent_queue WHERE room_id='$ROOM' AND agent_name='$AGENT' AND status='$1'"; }

events_of() { # <messageId> → tip listesi (sırayla)
  psql_q "SELECT type FROM session_events WHERE session_id='$SID' AND payload->>'messageId'='$1' ORDER BY seq"
}

###############################################################################
step "0) Roller: davet iki rol üretiyor"
if [ "$B_ROLE" = "member" ] && [ "$C_ROLE" = "viewer" ]; then
  ok "B katılımcı, C izleyici olarak katıldı"
else
  no "davet rolleri: B=$B_ROLE C=$C_ROLE"
fi

###############################################################################
step "1) İki kişi AYNI ANDA yazıyor — ikisi de 202, sıra 1 ve 2"
# 100 ms aralıkla `running` satır sayısını örnekle (kontrol 2).
#
# Örnekleme POSTGRES'İN İÇİNDE (`\watch 0.1`), kabuktan `docker exec`
# döngüsüyle değil: ilk hâl her örnek için yeni bir `docker compose exec`
# açıyordu, örnek başına ~1,5 sn sürüyordu ve 3 sn'lik koşumda yalnızca 3
# örnek alınabiliyordu — "iki running satır yok" iddiasını 3 örnekle
# kanıtlamak, ölçmemekle neredeyse aynı şey.
#
# Süreyi `timeout` sınırlıyor; `kill` ile durdurmaya çalışmak Git Bash'te
# güvenilir değil ve hayatta kalan arka plan işi çıplak `wait`'i asıyor.
printf "SELECT count(*) FROM agent_queue WHERE room_id='%s' AND status='running';\n\\\\watch 0.1\n" "$ROOM" \
  | timeout 14 docker compose exec -T postgres psql -U rooms -d agent_rooms -tA \
      >"$TMP/running.samples" 2>/dev/null &
SAMPLER_PID=$!

send "$A" "A: ilk gorev" >"$TMP/a1.json" &
P1=$!
send "$B" "B: ikinci gorev" >"$TMP/b1.json" &
P2=$!
wait "$P1"; wait "$P2"

POS_A=$(jget position <"$TMP/a1.json"); POS_B=$(jget position <"$TMP/b1.json")
MID_A=$(jget messageId <"$TMP/a1.json"); MID_B=$(jget messageId <"$TMP/b1.json")
SORTED=$(printf "%s\n%s\n" "$POS_A" "$POS_B" | sort | tr '\n' ' ')
if [ -n "$MID_A" ] && [ -n "$MID_B" ] && [ "$SORTED" = "1 2 " ]; then
  ok "iki mesaj da kabul edildi (position: $POS_A ve $POS_B)"
else
  no "pozisyonlar beklenmedik: A=$POS_A B=$POS_B (mid: $MID_A / $MID_B)"
fi

# İkisi de bitsin.
for _ in $(seq 1 60); do
  [ "$(queue_rows queued)" = "0" ] && [ "$(queue_rows running)" = "0" ] && break
  sleep 0.5
done

###############################################################################
step "2) Koşum boyunca HİÇBİR ANDA iki 'running' satır yok"
wait "$SAMPLER_PID" 2>/dev/null; SAMPLER_PID=""
MAXRUN=$(sort -n "$TMP/running.samples" 2>/dev/null | tail -1)
SAMPLES=$(grep -c '[0-9]' "$TMP/running.samples" 2>/dev/null | tr -d ' ')
if [ -n "$MAXRUN" ] && [ "$MAXRUN" -le 1 ] && [ "${SAMPLES:-0}" -ge 20 ]; then
  ok "$SAMPLES örnekleme, en yüksek eşzamanlı 'running' = $MAXRUN"
else
  no "örnekleme: $SAMPLES, en yüksek 'running': $MAXRUN"
fi

###############################################################################
step "3) Event sırası: queued → received → started; ikinci turn birincinin bitişinden SONRA"
SEQ_A=$(events_of "$MID_A" | tr '\n' ',')
SEQ_B=$(events_of "$MID_B" | tr '\n' ',')
FIRST_END=$(psql_q "SELECT min(seq) FROM session_events WHERE session_id='$SID' AND type IN ('turn.completed','turn.failed')")
SECOND_START=$(psql_q "SELECT max(seq) FROM session_events WHERE session_id='$SID' AND type='turn.started'")
if [[ "$SEQ_A" == message.queued,message.received,turn.started* ]] &&
   [[ "$SEQ_B" == message.queued,message.received,turn.started* ]] &&
   [ -n "$FIRST_END" ] && [ -n "$SECOND_START" ] && [ "$SECOND_START" -gt "$FIRST_END" ]; then
  ok "her iki mesajda sıra doğru; ikinci turn.started (seq $SECOND_START) > ilk bitiş (seq $FIRST_END)"
else
  no "sıra bozuk: A=[$SEQ_A] B=[$SEQ_B] ilkBitiş=$FIRST_END ikinciBaşlangıç=$SECOND_START"
fi

###############################################################################
step "4) 5 paralel mesaj → 5 turn, hepsi sırayla, hiçbiri kayıp değil"
# ÇIPLAK `wait` YOK: yalnızca kendi başlattığı işleri bekler. Çıplak `wait`
# arka plandaki başka bir işi (sunucu, örnekleyici) de bekler ve kapı asılı
# kalır — bu oturumda bir kez daha oldu.
PIDS=""
for i in 1 2 3 4 5; do
  send "$B" "paralel gorev $i" >"$TMP/p$i.json" &
  PIDS="$PIDS $!"
done
for p in $PIDS; do wait "$p" 2>/dev/null; done
for _ in $(seq 1 120); do
  [ "$(queue_rows queued)" = "0" ] && [ "$(queue_rows running)" = "0" ] && break
  sleep 0.5
done
DONE=$(psql_q "SELECT count(*) FROM agent_queue WHERE room_id='$ROOM' AND agent_name='$AGENT' AND status='done' AND text LIKE 'paralel gorev%'")
# Koşma sırası kuyruğa giriş sırasıyla aynı mı: ord ile received seq'i karşılaştır.
ORDER_OK=$(psql_q "
  SELECT CASE WHEN count(*) = 0 THEN 'ok' ELSE 'bozuk' END FROM (
    SELECT q.ord,
           (SELECT e.seq FROM session_events e
             WHERE e.session_id='$SID' AND e.type='message.received'
               AND e.payload->>'messageId' = q.message_id::text) AS rseq
      FROM agent_queue q
     WHERE q.room_id='$ROOM' AND q.agent_name='$AGENT' AND q.text LIKE 'paralel gorev%'
  ) t WHERE rseq IS NULL
")
MONOTONIC=$(psql_q "
  WITH x AS (
    SELECT q.ord,
           (SELECT e.seq FROM session_events e
             WHERE e.session_id='$SID' AND e.type='message.received'
               AND e.payload->>'messageId' = q.message_id::text) AS rseq
      FROM agent_queue q
     WHERE q.room_id='$ROOM' AND q.agent_name='$AGENT' AND q.text LIKE 'paralel gorev%'
  )
  SELECT CASE WHEN count(*) = 0 THEN 'ok' ELSE 'bozuk' END
    FROM (SELECT ord, rseq, lag(rseq) OVER (ORDER BY ord) AS prev FROM x) y
   WHERE prev IS NOT NULL AND rseq < prev
")
if [ "$DONE" = "5" ] && [ "$ORDER_OK" = "ok" ] && [ "$MONOTONIC" = "ok" ]; then
  ok "5 mesaj, 5 turn, sıra enqueue sırasıyla aynı"
else
  no "5 paralel: done=$DONE hepsiKoştu=$ORDER_OK sıra=$MONOTONIC"
fi

###############################################################################
step "5) Kuyruk sınırı: 11. mesaj 429"
# Uzun bir iş başlat (sahte ortamda 'sleep' geçen mesaj uzun sürer), sonra 10
# mesaj kuyruğa bindir.
send "$B" "sleep 120 komutunu calistir" >"$TMP/long1.json"
LONG1=$(jget messageId <"$TMP/long1.json")
for _ in $(seq 1 40); do
  [ "$(queue_rows running)" = "1" ] && break
  sleep 0.25
done
for i in $(seq 1 10); do send "$B" "dolum $i" >/dev/null; done
CODE=$(curl -s -o "$TMP/full.json" -w '%{http_code}' --max-time 20 -b "rooms_session=$B" -X POST \
  "$BASE/rooms/$ROOM/agents/$AGENT/message" -H 'content-type: application/json' -d '{"text":"fazlalik"}')
if [ "$CODE" = "429" ]; then
  ok "11. mesaj 429 — mesaj: $(jget error <"$TMP/full.json")"
else
  no "11. mesaj $CODE döndü"
fi

# Kuyruğu boşalt: uzun iş kesilir, dolum mesajları kısa sürede akar. Sonraki
# kontroller dolu bir kuyrukla 429 yemesin.
DRIVER_ID=$(psql_q "SELECT coalesce(user_id::text,'') FROM agent_driver WHERE room_id='$ROOM' AND agent_name='$AGENT'")
if [ "$DRIVER_ID" = "$B_ID" ]; then
  bcurl -o /dev/null -X POST "$BASE/rooms/$ROOM/agents/$AGENT/interrupt"
else
  acurl -o /dev/null -X POST "$BASE/rooms/$ROOM/agents/$AGENT/interrupt"
fi
for _ in $(seq 1 120); do
  [ "$(queue_rows queued)" = "0" ] && [ "$(queue_rows running)" = "0" ] && break
  sleep 0.5
done

###############################################################################
step "6) İptal: kendi kaydı, başkasının kaydı, sürücünün iptali"
# Önce agent'ı MEŞGUL ET: kuyruk boşken gönderilen mesaj anında koşmaya başlar
# ve iptal edilemez (doğru davranış, `409` → kesme). İptal edilecek kayıtların
# `queued` kalması için önce uzun bir iş lazım.
send "$B" "sleep 120 komutunu calistir" >/dev/null
for _ in $(seq 1 40); do [ "$(queue_rows running)" = "1" ] && break; sleep 0.25; done
MID_B2=$(send "$B" "B iptal edecek" | jget messageId)
MID_A2=$(send "$A" "A nin kaydi" | jget messageId)
DEL_OWN=$(curl -s -o /dev/null -w '%{http_code}' -b "rooms_session=$B" -X DELETE "$BASE/rooms/$ROOM/queue/$MID_B2")
DEL_OTHER=$(curl -s -o /dev/null -w '%{http_code}' -b "rooms_session=$B" -X DELETE "$BASE/rooms/$ROOM/queue/$MID_A2")
# A oda sahibi: başkasının kaydını iptal edebilir.
MID_B3=$(send "$B" "A silecek" | jget messageId)
DEL_OWNER=$(curl -s -o /dev/null -w '%{http_code}' -b "rooms_session=$A" -X DELETE "$BASE/rooms/$ROOM/queue/$MID_B3")
CANCELLED=$(psql_q "SELECT status FROM agent_queue WHERE message_id='$MID_B2'")
NO_RECEIVED=$(psql_q "SELECT count(*) FROM session_events WHERE session_id='$SID' AND type='message.received' AND payload->>'messageId'='$MID_B2'")
if [ "$DEL_OWN" = "200" ] && [ "$DEL_OTHER" = "403" ] && [ "$DEL_OWNER" = "200" ] &&
   [ "$CANCELLED" = "cancelled" ] && [ "$NO_RECEIVED" = "0" ]; then
  ok "kendi kaydı 200 · başkasının 403 · owner 200 · iptal edilen mesaj HİÇ çalışmadı"
else
  no "iptal: own=$DEL_OWN other=$DEL_OTHER owner=$DEL_OWNER durum=$CANCELLED received=$NO_RECEIVED"
fi

# Koşan uzun işi kes ve kuyruğu boşalt (sonraki kontroller temiz başlasın).
DRV=$(psql_q "SELECT coalesce(user_id::text,'') FROM agent_driver WHERE room_id='$ROOM' AND agent_name='$AGENT'")
if [ "$DRV" = "$B_ID" ]; then
  bcurl -o /dev/null -X POST "$BASE/rooms/$ROOM/agents/$AGENT/interrupt"
elif [ -n "$DRV" ]; then
  acurl -o /dev/null -X POST "$BASE/rooms/$ROOM/agents/$AGENT/interrupt"
fi
for _ in $(seq 1 120); do
  [ "$(queue_rows queued)" = "0" ] && [ "$(queue_rows running)" = "0" ] && break
  sleep 0.5
done

###############################################################################
step "7) Aktör etiketi: agent kimin yazdığını biliyor"
# Sahte koşum ortamı önekten okuyor: bu kontrol ÖNEKİN RUNNER'A ULAŞTIĞINI
# kanıtlar. Modelin anlayıp anlamadığı gerçek agent kapısında.
AYSE_TEXT=$(psql_q "
  SELECT count(*) FROM session_events
   WHERE session_id='$SID' AND type='agent.text' AND payload->>'text' LIKE 'Ayse%'
")
if [ "${AYSE_TEXT:-0}" -ge 1 ]; then
  ok "agent.text içinde 'Ayse' geçiyor ($AYSE_TEXT kez) — önek runner'a ulaşıyor"
else
  no "agent.text içinde 'Ayse' yok"
fi

###############################################################################
step "8) Ham metin: event log'da '[Ayse]:' öneki YOK"
PREFIXED=$(psql_q "
  SELECT count(*) FROM session_events
   WHERE session_id='$SID' AND type IN ('message.queued','message.received')
     AND payload->>'text' LIKE '[Ayse]%'
")
QUEUED_N=$(psql_q "SELECT count(*) FROM session_events WHERE session_id='$SID' AND type='message.queued'")
if [ "$PREFIXED" = "0" ] && [ "${QUEUED_N:-0}" -ge 2 ]; then
  ok "$QUEUED_N queued event, hiçbirinde önek yok (ham metin saklanıyor)"
else
  no "önekli metin sayısı: $PREFIXED (queued: $QUEUED_N)"
fi

###############################################################################
step "9) Sürücü: A alıyor, B'nin claim'i 409 + mevcut sürücüyü söylüyor"
# İlk mesajı yazan OTOMATİK sürücü olduğu için sürücü şu an A da B de olabilir.
# Kim ise bıraksın, sonra A alsın — kontrol edilen şey "sürücü tek" ve ikinci
# claim'in reddedilmesi.
CUR=$(psql_q "SELECT coalesce(user_id::text,'') FROM agent_driver WHERE room_id='$ROOM' AND agent_name='$AGENT'")
if [ "$CUR" = "$B_ID" ]; then
  bcurl -o /dev/null -X POST "$BASE/rooms/$ROOM/agents/$AGENT/driver/release"
elif [ -n "$CUR" ]; then
  acurl -o /dev/null -X POST "$BASE/rooms/$ROOM/agents/$AGENT/driver/release"
fi
CLAIM_A=$(acurl -X POST "$BASE/rooms/$ROOM/agents/$AGENT/driver/claim")
DRIVER_NOW=$(acurl "$BASE/rooms/$ROOM/agents/$AGENT/driver" | jget driver.id)
CLAIM_B_CODE=$(curl -s -o "$TMP/claimb.json" -w '%{http_code}' -b "rooms_session=$B" -X POST "$BASE/rooms/$ROOM/agents/$AGENT/driver/claim")
# İlk mesajı yazan otomatik sürücü olduğu için sürücü zaten dolu olabilir;
# kontrol edilen şey "sürücü tek" ve ikinci claim'in reddedilmesi.
if [ "$DRIVER_NOW" = "$A_ID" ] && [ "$CLAIM_B_CODE" = "409" ] && grep -q "currentDriver" "$TMP/claimb.json"; then
  ok "sürücü A · ikinci claim 409 ve mevcut sürücüyü söylüyor"
else
  no "claim: sürücü=$DRIVER_NOW ikinciKod=$CLAIM_B_CODE yanıt=$(cat "$TMP/claimb.json")"
fi

###############################################################################
step "10) Devir: A → B; artık B kesebiliyor, A kesemiyor"
VER=$(acurl "$BASE/rooms/$ROOM/agents/$AGENT/driver" | jget version)
HANDOFF=$(acurl -X POST "$BASE/rooms/$ROOM/agents/$AGENT/driver/handoff" \
  -H 'content-type: application/json' -d "{\"toUserId\":\"$B_ID\",\"version\":$VER}")
NEW_DRIVER=$(echo "$HANDOFF" | jget user.id)
HANDOFF_EV=$(psql_q "SELECT count(*) FROM session_events WHERE session_id='$SID' AND type='driver.handed_off'")
# Uzun iş başlat: kesme kontrollerinin kesecek bir şeyi olsun.
LONG2=$(send "$B" "sleep 120 komutunu calistir" | jget messageId)
for _ in $(seq 1 40); do [ "$(queue_rows running)" = "1" ] && break; sleep 0.25; done
A_INT=$(curl -s -o "$TMP/aint.json" -w '%{http_code}' -b "rooms_session=$A" -X POST "$BASE/rooms/$ROOM/agents/$AGENT/interrupt")
if [ "$NEW_DRIVER" = "$B_ID" ] && [ "${HANDOFF_EV:-0}" -ge 1 ] && [ "$A_INT" = "403" ]; then
  ok "devir yazıldı (driver.handed_off) · eski sürücünün kesmesi 403"
else
  no "devir: yeniSürücü=$NEW_DRIVER event=$HANDOFF_EV A-kesme=$A_INT"
fi

###############################################################################
step "11) Eski version ile devir 409"
STALE=$(curl -s -o /dev/null -w '%{http_code}' -b "rooms_session=$B" -X POST \
  "$BASE/rooms/$ROOM/agents/$AGENT/driver/handoff" \
  -H 'content-type: application/json' -d "{\"toUserId\":\"$A_ID\",\"version\":0}")
if [ "$STALE" = "409" ]; then ok "eski version 409"; else no "eski version $STALE döndü"; fi

###############################################################################
step "12) Odanın üyesi olmayana devir 400"
NOTMEMBER=$(curl -s -o /dev/null -w '%{http_code}' -b "rooms_session=$B" -X POST \
  "$BASE/rooms/$ROOM/agents/$AGENT/driver/handoff" \
  -H 'content-type: application/json' -d "{\"toUserId\":\"$D_ID\",\"version\":$(bcurl "$BASE/rooms/$ROOM/agents/$AGENT/driver" | jget version)}")
VIEWER_TARGET=$(curl -s -o /dev/null -w '%{http_code}' -b "rooms_session=$B" -X POST \
  "$BASE/rooms/$ROOM/agents/$AGENT/driver/handoff" \
  -H 'content-type: application/json' -d "{\"toUserId\":\"$(ccurl "$BASE/auth/me" | jget id)\",\"version\":$(bcurl "$BASE/rooms/$ROOM/agents/$AGENT/driver" | jget version)}")
if [ "$NOTMEMBER" = "400" ] && [ "$VIEWER_TARGET" = "400" ]; then
  ok "üye olmayan 400 · izleyiciye devir de 400 (kesme yetkisi yazma yetkisi olmayana verilmez)"
else
  no "devir hedefi: üyeDeğil=$NOTMEMBER izleyici=$VIEWER_TARGET"
fi

###############################################################################
step "14) Kesme: requested hemen, applied ve turn.failed 35 sn içinde"
T0=$(date +%s)
INT_CODE=$(curl -s -o "$TMP/int.json" -w '%{http_code}' -b "rooms_session=$B" -X POST "$BASE/rooms/$ROOM/agents/$AGENT/interrupt")
REQ_EV=$(psql_q "SELECT count(*) FROM session_events WHERE session_id='$SID' AND type='interrupt.requested' AND payload->>'messageId'='$LONG2'")
APPLIED=""; FAILED=""
for _ in $(seq 1 70); do
  APPLIED=$(psql_q "SELECT payload->>'mode' FROM session_events WHERE session_id='$SID' AND type='interrupt.applied' AND payload->>'messageId'='$LONG2'")
  FAILED=$(psql_q "SELECT payload->>'reason' FROM session_events WHERE session_id='$SID' AND type='turn.failed' AND payload->>'messageId'='$LONG2'")
  [ -n "$APPLIED" ] && [ -n "$FAILED" ] && break
  sleep 0.5
done
ELAPSED=$(( $(date +%s) - T0 ))
STATUS_NOW=$(psql_q "SELECT status FROM agent_runtime WHERE room_id='$ROOM' AND agent_name='$AGENT'")
if [ "$INT_CODE" = "202" ] && [ "${REQ_EV:-0}" -ge 1 ] && [ -n "$APPLIED" ] &&
   [ "$FAILED" = "interrupted" ] && [ "$ELAPSED" -lt 35 ] && [ "$STATUS_NOW" = "idle" ]; then
  ok "requested hemen · applied ($APPLIED) + turn.failed(interrupted) $ELAPSED sn içinde · agent idle"
else
  no "kesme: kod=$INT_CODE requested=$REQ_EV applied=$APPLIED failed=$FAILED süre=${ELAPSED}sn durum=$STATUS_NOW"
fi

###############################################################################
step "15) Kesme sonrası kuyruktaki mesaj kendiliğinden başlıyor"
NEXT_MID=$(send "$B" "kesmeden sonraki is" | jget messageId)
NEXT_OK="hayir"
for _ in $(seq 1 60); do
  R=$(psql_q "SELECT count(*) FROM session_events WHERE session_id='$SID' AND type='message.received' AND payload->>'messageId'='$NEXT_MID'")
  [ "$R" = "1" ] && { NEXT_OK="evet"; break; }
  sleep 0.5
done
if [ "$NEXT_OK" = "evet" ]; then ok "kesme sonrası sıradaki mesaj çalıştı"; else no "sıradaki mesaj başlamadı"; fi

###############################################################################
step "16) Sürücü olmayan kesme 403 · koşan turn yokken kesme 409"
for _ in $(seq 1 60); do [ "$(queue_rows running)" = "0" ] && break; sleep 0.5; done
NONDRIVER=$(curl -s -o /dev/null -w '%{http_code}' -b "rooms_session=$A" -X POST "$BASE/rooms/$ROOM/agents/$AGENT/interrupt")
NOTURN=$(curl -s -o /dev/null -w '%{http_code}' -b "rooms_session=$B" -X POST "$BASE/rooms/$ROOM/agents/$AGENT/interrupt")
VIEWER_INT=$(curl -s -o /dev/null -w '%{http_code}' -b "rooms_session=$C" -X POST "$BASE/rooms/$ROOM/agents/$AGENT/interrupt")
if [ "$NONDRIVER" = "403" ] && [ "$NOTURN" = "409" ] && [ "$VIEWER_INT" = "403" ]; then
  ok "sürücü olmayan 403 · koşan turn yok 409 · izleyici 403"
else
  no "kesme yetkisi: sürücüDeğil=$NONDRIVER turnYok=$NOTURN izleyici=$VIEWER_INT"
fi

###############################################################################
step "17) Dayanıklılık: sunucu koşarken yeniden başlıyor"
LONG3=$(send "$B" "sleep 120 komutunu calistir" | jget messageId)
for _ in $(seq 1 40); do [ "$(queue_rows running)" = "1" ] && break; sleep 0.25; done
KEEP1=$(send "$B" "restart sonrasi 1" | jget messageId)
KEEP2=$(send "$B" "restart sonrasi 2" | jget messageId)

stop_server
RUNNING_AFTER_KILL=$(psql_q "SELECT status FROM agent_queue WHERE message_id='$LONG3'")
QUEUED_KEPT=$(psql_q "SELECT count(*) FROM agent_queue WHERE room_id='$ROOM' AND status='queued'")
start_server || { no "sunucu yeniden kalkmadı"; }

RESTART_STATUS="";
for _ in $(seq 1 60); do
  RESTART_STATUS=$(psql_q "SELECT status FROM agent_queue WHERE message_id='$LONG3'")
  [ "$RESTART_STATUS" = "cancelled" ] && break
  sleep 0.5
done
CANCEL_REASON=$(psql_q "SELECT payload->>'reason' FROM session_events WHERE session_id='$SID' AND type='message.cancelled' AND payload->>'messageId'='$LONG3'")
FLOWED="hayir"
for _ in $(seq 1 80); do
  N=$(psql_q "SELECT count(*) FROM session_events WHERE session_id='$SID' AND type='message.received' AND payload->>'messageId' IN ('$KEEP1','$KEEP2')")
  [ "$N" = "2" ] && { FLOWED="evet"; break; }
  sleep 0.5
done
# YENİDEN KOŞMADI kanıtı: mesaj BİR kez alındı (restart'tan önce) ve BİR turn
# başlattı. Sıfır beklemek yanlış olurdu — o mesaj bir kez gerçekten koştu.
RERUN=$(psql_q "SELECT count(*) FROM session_events WHERE session_id='$SID' AND type='message.received' AND payload->>'messageId'='$LONG3'")
STARTS=$(psql_q "SELECT count(*) FROM session_events WHERE session_id='$SID' AND type='turn.started' AND payload->>'messageId'='$LONG3'")
if [ "$RESTART_STATUS" = "cancelled" ] && [ "$CANCEL_REASON" = "server_restart" ] &&
   [ "${QUEUED_KEPT:-0}" -ge 2 ] && [ "$FLOWED" = "evet" ] && [ "$RERUN" = "1" ] && [ "$STARTS" = "1" ]; then
  ok "koşan mesaj cancelled(server_restart) · bekleyenler korundu ve aktı · kesilen mesaj bir kez koştu, TEKRAR koşmadı"
else
  no "restart: durum=$RESTART_STATUS sebep=$CANCEL_REASON korunan=$QUEUED_KEPT aktı=$FLOWED alındı=$RERUN başlangıç=$STARTS"
fi

###############################################################################
step "18) Agent failed olunca kuyruktaki kayıtlar cancelled"
for _ in $(seq 1 60); do [ "$(queue_rows running)" = "0" ] && [ "$(queue_rows queued)" = "0" ] && break; sleep 0.5; done
send "$B" "sleep 120 komutunu calistir" >/dev/null
for _ in $(seq 1 40); do [ "$(queue_rows running)" = "1" ] && break; sleep 0.25; done
F1=$(send "$B" "failed olunca iptal 1" | jget messageId)
F2=$(send "$B" "failed olunca iptal 2" | jget messageId)
acurl -o /dev/null -X POST "$BASE/rooms/$ROOM/agents/$AGENT/fail"
FAILED_CANCELS=""
for _ in $(seq 1 40); do
  FAILED_CANCELS=$(psql_q "SELECT count(*) FROM session_events WHERE session_id='$SID' AND type='message.cancelled' AND payload->>'reason'='agent_failed' AND payload->>'messageId' IN ('$F1','$F2')")
  [ "$FAILED_CANCELS" = "2" ] && break
  sleep 0.5
done
STILL_QUEUED=$(queue_rows queued)
if [ "$FAILED_CANCELS" = "2" ] && [ "$STILL_QUEUED" = "0" ]; then
  ok "agent failed → bekleyen 2 kayıt cancelled(agent_failed), kuyruk boş"
else
  no "agent failed: iptal=$FAILED_CANCELS kalanKuyruk=$STILL_QUEUED"
fi

###############################################################################
step "19) İzleyici yazamıyor ama kuyruğu görüyor"
V_SEND=$(curl -s -o /dev/null -w '%{http_code}' -b "rooms_session=$C" -X POST \
  "$BASE/rooms/$ROOM/agents/$AGENT/message" -H 'content-type: application/json' -d '{"text":"izleyici yazamaz"}')
V_QUEUE=$(curl -s -o "$TMP/vq.json" -w '%{http_code}' -b "rooms_session=$C" "$BASE/rooms/$ROOM/agents/$AGENT/queue")
V_CLAIM=$(curl -s -o /dev/null -w '%{http_code}' -b "rooms_session=$C" -X POST "$BASE/rooms/$ROOM/agents/$AGENT/driver/claim")
if [ "$V_SEND" = "403" ] && [ "$V_QUEUE" = "200" ] && [ "$V_CLAIM" = "403" ]; then
  ok "izleyici: mesaj 403 · sürücülük 403 · kuyruk 200 (görüyor)"
else
  no "izleyici: mesaj=$V_SEND kuyruk=$V_QUEUE claim=$V_CLAIM"
fi

###############################################################################
step "13) Sürücünün tüm bağlantıları kapanınca 60-75 sn içinde sürücülük düşüyor"
# En sona bırakıldı: gerçek 60 sn'lik süreyi beklemek gerekiyor.
if [ "$DRIVER_GRACE_MS" -gt 20000 ]; then
  echo "     (gerçek süre ölçülüyor: ~$((DRIVER_GRACE_MS / 1000)) sn bekleme)"
fi
curl -s -o /dev/null -b "rooms_session=$B" -X POST "$BASE/rooms/$ROOM/agents/$AGENT/driver/claim"
# B bir SSE bağlantısı açıp kapatır: presence gelir, sonra tamamen gider.
node scripts/sse-probe.mjs "$ROOM" --base "$BASE" --session "$B" --duration 3 >/dev/null 2>&1
DROP_T0=$(date +%s)
DROPPED="hayir"
LIMIT=$(( DRIVER_GRACE_MS / 1000 + 20 ))
for _ in $(seq 1 $(( LIMIT * 2 ))); do
  D=$(psql_q "SELECT coalesce(user_id::text,'') FROM agent_driver WHERE room_id='$ROOM' AND agent_name='$AGENT'")
  [ -z "$D" ] && { DROPPED="evet"; break; }
  sleep 0.5
done
DROP_ELAPSED=$(( $(date +%s) - DROP_T0 ))
LEFT_REASON=$(psql_q "SELECT count(*) FROM session_events WHERE session_id='$SID' AND type='driver.released' AND payload->>'reason'='left_room'")
if [ "$DROPPED" = "evet" ] && [ "${LEFT_REASON:-0}" -ge 1 ]; then
  ok "sürücülük $DROP_ELAPSED sn içinde düştü (driver.released · left_room)"
else
  no "sürücülük düşmedi (${DROP_ELAPSED}sn bekledi, left_room event: $LEFT_REASON)"
fi

###############################################################################
step "(regresyon) Hafta 1, 3 ve 4 kapıları + birim testler"
if npm test >"$TMP/unit.log" 2>&1; then
  ok "birim testler geçti ($(grep -o 'Tests.*passed' "$TMP/unit.log" | tail -1))"
else
  no "birim testler düştü"; tail -8 "$TMP/unit.log"
fi
stop_server
if bash scripts/week1-gate.sh >"$TMP/w1.log" 2>&1; then ok "Hafta 1 kapısı"; else no "Hafta 1 kapısı düştü"; tail -6 "$TMP/w1.log"; fi
if bash scripts/week3-gate.sh >"$TMP/w3.log" 2>&1; then ok "Hafta 3 kapısı"; else no "Hafta 3 kapısı düştü"; tail -6 "$TMP/w3.log"; fi
if bash scripts/week4-gate.sh >"$TMP/w4.log" 2>&1; then ok "Hafta 4 kapısı"; else no "Hafta 4 kapısı düştü"; tail -6 "$TMP/w4.log"; fi

trap - EXIT
cleanup

echo ""
echo "──────────────────────────────"
echo "Geçen: $PASS   Kalan: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "HAFTA 5 KAPISI GEÇİLEMEDİ."
  exit 1
fi
echo "HAFTA 5 KAPISI GEÇİLDİ — gerçek agent'la aktör etiketi ve kesme ayrı: npm run gate:w5:agent"
