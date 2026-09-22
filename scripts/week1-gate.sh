#!/usr/bin/env bash
#
# Hafta 1 kapısı — 10 kontrol. Hepsi geçmeden hafta bitmiş sayılmaz.
#
#   npm run gate
#
# Gerçek postgres + gerçek docker ister. Saf testler: npm test
#
# jq yerine node kullanılıyor — node zaten projenin çalışma zamanı, jq her
# makinede yok.
set -uo pipefail

# Git Bash yol dönüşümü docker argümanlarını bozuyor (/room → C:/Program Files/Git/room)
export MSYS_NO_PATHCONV=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${GATE_PORT:-8790}"
PORT2=$((PORT + 1))
BASE="http://localhost:$PORT"
export DATABASE_URL="${DATABASE_URL:-postgres://rooms:Kk2007..@localhost:5433/agent_rooms}"
# Hafta 7: /room artik named volume. Host oda dosyalarini GOREMIYOR; klasor
# kontrolleri container icinden yapiliyor.
. "$ROOT/scripts/lib/room-exec.sh"
TMP_YAML="$ROOT/.week1-gate.tmp.yaml"

PASS=0
FAIL=0
SERVER_PID=""
SERVER2_PID=""
ROOM_IDS=()

ok()   { echo "  ✓ $1"; PASS=$((PASS + 1)); }
no()   { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }
step() { echo ""; echo "$1"; }

# JSON'dan nokta yollu alan çek: echo "$json" | jget room.id
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

psql_q() {
  docker compose exec -T postgres psql -U rooms -d agent_rooms -tA -c "$1" 2>&1
}

cleanup() {
  step "10) Temizlik"
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  [ -n "$SERVER2_PID" ] && kill "$SERVER2_PID" 2>/dev/null
  rm -f "$TMP_YAML"

  local removed=0
  for id in "${ROOM_IDS[@]:-}"; do
    [ -z "$id" ] && continue
    for c in $(docker ps -aq --filter "label=agent-rooms.room=$id"); do
      docker rm -f "$c" >/dev/null 2>&1 && removed=$((removed + 1))
    done
  done
  local leftover
  leftover=$(docker ps -aq --filter "label=agent-rooms.room=${ROOM_IDS[0]:-yok}" | wc -l | tr -d ' ')
  if [ "$leftover" = "0" ]; then
    ok "script'in açtığı $removed container silindi"
  else
    no "container kaldı"
  fi
}
trap cleanup EXIT

wait_health() {
  local base="$1"
  for _ in $(seq 1 40); do
    if [ "$(curl -s "$base/health" | jget ok)" = "true" ]; then return 0; fi
    sleep 0.5
  done
  return 1
}

echo "Hafta 1 kapısı — $BASE"

# --- ön koşullar ----------------------------------------------------------
# Temiz makinede en sık düşülen yer burası: kapı postgres ve uygulanmış şema
# ister. Anlaşılmaz bir hata yerine ne yapılacağını söyle.
if ! docker compose exec -T postgres pg_isready -U rooms -d agent_rooms >/dev/null 2>&1; then
  echo "  ✗ postgres ayakta değil — önce: npm run db:up"
  exit 1
fi
if [ -z "$(psql_q "SELECT to_regclass('public.session_events')")" ]; then
  echo "  ✗ şema uygulanmamış — önce: npm run db:migrate"
  exit 1
fi

# --- hazırlık -------------------------------------------------------------
npm run build >/dev/null 2>&1 || { echo "build başarısız"; exit 1; }

# PORT prefix ile geçilmeli: .env içindeki PORT'u ezmek için ortamda olması şart
# (process.loadEnvFile ortamda tanımlı değişkeni ezmez).
AUTH_DEV_MODE=true PORT="$PORT" node apps/api/dist/index.js >/tmp/week1-gate-server.log 2>&1 &
SERVER_PID=$!
if ! wait_health "$BASE"; then
  echo "sunucu açılmadı. log:"; cat /tmp/week1-gate-server.log; exit 1
fi

# --- 1 --------------------------------------------------------------------
step "1) POST /rooms"
# Hafta 4: her uc uyelik ister. Kapi da normal giris yolundan gecer.
# Kapı e-postası HER KOŞUMDA FARKLI: magic link hız sınırı (5 dk'da 3)
# gerçek bir koruma ve kapıyı iki kez koşturmak onu tetikliyordu.
GATE_EMAIL="gate-$$-$(date +%s)@rooms.local"
SESSION=$(node scripts/dev-login.mjs --base "$BASE" --email $GATE_EMAIL)
AUTH=(-b "rooms_session=$SESSION")

CREATE=$(curl -s "${AUTH[@]}" -w '\n%{http_code}' -X POST "$BASE/rooms" \
  -H 'content-type: application/json' -H 'x-user-id: gate' -d '{}')
CODE=$(echo "$CREATE" | tail -1)
BODY=$(echo "$CREATE" | sed '$d')
ROOM_ID=$(echo "$BODY" | jget room.id)
SESSION_ID=$(echo "$BODY" | jget session.id)
AGENTS=$(echo "$BODY" | jget agents)
ROOM_IDS+=("$ROOM_ID")

if [ "$CODE" = "201" ] && [ -n "$ROOM_ID" ] && [ -n "$SESSION_ID" ] && [ -n "$AGENTS" ]; then
  ok "201 · room.id, session.id ve agents döndü ($ROOM_ID)"
else
  no "beklenen 201 + room.id/session.id/agents, gelen $CODE: $BODY"
  exit 1
fi

# --- 2 --------------------------------------------------------------------
step "2) Container ayakta"
RUNNING=$(docker ps --filter "label=agent-rooms.room=$ROOM_ID" --filter "status=running" -q | wc -l | tr -d ' ')
[ "$RUNNING" = "1" ] && ok "label=agent-rooms.room=$ROOM_ID ile 1 çalışan container" \
                     || no "çalışan container bulunamadı (bulunan: $RUNNING)"

# --- 3 --------------------------------------------------------------------
step "3) Klasör düzeni"
MISSING=""
# Agent adları YAML'dan geliyor — script hiçbir ismi varsaymıyor.
AGENT_NAMES=$(echo "$BODY" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    JSON.parse(s).agents.forEach(a=>console.log(a.name));
  });')
for a in $AGENT_NAMES; do
  room_sh "$ROOM_ID" root "test -d /room/worktrees/$a" >/dev/null || MISSING="$MISSING worktrees/$a"
done
room_sh "$ROOM_ID" root "test -d /room/contracts" >/dev/null || MISSING="$MISSING contracts"
room_sh "$ROOM_ID" root "test -d /room/journal"   >/dev/null || MISSING="$MISSING journal"
if [ -z "$MISSING" ]; then
  ok "$(echo "$AGENT_NAMES" | wc -l | tr -d ' ') worktree + contracts + journal var"
else
  no "eksik dizin:$MISSING"
fi

# --- 4 --------------------------------------------------------------------
step "4) Event'ler since=0"
EVENTS=$(curl -s "${AUTH[@]}" "$BASE/rooms/$ROOM_ID/events?since=0")
E1=$(echo "$EVENTS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const e=JSON.parse(s).events;console.log(e.map(x=>x.seq+":"+x.type).join(" "))});')
# Hafta 7: oda acilisi artik merkez depoyu kuruyor ve her agent icin klon
# aliyor. Sira: room.created -> room.repo_initialized -> agent.workspace_ready
# (agent basina bir tane) -> session.started. session.started EN SONDA kalmali:
# containerId'yi o tasiyor ve kurulum bitmeden yazilmamali.
E_FIRST=$(echo "$E1" | awk '{print $1}' | cut -d: -f2)
E_LAST=$(echo "$E1" | awk '{print $NF}' | cut -d: -f2)
E_HAS_REPO=$(echo "$E1" | grep -c "room.repo_initialized" || true)
E_READY=$(echo "$E1" | grep -o "agent.workspace_ready" | wc -l | tr -d ' ')
if [ "$E_FIRST" = "room.created" ] && [ "$E_LAST" = "session.started" ]    && [ "$E_HAS_REPO" = "1" ] && [ "$E_READY" -ge 1 ]; then
  ok "$E1"
else
  no "beklenen: room.created ... repo_initialized ... workspace_ready ... session.started, gelen '$E1'"
fi

# --- 5 --------------------------------------------------------------------
step "5) Elle event yaz, since ile geri oku"
NOTE=$(curl -s "${AUTH[@]}" -w '\n%{http_code}' -X POST "$BASE/sessions/$SESSION_ID/events" \
  -H 'content-type: application/json' \
  -d '{"type":"debug.note","payload":{"text":"kapi testi"}}')
NCODE=$(echo "$NOTE" | tail -1)
# Hafta 7: acilis event sayisi agent sayisina gore degisiyor; "since" sabit 2
# olamaz. Not yazilmadan ONCEKI son seq'ten devam ediliyor.
LAST_SEQ=$(echo "$EVENTS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const e=JSON.parse(s).events;console.log(e.length?e[e.length-1].seq:0)});')
SINCE2=$(curl -s "${AUTH[@]}" "$BASE/rooms/$ROOM_ID/events?since=$LAST_SEQ")
S2=$(echo "$SINCE2" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const e=JSON.parse(s).events;console.log(e.length+" "+e.map(x=>x.type).join(","))});')
if [ "$NCODE" = "201" ] && [ "$S2" = "1 debug.note" ]; then
  ok "201 · since=$LAST_SEQ sadece debug.note döndü"
else
  no "yazma $NCODE, since=$LAST_SEQ → '$S2'"
fi

# --- 6 --------------------------------------------------------------------
step "6) Eşzamanlılık: 50 istek, 20 paralel"
BEFORE=$(psql_q "SELECT count(*) FROM session_events WHERE session_id='$SESSION_ID'")
seq 1 50 | xargs -P 20 -I@@ curl -s -b "rooms_session=$SESSION" -o /dev/null -X POST "$BASE/sessions/$SESSION_ID/events" \
  -H 'content-type: application/json' -d '{"type":"debug.note","payload":{"text":"yuk-@@"}}'
STATS=$(psql_q "SELECT count(*)||' '||count(DISTINCT seq)||' '||max(seq) FROM session_events WHERE session_id='$SESSION_ID'")
read -r C_ALL C_DISTINCT C_MAX <<< "$STATS"
EXPECTED=$((BEFORE + 50))
if [ "$C_ALL" = "$C_DISTINCT" ] && [ "$C_ALL" = "$C_MAX" ] && [ "$C_ALL" = "$EXPECTED" ]; then
  ok "count=$C_ALL distinct=$C_DISTINCT max=$C_MAX — boşluk ve çakışma yok"
else
  no "count=$C_ALL distinct=$C_DISTINCT max=$C_MAX (beklenen $EXPECTED) — seq dağıtımı bozuk"
fi

# --- 7 --------------------------------------------------------------------
step "7) Şema koruması"
ROWS_BEFORE=$(psql_q "SELECT count(*) FROM session_events WHERE session_id='$SESSION_ID'")
BAD=$(curl -s "${AUTH[@]}" -o /dev/null -w '%{http_code}' -X POST "$BASE/sessions/$SESSION_ID/events" \
  -H 'content-type: application/json' -d '{"type":"uydurma","payload":{"x":1}}')
ROWS_AFTER=$(psql_q "SELECT count(*) FROM session_events WHERE session_id='$SESSION_ID'")
if [ "$BAD" = "400" ] && [ "$ROWS_BEFORE" = "$ROWS_AFTER" ]; then
  ok "400 döndü ve DB'ye satır yazılmadı ($ROWS_AFTER)"
else
  no "kod $BAD, satır $ROWS_BEFORE → $ROWS_AFTER"
fi

# --- 8 --------------------------------------------------------------------
step "8) Append-only"
UPD=$(psql_q "UPDATE session_events SET actor='{\"kind\":\"system\"}'::jsonb WHERE session_id='$SESSION_ID'")
if echo "$UPD" | grep -qi "append-only"; then
  ok "UPDATE veritabanı seviyesinde reddedildi"
else
  no "UPDATE engellenmedi: $UPD"
fi

# --- 9 --------------------------------------------------------------------
step "9) Üçüncü agent — kod değişikliği olmadan"
cat > "$TMP_YAML" <<'YAML'
version: 1
name: "Kapı testi — üç agent"
agents:
  - name: frontend
    systemPrompt: "frontend"
    workspace: worktrees/frontend
    writable: [worktrees/frontend, contracts]
  - name: backend
    systemPrompt: "backend"
    workspace: worktrees/backend
    writable: [worktrees/backend, contracts]
  - name: security
    systemPrompt: "security"
    workspace: worktrees/security
    # Hafta 7: journal root:root 0755 — hicbir agent yazamaz. Yazilabilir olan
    # tek iki sey: kendi worktree'si ve contracts.
    writable: [worktrees/security, contracts]
    readable: [worktrees/*]
YAML

AUTH_DEV_MODE=true PORT="$PORT2" ROOM_CONFIG=".week1-gate.tmp.yaml" node apps/api/dist/index.js \
  >/tmp/week1-gate-server2.log 2>&1 &
SERVER2_PID=$!
if wait_health "http://localhost:$PORT2"; then
  SESSION2=$(node scripts/dev-login.mjs --base "http://localhost:$PORT2" --email $GATE_EMAIL)
  BODY3=$(curl -s -b "rooms_session=$SESSION2" -X POST "http://localhost:$PORT2/rooms" -H 'content-type: application/json' -d '{}')
  ROOM3=$(echo "$BODY3" | jget room.id)
  ROOM_IDS+=("$ROOM3")
  HAS_SEC=$(echo "$BODY3" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{console.log(JSON.parse(s).agents.some(a=>a.name==="security"))});')
  if [ "$HAS_SEC" = "true" ] && room_sh "$ROOM3" root "test -d /room/worktrees/security" >/dev/null; then
    ok "3. agent YAML'a eklendi, worktrees/security açıldı, kod değişmedi"
  else
    no "agents içinde security=$HAS_SEC, klasör container'da yok"
  fi
  kill "$SERVER2_PID" 2>/dev/null
  SERVER2_PID=""
else
  no "ikinci sunucu açılmadı"; cat /tmp/week1-gate-server2.log
fi

# --- özet (10 cleanup trap'te) --------------------------------------------
trap - EXIT
cleanup

echo ""
echo "──────────────────────────────"
echo "Geçen: $PASS   Kalan: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "HAFTA 1 KAPISI GEÇİLEMEDİ."
  exit 1
fi
echo "HAFTA 1 KAPISI GEÇİLDİ."
