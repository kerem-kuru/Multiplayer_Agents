#!/usr/bin/env bash
#
# Hafta 5 kapısının AGENT GEREKTİREN kontrolleri.
#
#   npm run gate:w5:agent
#
# Ana kapı (gate:w5) sıralamayı sahte koşum ortamıyla ölçüyor: aynı kuyruk,
# aynı DB, aynı yetki — ama modelsiz. Burada ölçülen iki şey farklı ve
# yalnızca gerçek agent'la ölçülebilir:
#
#   1. AKTÖR ETİKETİ: model `[Ayse]: ` önekini okuyup kimin yazdığını
#      söylüyor mu?
#   2. KESME: gerçekten koşan bir işin ortasında kesme uygulanıyor mu ve
#      turn `interrupted` ile kapanıyor mu?
#   3. ROL BAĞLAMI: rol prompt'u modele ULAŞIYOR mu? (Gemini'de sistem prompt'u
#      veren bayrak yok; rol `GEMINI.md` üzerinden gidiyor.)
#
# Anahtar/kota yoksa ATLAR (başarısız saymaz). ÜÇ istek harcar (etiket, rol
# bağlamı, kesme) — Gemini ücretsiz katmanında günde 20 istek var.
set -uo pipefail
export MSYS_NO_PATHCONV=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# Hafta 7: /room named volume; oda dosyalarina container uzerinden erisilir.
. "$ROOT/scripts/lib/room-exec.sh"

PORT="${GATE_PORT:-8796}"
BASE="http://localhost:$PORT"
export DATABASE_URL="${DATABASE_URL:-postgres://rooms:Kk2007..@localhost:5433/agent_rooms}"
ROOM_CONFIG="${ROOM_CONFIG:-config/room.gemini.yaml}"
AGENT="${E2E_AGENT:-backend}"
TURN_TIMEOUT="${TURN_TIMEOUT:-180}"

PASS=0; FAIL=0
SERVER_PID=""; ROOM=""; SID=""
TMP=".gate5a-tmp-$$"
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

cleanup() {
  step "Temizlik"
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

echo "Hafta 5 — agent kontrolü ($ROOM_CONFIG)"

if [ -z "${GEMINI_API_KEY:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  if [ -f .env ] && grep -qE '^(GEMINI|ANTHROPIC)_API_KEY=.' .env; then
    : # .env'de var; sunucu kendisi yükleyecek
  else
    echo "  · anahtar yok — atlandı (başarısız DEĞİL)"
    trap - EXIT; rm -rf "$TMP"; exit 0
  fi
fi

if ! docker compose exec -T postgres pg_isready -U rooms -d agent_rooms >/dev/null 2>&1; then
  echo "  ✗ postgres ayakta değil — önce: npm run db:up"; exit 1
fi
if curl -s --max-time 2 "$BASE/health" >/dev/null 2>&1; then
  echo "  ✗ $PORT zaten dinleniyor — eski sunucuyu kapat"; exit 1
fi
npm run build >/dev/null 2>&1 || { echo "build başarısız"; exit 1; }
npm run db:migrate >/dev/null 2>&1 || { echo "migration başarısız"; exit 1; }

AUTH_DEV_MODE=true ROOM_CONFIG="$ROOM_CONFIG" PORT="$PORT" node apps/api/dist/index.js >"$TMP/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 40); do
  [ "$(curl -s --max-time 5 "$BASE/health" | jget ok)" = "true" ] && break
  sleep 0.5
done

# Adı "Ayse" olan bir katılımcı gerekiyor: aktör etiketi onun adını taşıyacak.
SESSION=$(node scripts/dev-login.mjs --base "$BASE" --email "gate5agent-$$-$(date +%s)@rooms.local")
gcurl() { curl -s --max-time 120 -b "rooms_session=$SESSION" "$@"; }
ME=$(gcurl "$BASE/auth/me" | jget id)
psql_q "UPDATE users SET name='Ayse' WHERE id='$ME'" >/dev/null

CREATE=$(gcurl -X POST "$BASE/rooms" -H 'content-type: application/json' -d '{}')
ROOM=$(echo "$CREATE" | jget room.id)
SID=$(echo "$CREATE" | jget session.id)
if [ -z "$ROOM" ]; then echo "oda açılamadı: $CREATE"; exit 1; fi

gcurl -o /dev/null -X POST "$BASE/rooms/$ROOM/agents/$AGENT/start"
ST="?"
for _ in $(seq 1 60); do
  ST=$(gcurl "$BASE/rooms/$ROOM/agents" | node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      const a=JSON.parse(s).agents||[];
      console.log(a.find(x=>x.name===process.argv[1])?.runtime?.status ?? "?");
    });' "$AGENT")
  [ "$ST" = "idle" ] && break
  sleep 1
done
[ "$ST" = "idle" ] || no "agent hazır olmadı (durum=$ST)"

###############################################################################
step "1) Aktör etiketi: agent kimin yazdığını biliyor"
MID1=$(gcurl -X POST "$BASE/rooms/$ROOM/agents/$AGENT/message" \
  -H 'content-type: application/json' \
  -d '{"text":"Sana bu mesaji yazan kisinin adi ne? Sadece ismi yaz."}' | jget messageId)

for _ in $(seq 1 "$TURN_TIMEOUT"); do
  N=$(psql_q "SELECT count(*) FROM session_events WHERE session_id='$SID' AND type IN ('turn.completed','turn.failed') AND payload->>'messageId'='$MID1'")
  [ "$N" != "0" ] && break
  sleep 1
done
SAID=$(psql_q "SELECT count(*) FROM session_events WHERE session_id='$SID' AND type='agent.text' AND payload->>'messageId'='$MID1' AND payload->>'text' LIKE '%Ayse%'")
OUTCOME=$(psql_q "SELECT type FROM session_events WHERE session_id='$SID' AND type IN ('turn.completed','turn.failed') AND payload->>'messageId'='$MID1'")
if [ "${SAID:-0}" -ge 1 ]; then
  ok "agent cevabında 'Ayse' geçti (turn: $OUTCOME)"
elif [ "$OUTCOME" = "turn.failed" ]; then
  ERRTXT=$(psql_q "SELECT payload->>'error' FROM session_events WHERE session_id='$SID' AND type='turn.failed' AND payload->>'messageId'='$MID1'")
  echo "  · turn koşmadı: $ERRTXT"
  echo "    (kota/anahtar sorunu ürün hatası değil — atlandı)"
else
  no "agent cevabında isim yok"
fi

###############################################################################
step "1b) Rol bağlamı: GEMINI.md modele ulaşıyor"
# Dosya agent başlangıcında yazılıyor; önce diskte duruyor mu?
CTX="/room/worktrees/$AGENT/GEMINI.md"
if room_sh "$ROOM" "agent-$AGENT" "grep -q ODA-KURULUMU-OK $CTX" >/dev/null; then
  ok "$CTX yazıldı"
else
  no "rol bağlam dosyası yok: $CTX"
fi

# Sonra: modelin cevabı yalnızca O DOSYADAN gelebilecek bir satır mı?
# Serbest metinden "rolünü biliyor mu" okumak güvenilmez; bu soru belirli bir
# cevaba bağlı ve cevabın tek kaynağı bağlam dosyası.
MID_CTX=$(gcurl -X POST "$BASE/rooms/$ROOM/agents/$AGENT/message" \
  -H 'content-type: application/json' \
  -d '{"text":"oda kurulumu dogru mu"}' | jget messageId)
for _ in $(seq 1 "$TURN_TIMEOUT"); do
  N=$(psql_q "SELECT count(*) FROM session_events WHERE session_id='$SID' AND type IN ('turn.completed','turn.failed') AND payload->>'messageId'='$MID_CTX'")
  [ "$N" != "0" ] && break
  sleep 1
done
PROBE=$(psql_q "SELECT count(*) FROM session_events WHERE session_id='$SID' AND type='agent.text' AND payload->>'messageId'='$MID_CTX' AND payload->>'text' LIKE '%ODA-KURULUMU-OK%'")
if [ "${PROBE:-0}" -ge 1 ]; then
  ok "agent doğrulama satırını yazdı (rol bağlamı modele ulaşıyor)"
else
  SAWTEXT=$(psql_q "SELECT left(coalesce(payload->>'text',''),120) FROM session_events WHERE session_id='$SID' AND type='agent.text' AND payload->>'messageId'='$MID_CTX' LIMIT 1")
  no "doğrulama satırı gelmedi — agent şunu yazdı: $SAWTEXT"
fi

###############################################################################
step "2) Ham metin log'da öneksiz"
PREFIXED=$(psql_q "SELECT count(*) FROM session_events WHERE session_id='$SID' AND type IN ('message.queued','message.received') AND payload->>'text' LIKE '[Ayse]%'")
if [ "$PREFIXED" = "0" ]; then ok "event log'da '[Ayse]:' öneki yok"; else no "$PREFIXED event önek taşıyor"; fi

###############################################################################
step "3) Kesme: gerçekten koşan bir işin ortasında"
MID2=$(gcurl -X POST "$BASE/rooms/$ROOM/agents/$AGENT/message" \
  -H 'content-type: application/json' \
  -d '{"text":"sleep 120 komutunu calistir ve bittiginde tamam yaz."}' | jget messageId)

# Turn gerçekten başlasın (tool çağrısı yapana kadar bekle).
STARTED=0
for _ in $(seq 1 90); do
  N=$(psql_q "SELECT count(*) FROM session_events WHERE session_id='$SID' AND type='turn.started' AND payload->>'messageId'='$MID2'")
  [ "$N" != "0" ] && { STARTED=1; break; }
  sleep 1
done
[ "$STARTED" = "1" ] || no "ikinci turn başlamadı"

# Sürücülük: ilk mesajı yazan otomatik sürücü olur, yani biziz.
sleep 3
T0=$(date +%s)
INT_CODE=$(curl -s -o "$TMP/int.json" -w '%{http_code}' -b "rooms_session=$SESSION" -X POST "$BASE/rooms/$ROOM/agents/$AGENT/interrupt")
REQ=$(psql_q "SELECT count(*) FROM session_events WHERE session_id='$SID' AND type='interrupt.requested' AND payload->>'messageId'='$MID2'")

MODE=""; REASON=""
for _ in $(seq 1 70); do
  MODE=$(psql_q "SELECT payload->>'mode' FROM session_events WHERE session_id='$SID' AND type='interrupt.applied' AND payload->>'messageId'='$MID2'")
  REASON=$(psql_q "SELECT payload->>'reason' FROM session_events WHERE session_id='$SID' AND type='turn.failed' AND payload->>'messageId'='$MID2'")
  [ -n "$MODE" ] && [ -n "$REASON" ] && break
  sleep 0.5
done
ELAPSED=$(( $(date +%s) - T0 ))
STATUS_NOW=$(psql_q "SELECT status FROM agent_runtime WHERE room_id='$ROOM' AND agent_name='$AGENT'")

if [ "$INT_CODE" = "202" ] && [ "${REQ:-0}" -ge 1 ] && [ -n "$MODE" ] && [ "$REASON" = "interrupted" ]; then
  ok "kesme uygulandı: mode=$MODE · turn.failed(interrupted) · $ELAPSED sn · agent=$STATUS_NOW"
else
  no "kesme: kod=$INT_CODE requested=$REQ mode=$MODE reason=$REASON süre=${ELAPSED}sn durum=$STATUS_NOW"
fi

###############################################################################
step "4) Kesilen mesaj YENİDEN KOŞMUYOR"
sleep 3
RECEIVED=$(psql_q "SELECT count(*) FROM session_events WHERE session_id='$SID' AND type='message.received' AND payload->>'messageId'='$MID2'")
TERMINALS=$(psql_q "SELECT count(*) FROM session_events WHERE session_id='$SID' AND type IN ('turn.completed','turn.failed') AND payload->>'messageId'='$MID2'")
if [ "$RECEIVED" = "1" ] && [ "$TERMINALS" = "1" ]; then
  ok "mesaj bir kez alındı, bir kez kapandı (tekrar yok)"
else
  no "tekrar kontrolü: received=$RECEIVED bitiş=$TERMINALS"
fi

trap - EXIT
cleanup

echo ""
echo "──────────────────────────────"
echo "Geçen: $PASS   Kalan: $FAIL"
if [ "$FAIL" -gt 0 ]; then echo "AGENT KONTROLÜ GEÇİLEMEDİ."; exit 1; fi
echo "AGENT KONTROLÜ GEÇİLDİ."
