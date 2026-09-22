#!/usr/bin/env bash
#
# Hafta 2 kapısı — 14 kontrol. GERÇEK API çağrısı yapar.
#
#   npm run gate:w2
#
# Maliyeti düşük tutmak için AGENT_MODEL=haiku ile koşar.
set -uo pipefail
export MSYS_NO_PATHCONV=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${GATE_PORT:-8792}"
PORT2=$((PORT + 1))
BASE="http://localhost:$PORT"
export DATABASE_URL="${DATABASE_URL:-postgres://rooms:Kk2007..@localhost:5433/agent_rooms}"
# Hafta 7: /room named volume; dosyalar container icinden okunuyor.
. "$ROOT/scripts/lib/room-exec.sh"
TMP_YAML="$ROOT/.week2-gate.tmp.yaml"
GATE_MODEL="${AGENT_MODEL:-haiku}"

PASS=0; FAIL=0
SERVER_PID=""; SERVER2_PID=""
ROOM_IDS=()
AGENT="backend"

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

psql_q() { docker compose exec -T postgres psql -U rooms -d agent_rooms -tA -c "$1" 2>&1; }

api() { # method path [body]
  local m="$1" p="$2" b="${3:-}"
  if [ -n "$b" ]; then
    curl -s -b "rooms_session=$SESSION" -X "$m" "$BASE$p" -H 'content-type: application/json' -d "$b"
  else
    curl -s -b "rooms_session=$SESSION" -X "$m" "$BASE$p"
  fi
}

agent_status() { api GET "/rooms/$1/agents" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    const a=(JSON.parse(s).agents||[]).find(x=>x.name===process.argv[1]);
    console.log(a && a.runtime ? a.runtime.status : "");
  });' "$AGENT"; }

# Event listesini tek JSON dizisi olarak ver.
events_json() { api GET "/rooms/$1/events?since=0&limit=1000" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    try { console.log(JSON.stringify(JSON.parse(s).events||[])); } catch { console.log("[]"); }
  });'; }

wait_status() { # roomId expected timeoutSec
  local room="$1" want="$2" limit="${3:-180}" waited=0
  while [ "$waited" -lt "$limit" ]; do
    [ "$(agent_status "$room")" = "$want" ] && return 0
    sleep 2; waited=$((waited + 2))
  done
  return 1
}

wait_health() {
  for _ in $(seq 1 40); do
    [ "$(curl -s "$1/health" | jget ok)" = "true" ] && return 0
    sleep 0.5
  done
  return 1
}

cleanup() {
  step "14) Temizlik"
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
  ok "script'in açtığı $removed container silindi"
}
trap cleanup EXIT

# --- ön koşullar ----------------------------------------------------------
echo "Hafta 2 kapısı — $BASE (model: $GATE_MODEL)"

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  # .env'den okumayı dene
  if [ -f .env ]; then
    KEY_LINE=$(grep -E '^ANTHROPIC_API_KEY=.+' .env || true)
    [ -n "$KEY_LINE" ] && export ANTHROPIC_API_KEY="${KEY_LINE#ANTHROPIC_API_KEY=}"
  fi
fi
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "  ✗ ANTHROPIC_API_KEY yok — Hafta 2 kapısı gerçek API çağrısı yapar."
  echo "    .env içine ekle veya ortamda tanımla."
  exit 1
fi
if ! docker compose exec -T postgres pg_isready -U rooms -d agent_rooms >/dev/null 2>&1; then
  echo "  ✗ postgres ayakta değil — önce: npm run db:up"; exit 1
fi
if [ -z "$(psql_q "SELECT to_regclass('public.agent_runtime')")" ]; then
  echo "  ✗ 002 migration uygulanmamış — önce: npm run db:migrate"; exit 1
fi

npm run build >/dev/null 2>&1 || { echo "build başarısız"; exit 1; }
# İmaj da yeniden kurulmalı: protokol şeması değiştiyse bayat imajdaki runner
# bilinmeyen alanlara takılıp çökme döngüsüne girer.
npm run room:build >/dev/null 2>&1 || { echo "oda imajı build başarısız"; exit 1; }

AUTH_DEV_MODE=true PORT="$PORT" AGENT_MODEL="$GATE_MODEL" node apps/api/dist/index.js >/tmp/week2-server.log 2>&1 &
SERVER_PID=$!
wait_health "$BASE" || { echo "sunucu açılmadı"; cat /tmp/week2-server.log; exit 1; }

# Hafta 4: her uc uyelik ister. Kapi da normal giris yolundan gecer.
# Kapı e-postası HER KOŞUMDA FARKLI: magic link hız sınırı (5 dk'da 3)
# gerçek bir koruma ve kapıyı iki kez koşturmak onu tetikliyordu.
GATE_EMAIL="gate-$$-$(date +%s)@rooms.local"
SESSION=$(node scripts/dev-login.mjs --base "$BASE" --email $GATE_EMAIL)

# --- 1 --------------------------------------------------------------------
step "1) Oda ve agent listesi"
CREATE=$(api POST /rooms '{}')
ROOM=$(echo "$CREATE" | jget room.id)
ROOM_IDS+=("$ROOM")
if [ -z "$ROOM" ]; then no "oda açılamadı: $CREATE"; exit 1; fi
ALL_STOPPED=$(api GET "/rooms/$ROOM/agents" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    const a=JSON.parse(s).agents||[];
    console.log(a.length>0 && a.every(x=>x.runtime && x.runtime.status==="stopped"));
  });')
[ "$ALL_STOPPED" = "true" ] && ok "oda açıldı, tüm agent'lar stopped ($ROOM)" \
                            || no "agent'lar stopped değil"

# --- 2 --------------------------------------------------------------------
step "2) Görev gönder"
TASK='{"text":"Bulunduğun klasörde hello.js adında, konsola '"'"'merhaba oda'"'"' yazdıran bir dosya oluştur ve node ile çalıştırıp çıktısını doğrula."}'
MSG=$(api POST "/rooms/$ROOM/agents/$AGENT/message" "$TASK")
MSG_ID=$(echo "$MSG" | jget messageId)
[ -n "$MSG_ID" ] && ok "202 · messageId $MSG_ID" || { no "mesaj kabul edilmedi: $MSG"; }

# --- 3 --------------------------------------------------------------------
step "3) Turn tamamlandı"
wait_status "$ROOM" idle 180 && ok "durum idle'a döndü" || no "180 sn'de idle'a dönmedi"

# --- 4 --------------------------------------------------------------------
step "4) Dosya gerçekten var"
HELLO="$DATA_DIR/$ROOM/worktrees/$AGENT/hello.js"
if [ -f "$HELLO" ]; then
  OUT=$(node "$HELLO" 2>&1 | tr -d '\r')
  [ "$OUT" = "merhaba oda" ] && ok "hello.js var ve 'merhaba oda' basıyor" \
                             || no "hello.js çıktısı: '$OUT'"
else
  no "hello.js bulunamadı: $HELLO"
fi

# --- 5 --------------------------------------------------------------------
step "5) Yapılandırılmış iz"
EV=$(events_json "$ROOM")
TRACE=$(echo "$EV" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    const evs=JSON.parse(s), id=process.argv[1];
    const mine=evs.filter(e=>e.payload&&e.payload.messageId===id);
    const has=(t,f)=>mine.some(e=>e.type===t&&(!f||f(e)));
    const miss=[];
    if(!has("message.received")) miss.push("message.received");
    if(!has("turn.started")) miss.push("turn.started");
    if(!has("tool.call",e=>e.payload.tool==="Write")) miss.push("tool.call(Write)");
    if(!has("file.changed",e=>String(e.payload.path).endsWith("hello.js"))) miss.push("file.changed(hello.js)");
    if(!has("tool.call",e=>e.payload.tool==="Bash")) miss.push("tool.call(Bash)");
    if(!has("tool.result",e=>e.payload.isError===false)) miss.push("tool.result(ok)");
    if(!has("turn.completed",e=>e.payload.subtype==="success")) miss.push("turn.completed(success)");
    console.log(miss.join(","));
  });' "$MSG_ID")
[ -z "$TRACE" ] && ok "message.received → turn.started → Write → file.changed → Bash → tool.result → turn.completed" \
                || no "eksik event: $TRACE"

# --- 6 --------------------------------------------------------------------
step "6) Tool listesi YAML ile örtüşüyor"
EXPECTED=$(node -e '
  const { resolveSdkTools } = require("./packages/protocol/dist/index.js");
  const { parseRoomConfig } = require("./packages/core/dist/index.js");
' 2>/dev/null || true)
TOOLS_OK=$(node --input-type=module -e '
  const { resolveSdkTools } = await import("./packages/protocol/dist/index.js");
  const { loadRoomConfig } = await import("./packages/core/dist/index.js");
  const { config } = await loadRoomConfig("./config/room.example.yaml");
  const agent = config.agents.find(a => a.name === process.argv[1]);
  const want = new Set(resolveSdkTools(agent).allow);
  const evs = JSON.parse(process.argv[2]);
  const ts = evs.find(e => e.type === "turn.started");
  if (!ts) { console.log("turn.started yok"); process.exit(0); }
  const got = new Set((ts.payload.tools || []).filter(t => want.has(t) || /^[A-Z]/.test(t)));
  const missing = [...want].filter(t => !got.has(t));
  const extra = [...got].filter(t => !want.has(t));
  console.log(missing.length === 0 && extra.length === 0 ? "ok" : `eksik=${missing} fazla=${extra}`);
' "$AGENT" "$EV" 2>&1 | tail -1)
[ "$TOOLS_OK" = "ok" ] && ok "turn.started.tools == resolveSdkTools(backend).allow" \
                       || no "tool listesi uyuşmuyor: $TOOLS_OK"

# --- 7 --------------------------------------------------------------------
step "7) Şema ve sıra"
if node scripts/validate-events.mjs "$ROOM" >/tmp/week2-validate.log 2>&1; then
  ok "$(tail -1 /tmp/week2-validate.log)"
else
  no "validate-events düştü"; tail -5 /tmp/week2-validate.log
fi

# --- 8 --------------------------------------------------------------------
step "8) Meşgulken ikinci mesaj reddediliyor"
api POST "/rooms/$ROOM/agents/$AGENT/message" '{"text":"sleep 60 komutunu bash ile çalıştır"}' >/dev/null
wait_status "$ROOM" busy 30 || true
CODE=$(curl -s -b "rooms_session=$SESSION" -o /dev/null -w '%{http_code}' -X POST "$BASE/rooms/$ROOM/agents/$AGENT/message" \
  -H 'content-type: application/json' -H 'x-user-id: gate' -d '{"text":"ikinci is"}')
[ "$CODE" = "409" ] && ok "409 döndü (kuyruk Hafta 5'te)" || no "beklenen 409, gelen $CODE"

# --- 9 --------------------------------------------------------------------
step "9) Çalışırken durdurma"
CONTAINER=$(docker ps -q --filter "label=agent-rooms.room=$ROOM" | head -1)
api POST "/rooms/$ROOM/agents/$AGENT/stop" >/dev/null
wait_status "$ROOM" stopped 20 && STOPPED=1 || STOPPED=0
EV=$(events_json "$ROOM")
STOP_EVENTS=$(echo "$EV" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    const e=JSON.parse(s);
    const tf=e.some(x=>x.type==="turn.failed"&&x.payload.reason==="stopped");
    const ax=e.some(x=>x.type==="agent.exited"&&x.payload.reason==="stopped");
    console.log(`${tf} ${ax}`);
  });')
STRAY=$(docker exec "$CONTAINER" pgrep -f "runner.js" 2>/dev/null | wc -l | tr -d ' ')
if [ "$STOPPED" = "1" ] && [ "$STOP_EVENTS" = "true true" ] && [ "$STRAY" = "0" ]; then
  ok "stopped · turn.failed(stopped) + agent.exited(stopped) · container'da runner yok"
else
  no "durum=$STOPPED eventler='$STOP_EVENTS' kalan_surec=$STRAY"
fi

# --- 10 -------------------------------------------------------------------
step "10) Oturum sürekliliği"
FIRST_SDK=$(echo "$EV" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    const t=JSON.parse(s).find(e=>e.type==="turn.started");
    console.log(t?t.payload.sdkSessionId:"");
  });')
MSG2=$(api POST "/rooms/$ROOM/agents/$AGENT/message" '{"text":"Az önce oluşturduğun dosyanın adı neydi? Sadece dosya adını yaz."}')
MSG2_ID=$(echo "$MSG2" | jget messageId)
wait_status "$ROOM" idle 180 || true
EV=$(events_json "$ROOM")
CONT=$(echo "$EV" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    const evs=JSON.parse(s), id=process.argv[1], first=process.argv[2];
    const mine=evs.filter(e=>e.payload&&e.payload.messageId===id);
    const ts=mine.find(e=>e.type==="turn.started");
    const same=ts&&ts.payload.sdkSessionId===first;
    // Bu kontrol TEST scriptinin kendi dogrulamasi; urun kodu agent metninden anlam cikarmaz.
    const said=mine.some(e=>e.type==="agent.text"&&String(e.payload.text).includes("hello.js"));
    const done=mine.some(e=>e.type==="turn.completed");
    console.log(`${!!same} ${said} ${done}`);
  });' "$MSG2_ID" "$FIRST_SDK")
[ "$CONT" = "true true true" ] && ok "sdkSessionId aynı, agent dosya adını hatırladı" \
                              || no "süreklilik: sameSession/said/completed = $CONT"

# --- 11 -------------------------------------------------------------------
step "11) Çökme ve kurtarma"
BEFORE_SDK=$FIRST_SDK
RUNNER_PID=$(docker exec "$CONTAINER" pgrep -f "runner.js" 2>/dev/null | head -1)
if [ -n "$RUNNER_PID" ]; then
  docker exec -u root "$CONTAINER" kill -9 "$RUNNER_PID" >/dev/null 2>&1
  wait_status "$ROOM" idle 40 && RECOVERED=1 || RECOVERED=0
  RC=$(psql_q "SELECT restart_count FROM agent_runtime WHERE room_id='$ROOM' AND agent_name='$AGENT'")
  CRASHED=$(events_json "$ROOM" | node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      console.log(JSON.parse(s).some(e=>e.type==="agent.crashed"&&e.payload.willRestart===true));
    });')
  MSG3=$(api POST "/rooms/$ROOM/agents/$AGENT/message" '{"text":"Sadece OK yaz."}')
  wait_status "$ROOM" idle 180 || true
  SAME=$(events_json "$ROOM" | node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      const id=process.argv[1], first=process.argv[2];
      const ts=JSON.parse(s).filter(e=>e.type==="turn.started"&&e.payload.messageId===id)[0];
      console.log(ts?String(ts.payload.sdkSessionId===first):"yok");
    });' "$(echo "$MSG3" | jget messageId)" "$BEFORE_SDK")
  if [ "$RECOVERED" = "1" ] && [ "$CRASHED" = "true" ] && [ "$RC" = "1" ] && [ "$SAME" = "true" ]; then
    ok "agent.crashed(willRestart) · 40 sn'de idle · restart_count=1 · sdkSessionId korundu"
  else
    no "kurtarma: recovered=$RECOVERED crashed=$CRASHED restart_count=$RC sameSession=$SAME"
  fi
else
  no "runner süreci bulunamadı, çökme testi yapılamadı"
fi

# --- 12 -------------------------------------------------------------------
step "12) Yasaklı tool"
cat > "$TMP_YAML" <<'YAML'
version: 1
name: "Kapı testi — bash kapalı"
agents:
  - name: backend
    systemPrompt: "backend"
    workspace: worktrees/backend
    toolsAllow: [read, edit]
    toolsDeny: [bash]
    writable: [worktrees/backend, contracts]
YAML
PORT="$PORT2" ROOM_CONFIG=".week2-gate.tmp.yaml" AGENT_MODEL="$GATE_MODEL" \
  AUTH_DEV_MODE=true node apps/api/dist/index.js >/tmp/week2-server2.log 2>&1 &
SERVER2_PID=$!
if wait_health "http://localhost:$PORT2"; then
  SESSION=$(node scripts/dev-login.mjs --base "http://localhost:$PORT2" --email $GATE_EMAIL)
  BASE_SAVE="$BASE"; BASE="http://localhost:$PORT2"
  ROOM2=$(api POST /rooms '{}' | jget room.id)
  ROOM_IDS+=("$ROOM2")
  api POST "/rooms/$ROOM2/agents/$AGENT/message" '{"text":"ls -la komutunu bash ile çalıştır"}' >/dev/null
  wait_status "$ROOM2" idle 180 || true
  DENY=$(events_json "$ROOM2" | node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      const e=JSON.parse(s);
      const ts=e.find(x=>x.type==="turn.started");
      const hasBash=ts?(ts.payload.tools||[]).includes("Bash"):true;
      const bashIds=new Set(e.filter(x=>x.type==="tool.call"&&x.payload.tool==="Bash").map(x=>x.payload.toolUseId));
      const okBash=e.some(x=>x.type==="tool.result"&&x.payload.isError===false&&bashIds.has(x.payload.toolUseId));
      console.log(`${hasBash} ${okBash}`);
    });')
  BASE="$BASE_SAVE"
  [ "$DENY" = "false false" ] && ok "turn.started.tools içinde Bash yok, başarılı Bash sonucu yok" \
                             || no "yasak delindi: toolsIcindeBash/basariliBash = $DENY"
  kill "$SERVER2_PID" 2>/dev/null; SERVER2_PID=""
else
  no "ikinci sunucu açılmadı"; tail -5 /tmp/week2-server2.log
fi

# --- 13 -------------------------------------------------------------------
step "13) Sunucu yeniden başlatma"
api POST "/rooms/$ROOM/agents/$AGENT/start" >/dev/null
wait_status "$ROOM" idle 60 || true
kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null
AUTH_DEV_MODE=true PORT="$PORT" AGENT_MODEL="$GATE_MODEL" node apps/api/dist/index.js >>/tmp/week2-server.log 2>&1 &
SERVER_PID=$!
if wait_health "$BASE"; then
  SESSION=$(node scripts/dev-login.mjs --base "$BASE" --email $GATE_EMAIL)
  ST=$(agent_status "$ROOM")
  RESTART_EV=$(events_json "$ROOM" | node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      console.log(JSON.parse(s).some(e=>e.type==="agent.exited"&&e.payload.reason==="server_restart"));
    });')
  STRAY=$(docker exec "$CONTAINER" pgrep -f "runner.js" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$ST" = "stopped" ] && [ "$RESTART_EV" = "true" ] && [ "$STRAY" = "0" ]; then
    ok "stopped · agent.exited(server_restart) · sahipsiz runner yok"
  else
    no "mutabakat: durum=$ST event=$RESTART_EV kalan=$STRAY"
  fi
else
  no "sunucu yeniden açılmadı"
fi

# --- maliyet --------------------------------------------------------------
COST=$(events_json "$ROOM" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    const t=JSON.parse(s).filter(e=>e.type==="turn.completed");
    console.log(t.reduce((a,e)=>a+(e.payload.costUsd||0),0).toFixed(4));
  });')

trap - EXIT
cleanup

echo ""
echo "──────────────────────────────"
echo "Toplam maliyet: \$$COST"
echo "Geçen: $PASS   Kalan: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "HAFTA 2 KAPISI GEÇİLEMEDİ."
  exit 1
fi
echo "HAFTA 2 KAPISI GEÇİLDİ."
