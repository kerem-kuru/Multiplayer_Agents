#!/usr/bin/env bash
#
# Hafta 4 kapısının AGENT GEREKTİREN kontrolü.
#
#   npm run gate:w4:agent
#
# Ana kapı (gate:w4) redaction'ı dev ucuyla ölçüyor: aynı geçit, aynı DB,
# aynı SSE — ama deterministik ve ücretsiz. Burada ölçülen tek şey farklı:
# GERÇEK agent, gerçek bir dosyayı gerçekten okuduğunda da secret log'a
# girmiyor mu? Yani runner → appendEvent yolunun tamamı.
#
# Anahtar/kota yoksa ATLAR (başarısız saymaz).
set -uo pipefail
export MSYS_NO_PATHCONV=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# Hafta 7: /room named volume; oda dosyalarina container uzerinden erisilir.
. "$ROOT/scripts/lib/room-exec.sh"

PORT="${GATE_PORT:-8799}"
BASE="http://localhost:$PORT"
export DATABASE_URL="${DATABASE_URL:-postgres://rooms:Kk2007..@localhost:5433/agent_rooms}"
ROOM_CONFIG="${ROOM_CONFIG:-config/room.gemini.yaml}"
AGENT="${E2E_AGENT:-backend}"
TURN_TIMEOUT="${TURN_TIMEOUT:-180}"

PASS=0; FAIL=0
SERVER_PID=""; ROOM=""; SID=""
TMP=".gate4a-tmp-$$"
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

# SAHTE değerler; formatları gerçek.
S_ANT="sk-ant-api03-AgentGateFakeKeyAbCdEfGhIj"
S_AWS="AKIAIOSFODNN7EXAMPLE"
S_DB="agent-gate-fake-password-7pQ"

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

echo "Hafta 4 — agent kontrolü ($ROOM_CONFIG)"

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

AUTH_DEV_MODE=true ROOM_CONFIG="$ROOM_CONFIG" PORT="$PORT" node apps/api/dist/index.js >"$TMP/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 40); do
  [ "$(curl -s --max-time 5 "$BASE/health" | jget ok)" = "true" ] && break
  sleep 0.5
done

SESSION=$(node scripts/dev-login.mjs --base "$BASE" --email "gate4agent-$$-$(date +%s)@rooms.local")
gcurl() { curl -s --max-time 60 -b "rooms_session=$SESSION" "$@"; }

CREATE=$(gcurl -X POST "$BASE/rooms" -H 'content-type: application/json' -d '{}')
ROOM=$(echo "$CREATE" | jget room.id)
SID=$(echo "$CREATE" | jget session.id)
if [ -z "$ROOM" ]; then echo "oda açılamadı: $CREATE"; exit 1; fi

# --- 1: odaya SAHTE bir .env koy -------------------------------------------
step "1) Odaya sahte .env yazıldı"
# Hafta 7: dosya container ICINDE ve AGENTIN KENDI kullanicisiyla yaziliyor.
# root ile yazilsaydi agent kendi worktree'sindeki dosyayi degistiremez ve
# kapi urunu haksiz yere suclardi.
WORKTREE="/room/worktrees/$AGENT"
room_sh "$ROOM" "agent-$AGENT" "cat > $WORKTREE/.env <<'ENVEOF'
ANTHROPIC_API_KEY=$S_ANT
AWS_ACCESS_KEY_ID=$S_AWS
DB_PASSWORD=$S_DB
PORT=8787
ENVEOF" >/dev/null
if room_sh "$ROOM" "agent-$AGENT" "test -f $WORKTREE/.env" >/dev/null; then
  ok "$WORKTREE/.env (sahte değerler)"
else
  no ".env yazılamadı"
fi

# --- 2: agent'a okut --------------------------------------------------------
step "2) Agent dosyayı okuyor"
gcurl -o /dev/null -X POST "$BASE/rooms/$ROOM/agents/$AGENT/start"
for _ in $(seq 1 60); do
  ST=$(gcurl "$BASE/rooms/$ROOM/agents" | node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      const a=JSON.parse(s).agents||[];
      console.log(a.find(x=>x.name===process.argv[1])?.runtime?.status ?? "?");
    });' "$AGENT")
  [ "$ST" = "idle" ] && break
  sleep 1
done
if [ "$ST" != "idle" ]; then no "agent hazır olmadı (durum=$ST)"; fi

gcurl -o /dev/null -X POST "$BASE/rooms/$ROOM/agents/$AGENT/message" \
  -H 'content-type: application/json' \
  -d '{"text":"worktrees/'"$AGENT"'/.env dosyasini cat ile oku ve iceriğini oldugu gibi goster."}'

DONE=0
for _ in $(seq 1 "$TURN_TIMEOUT"); do
  N=$(psql_q "SELECT count(*) FROM session_events WHERE session_id='$SID' AND type IN ('turn.completed','turn.failed')")
  if [ "$N" != "0" ]; then DONE=1; break; fi
  sleep 1
done
if [ "$DONE" = "1" ]; then ok "turn bitti"; else no "turn $TURN_TIMEOUT sn içinde bitmedi"; fi

# --- 3: secret log'a girdi mi ----------------------------------------------
step "3) Gerçek agent çıktısında secret yok"
LEAKS=0
for s in "$S_ANT" "$S_AWS" "$S_DB"; do
  N=$(psql_q "SELECT count(*) FROM session_events WHERE session_id='$SID' AND payload::text LIKE '%$s%'")
  if [ "$N" != "0" ]; then LEAKS=$((LEAKS + 1)); echo "    sızan: $s"; fi
done
TOOLS=$(psql_q "SELECT count(*) FROM session_events WHERE session_id='$SID' AND type='tool.result'")
if [ "$LEAKS" = "0" ]; then
  ok "üç sahte secret de DB'de yok (tool.result sayısı: $TOOLS)"
else
  no "$LEAKS secret log'a girdi"
fi

step "4) Bulgu kaydı"
FC=$(psql_q "SELECT count(*) FROM redaction_findings WHERE session_id='$SID'")
if [ "$FC" -ge 1 ]; then
  ok "$FC bulgu yazıldı"
else
  echo "  · bulgu yok — koşum ortamı dosya içeriğini hiç vermemiş olabilir"
  echo "    (Gemini tool çıktısının metnini vermiyor; bu bir sızıntı değil)"
fi

trap - EXIT
cleanup

echo ""
echo "──────────────────────────────"
echo "Geçen: $PASS   Kalan: $FAIL"
if [ "$FAIL" -gt 0 ]; then echo "AGENT KONTROLÜ GEÇİLEMEDİ."; exit 1; fi
echo "AGENT KONTROLÜ GEÇİLDİ."
