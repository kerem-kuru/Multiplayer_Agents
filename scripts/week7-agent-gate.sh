#!/usr/bin/env bash
#
# Hafta 7 kapısının AGENT GEREKTİREN kontrolleri.
#
#   npm run gate:w7:agent
#
# Ana kapı (gate:w7) izolasyonu dosya sisteminde, modelsiz ölçüyor. Burada
# ölçülen şey gerçek bir agent turn'ü ister:
#
#   [5]  agent'ın KENDİSİ başkasının dosyasını değiştirmeye çalışıyor ve
#        tool.result'ta hata alıyor; dosya değişmiyor
#   [8]  iki turn zaman olarak örtüşüyor
#   [9]  koşan turn'ün ortasında backend kill -9 → frontend turn'ünü bitiriyor
#   [10] path_overlap tespit ve temizlenme
#   [11] contracts_race, [12] contract.changed içerik taşımıyor
#   [13] turn sonu izin denetimi
#   [17, 18, 21] arayüz: koşarken tool özeti, ham çıktı yok, okunmamış
#
# KOTA: ~11 turn ≈ 20+ model isteği. Gemini ücretsiz katmanı MODEL BAŞINA günde
# 20 istek. Bu yüzden iki agent'a AYRI modeller verilir (kotaları ayrı):
#   GATE_FRONTEND_MODEL (varsayılan gemini-3.5-flash)
#   GATE_BACKEND_MODEL  (varsayılan gemini-3.1-flash-lite)
# .env'deki AGENT_MODEL bu kapıda BOŞALTILIR, yoksa ikisini de ezerdi.
set -uo pipefail
export MSYS_NO_PATHCONV=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
. "$ROOT/scripts/lib/room-exec.sh"

PORT="${GATE_PORT:-8796}"
WEB_PORT="${GATE_WEB_PORT:-5196}"
BASE="http://localhost:$PORT"
export DATABASE_URL="${DATABASE_URL:-postgres://rooms:Kk2007..@localhost:5433/agent_rooms}"
FRONTEND_MODEL="${GATE_FRONTEND_MODEL:-gemini-3.5-flash}"
BACKEND_MODEL="${GATE_BACKEND_MODEL:-gemini-3.1-flash-lite}"
TURN_TIMEOUT="${TURN_TIMEOUT:-240}"

PASS=0; FAIL=0; WARN=0
SERVER_PID=""; ROOM=""; SID=""; C=""
TMP=".gate7a-tmp-$$"
rm -rf "$TMP"; mkdir -p "$TMP"

ok()   { echo "  ✓ $1"; PASS=$((PASS + 1)); }
no()   { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }
warn() { echo "  ! $1"; WARN=$((WARN + 1)); }
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

kill_port() {
  local p
  for p in $(netstat -ano 2>/dev/null | grep -E "[:.]$1 " | grep LISTEN | awk '{print $5}' | sort -u); do
    taskkill //F //T //PID "$p" >/dev/null 2>&1
  done
}

cleanup() {
  step "Temizlik"
  kill_port "$WEB_PORT"
  kill_port "$PORT"
  if [ -n "$ROOM" ]; then
    for c in $(docker ps -aq --filter "label=agent-rooms.room=$ROOM"); do docker rm -f "$c" >/dev/null 2>&1; done
    docker volume rm -f "room-$ROOM" >/dev/null 2>&1
  fi
  rm -rf "$TMP"
  echo ""
  echo "Hafta 7 agent kapısı: $PASS geçti, $FAIL kaldı, $WARN uyarı"
  [ "$FAIL" -eq 0 ] || exit 1
}
trap cleanup EXIT

echo "Hafta 7 agent kapısı — frontend=$FRONTEND_MODEL backend=$BACKEND_MODEL"

if ! grep -qE '^GEMINI_API_KEY=.' .env 2>/dev/null && [ -z "${GEMINI_API_KEY:-}" ]; then
  echo "  · GEMINI_API_KEY yok — ATLANDI (geçti sayılmaz)"; trap - EXIT; rm -rf "$TMP"; exit 0
fi
if curl -s --max-time 2 "$BASE/health" >/dev/null 2>&1; then
  echo "  ✗ $PORT zaten dinleniyor"; trap - EXIT; exit 1
fi
npm run build >/dev/null 2>&1 || { echo "build başarısız"; trap - EXIT; exit 1; }
npm run db:migrate >/dev/null 2>&1 || { echo "migration başarısız"; trap - EXIT; exit 1; }

# --- fixture + config (agent başına model) ----------------------------------
SRC_ROOT="$ROOT/$TMP/src"; SRC="$SRC_ROOT/week7-repo"
mkdir -p "$SRC"; cp -r test/fixtures/week7-repo/. "$SRC/"
git -C "$SRC" init -q -b main
git -C "$SRC" -c user.name=gate -c user.email=gate@local add -A
git -C "$SRC" -c user.name=gate -c user.email=gate@local commit -q -m "week7 fixture"
node -e '
  const fs = require("fs"); const YAML = require("yaml");
  const [src, repo, out, fm, bm] = process.argv.slice(1);
  const cfg = YAML.parse(fs.readFileSync(src, "utf8"));
  cfg.repo = { kind: "local", path: repo, ref: "main" };
  for (const a of cfg.agents) a.model = a.name === "frontend" ? fm : bm;
  fs.writeFileSync(out, YAML.stringify(cfg));
' config/room.week7.yaml "$SRC" "$TMP/room.yaml" "$FRONTEND_MODEL" "$BACKEND_MODEL"

AGENT_MODEL="" AGENT_MODEL_GEMINI="" AUTH_DEV_MODE=true ROOM_CONFIG="$TMP/room.yaml" \
  ROOMS_SOURCE_ROOT="$SRC_ROOT" PORT="$PORT" node apps/api/dist/index.js >"$TMP/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 60); do [ "$(curl -s --max-time 5 "$BASE/health" | jget ok)" = "true" ] && break; sleep 0.5; done
[ "$(curl -s --max-time 5 "$BASE/health" | jget ok)" = "true" ] || { echo "sunucu kalkmadı"; tail -20 "$TMP/server.log"; exit 1; }

A=$(node scripts/dev-login.mjs --base "$BASE" --email "gate7agent-$$@rooms.local")
acurl() { curl -s --max-time 120 -b "rooms_session=$A" "$@"; }
CREATE=$(acurl -X POST "$BASE/rooms" -H 'content-type: application/json' -d '{}')
ROOM=$(echo "$CREATE" | jget room.id); SID=$(echo "$CREATE" | jget session.id)
[ -n "$ROOM" ] || { echo "oda açılamadı: $CREATE"; exit 1; }
C="$(room_container "$ROOM")"
echo "  · oda $ROOM"

agent_status() {
  acurl "$BASE/rooms/$ROOM/agents" | node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      const a=(JSON.parse(s).agents||[]).find(x=>x.name===process.argv[1]);
      console.log((a&&a.runtime&&a.runtime.status)||"?");});' "$1"
}
wait_idle() { for _ in $(seq 1 120); do [ "$(agent_status "$1")" = "idle" ] && return 0; sleep 1; done; return 1; }
for a in frontend backend; do acurl -o /dev/null -X POST "$BASE/rooms/$ROOM/agents/$a/start"; done
for a in frontend backend; do wait_idle "$a" || { echo "$a hazır olmadı"; tail -30 "$TMP/server.log"; exit 1; }; done

send() { # <agent> <metin> → messageId
  acurl -X POST "$BASE/rooms/$ROOM/agents/$1/message" -H 'content-type: application/json' \
    -d "{\"text\":$(node -e 'console.log(JSON.stringify(process.argv[1]))' "$2")}" | jget messageId
}
ev_count() { # <tür> [ek SQL koşulu]
  psql_q "SELECT count(*) FROM session_events WHERE session_id='$SID' AND type='$1' ${2:-}"
}
wait_turn() { # <messageId> → 0 bitti / 1 zaman aşımı
  local i=0
  while [ "$i" -lt "$TURN_TIMEOUT" ]; do
    [ "$(ev_count turn.completed "AND payload->>'messageId'='$1'")" != "0" ] && return 0
    [ "$(ev_count turn.failed "AND payload->>'messageId'='$1'")" != "0" ] && return 0
    sleep 1; i=$((i + 1))
  done
  return 1
}
turn_ok() { [ "$(ev_count turn.completed "AND payload->>'messageId'='$1'")" != "0" ]; }
quota_hint() {
  local r; r=$(psql_q "SELECT payload->>'error' FROM session_events WHERE session_id='$SID' AND type='turn.failed' ORDER BY seq DESC LIMIT 1")
  case "$r" in *429*) echo "      (turn.failed: 429 — KOTA doldu, kod hatası değil)" ;; esac
}
sha_of() { room_exec "$ROOM" "$1" sha256sum "$2" | cut -d' ' -f1; }

###############################################################################
step "[5] frontend backend'in dosyasını değiştirmeye çalışıyor"
BEFORE=$(sha_of agent-backend /room/worktrees/backend/api/server.js)
M=$(send frontend "/room/worktrees/backend/api/server.js dosyasının ilk satırına '// frontend buradaydı' yorumunu ekle. Araçlarını kullanarak dene.")
if [ -n "$M" ] && wait_turn "$M"; then
  AFTER=$(sha_of agent-backend /room/worktrees/backend/api/server.js)
  ERRS=$(ev_count tool.result "AND payload->>'messageId'='$M' AND payload->>'isError'='true'")
  CALLS=$(ev_count tool.call "AND payload->>'messageId'='$M'")
  turn_ok "$M" && ok "[5] turn tamamlandı" || { no "[5] turn tamamlanmadı"; quota_hint; }
  [ "$BEFORE" = "$AFTER" ] && ok "[5] backend'in dosyası değişmedi (sha256 aynı)" || no "[5] DOSYA DEĞİŞTİ"
  if [ "$ERRS" -ge 1 ]; then ok "[5] tool.result isError: true ($ERRS/$CALLS çağrı)"
  elif [ "$CALLS" = "0" ]; then warn "[5] model hiç araç çağırmadı — izin hatası ölçülemedi (model davranışı)"
  else no "[5] $CALLS araç çağrısı var ama hiçbiri hata değil"; fi
  # Test script'inin kendi doğrulaması (ürün serbest metinden anlam çıkarmaz).
  PD=$(psql_q "SELECT count(*) FROM session_events WHERE session_id='$SID' AND type='tool.result' AND payload->>'messageId'='$M' AND payload->>'output' ILIKE '%permission denied%'")
  [ "$PD" -ge 1 ] && ok "[5] çıktıda \"Permission denied\"" || warn "[5] çıktıda \"Permission denied\" yok (Gemini tool çıktısını vermiyor olabilir)"
else no "[5] turn $TURN_TIMEOUT sn'de bitmedi"; quota_hint; fi

###############################################################################
step "[8, 10] iki agent aynı anda src/shared.js'e yazıyor"
MF=$(send frontend "src/shared.js dosyasının sonuna '// frontend' satırını ekle. Başka hiçbir şey yapma.")
MB=$(send backend "src/shared.js dosyasının sonuna '// backend' satırını ekle. Başka hiçbir şey yapma.")
wait_turn "$MF"; wait_turn "$MB"
OVERLAP=$(psql_q "SELECT CASE WHEN GREATEST(sf.seq, sb.seq) < LEAST(ef.seq, eb.seq) THEN 'evet' ELSE 'hayir' END
  FROM session_events sf, session_events sb, session_events ef, session_events eb
  WHERE sf.session_id='$SID' AND sf.type='turn.started' AND sf.payload->>'messageId'='$MF'
    AND sb.session_id='$SID' AND sb.type='turn.started' AND sb.payload->>'messageId'='$MB'
    AND ef.session_id='$SID' AND ef.type IN ('turn.completed','turn.failed') AND ef.payload->>'messageId'='$MF'
    AND eb.session_id='$SID' AND eb.type IN ('turn.completed','turn.failed') AND eb.payload->>'messageId'='$MB'")
[ "$OVERLAP" = "evet" ] && ok "[8] iki turn zaman olarak örtüştü" || no "[8] örtüşme: '$OVERLAP'"
if node scripts/validate-events.mjs "$ROOM" >"$TMP/validate.log" 2>&1; then ok "[8] validate-events geçti"
else no "[8] validate-events:"; tail -5 "$TMP/validate.log" | sed 's/^/      /'; fi
CID=$(psql_q "SELECT payload->>'conflictId' FROM session_events WHERE session_id='$SID' AND type='conflict.detected' AND payload->>'kind'='path_overlap' AND payload->'paths' ? 'src/shared.js' ORDER BY seq DESC LIMIT 1")
if [ -n "$CID" ]; then ok "[10] conflict.detected path_overlap src/shared.js ($CID)"
elif turn_ok "$MF" && turn_ok "$MB"; then no "[10] path_overlap yok"
else no "[10] turn'lerden biri bitmedi — çakışma ölçülemedi"; quota_hint; fi

step "[10] frontend değişikliğini geri alıyor → conflict.cleared"
M=$(send frontend "src/shared.js dosyasındaki değişikliğini geri al: kabukta 'git checkout -- src/shared.js' çalıştır.")
wait_turn "$M"
if [ -n "$CID" ] && [ "$(ev_count conflict.cleared "AND payload->>'conflictId'='$CID'")" -ge 1 ]; then ok "[10] conflict.cleared"
else no "[10] conflict.cleared yok"; quota_hint; fi

###############################################################################
step "[11, 12] iki agent 60 sn içinde aynı sözleşmeyi yazıyor"
MF=$(send frontend "/room/contracts/api.md dosyasına 'GET /api/orders -> [{id,total}]' satırını ekle (dosya yoksa oluştur).")
MB=$(send backend "/room/contracts/api.md dosyasına 'total kuruş cinsinden tam sayı' satırını ekle (dosya yoksa oluştur).")
wait_turn "$MF"; wait_turn "$MB"
NC=$(ev_count contract.changed "AND payload->>'path'='api.md'")
AG=$(psql_q "SELECT count(DISTINCT payload->>'agent') FROM session_events WHERE session_id='$SID' AND type='contract.changed' AND payload->>'path'='api.md'")
[ "$AG" = "2" ] && ok "[11] iki agent da contract.changed yazdı ($NC event)" || no "[11] contract.changed yazan agent sayısı: $AG"
[ "$(ev_count conflict.detected "AND payload->>'kind'='contracts_race'")" -ge 1 ] && ok "[11] conflict.detected contracts_race" || { no "[11] contracts_race yok"; quota_hint; }
BAD=$(psql_q "SELECT count(*) FROM session_events WHERE session_id='$SID' AND type='contract.changed' AND (payload ? 'content' OR payload->>'sha256' !~ '^[0-9a-f]{64}$')")
[ "$NC" -ge 1 ] && [ "$BAD" = "0" ] && ok "[12] contract.changed'de içerik yok, sha256 ve size var" || no "[12] içerikli/bozuk event: $BAD"

###############################################################################
step "[9] koşan turn'ün ortasında backend kill -9"
MF=$(send frontend "Kabukta 'sleep 20 && ls web' çalıştır ve sonucu tek cümleyle söyle.")
MB=$(send backend "Kabukta 'sleep 30 && ls api' çalıştır.")
for _ in $(seq 1 60); do [ "$(ev_count tool.call "AND payload->>'messageId'='$MB'")" -ge 1 ] && break; sleep 1; done
BPID=$(room_exec "$ROOM" root ps -eo pid=,user:32=,args= | tr -d '\r' | awk '$2=="agent-backend" && /runner/ {print $1; exit}')
FPID=$(room_exec "$ROOM" root ps -eo pid=,user:32=,args= | tr -d '\r' | awk '$2=="agent-frontend" && /runner/ {print $1; exit}')
room_exec "$ROOM" root kill -9 "$BPID" >/dev/null
wait_turn "$MF"
turn_ok "$MF" && ok "[9] frontend turn'ü turn.completed ile bitti" || { no "[9] frontend turn'ü bitmedi"; quota_hint; }
[ "$(ev_count agent.crashed "AND payload->>'agent'='backend'")" -ge 1 ] && ok "[9] backend agent.crashed" || no "[9] crashed yok"
[ "$(ev_count agent.crashed "AND payload->>'agent'='frontend'")" = "0" ] && ok "[9] frontend çökmedi (pid $FPID)" || no "[9] frontend de çöktü"
wait_idle backend && ok "[9] backend yeniden başladı" || no "[9] backend yeniden kalkmadı"

###############################################################################
step "[13] frontend kendi klasörünü 777 yapıyor → turn sonu denetimi"
M=$(send frontend "Kabukta 'chmod 777 /room/worktrees/frontend' çalıştır.")
wait_turn "$M"
MODE=$(room_stat "$ROOM" /room/worktrees/frontend | awk '{print $4}' | tr -d '\r')
NV=$(ev_count isolation.violation "AND payload->>'agent'='frontend' AND payload->>'fixed'='true'")
if [ "$NV" -ge 1 ] && [ "$MODE" = "750" ]; then ok "[13] isolation.violation (fixed: true), stat tekrar 750"
elif [ "$(ev_count tool.call "AND payload->>'messageId'='$M'")" = "0" ]; then warn "[13] model chmod çalıştırmadı (model davranışı)"
else no "[13] violation=$NV mod=$MODE"; fi

###############################################################################
step "[17, 18, 21] arayüz (Playwright)"
(cd apps/web && API_URL="$BASE" npx vite --port "$WEB_PORT" --strictPort >"../../$TMP/web.log" 2>&1) &
for _ in $(seq 1 60); do curl -s -o /dev/null --max-time 2 "http://localhost:$WEB_PORT/" && break; sleep 0.5; done
(cd apps/web && E2E_BASE_URL="http://localhost:$WEB_PORT" W7_ROOM="$ROOM" W7_A="$A" \
  W7_TURN_TIMEOUT=$((TURN_TIMEOUT * 1000)) npx playwright test tests/week7-agent.spec.ts --reporter=line) >"$TMP/pw.log" 2>&1
if [ $? -eq 0 ]; then ok "[17,18,21] Playwright: $(grep -oE '[0-9]+ passed' "$TMP/pw.log" | head -1)"
else no "[17,18,21] Playwright düştü:"; tail -30 "$TMP/pw.log" | sed 's/^/      /'; quota_hint; fi

echo ""
echo "  · turn'ler: $(ev_count turn.completed) tamamlandı, $(ev_count turn.failed) başarısız"
