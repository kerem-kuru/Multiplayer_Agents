#!/usr/bin/env bash
#
# Hafta 6 kapısı — taban, checkpoint, diff doğruluğu ve git güvenliği.
#
#   npm run gate:w6
#
# MODEL İSTEĞİ HARCAMAZ ve bu bilinçli bir bölme. Hafta 6'nın kanıtlaması
# gereken iki farklı şey var:
#
#   1. Bu kapı: checkpoint'in depoyu BOZMADIĞI, ekilmiş git hook'larının
#      tetiklenmediği, diff'in doğru hesaplandığı. Hiçbiri modele bağlı değil —
#      gerçek container, gerçek git, gerçek gitkit, model yok. Agent
#      BAŞLATILIR (runner'ın ayağa kalkması model isteği harcamaz) çünkü taban
#      checkpoint'i agent başlangıcında alınıyor.
#
#   2. `npm run gate:w6:agent`: canlı `diff.updated` yayımı ve inceleme akışı.
#      Bunlar modelsiz ÖLÇÜLEMEZ: diff'i runner yayımlıyor ve tetiği bir tool
#      çağrısı. Gerçek bir tool çalışmadan yayımlanacak bir şey yok. O kapı
#      anahtar yoksa atlar.
#
# Gerekenler: postgres ayakta (npm run db:up) ve güncel oda imajı
# (npm run room:build).
set -uo pipefail
export MSYS_NO_PATHCONV=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${GATE_PORT:-8798}"
BASE="http://localhost:$PORT"
export DATABASE_URL="${DATABASE_URL:-postgres://rooms:Kk2007..@localhost:5433/agent_rooms}"
ROOM_CONFIG="${ROOM_CONFIG:-config/room.gemini.yaml}"
AGENT="${GATE_AGENT:-backend}"
WS="worktrees/$AGENT"
# Önceki haftaların kapıları ~15 dakika sürüyor; varsayılan olarak atlanır.
RUN_REGRESSION="${GATE_W6_REGRESSION:-0}"

PASS=0; FAIL=0
SERVER_PID=""; ROOM=""; SID=""; CONTAINER=""
TMP=".gate6-tmp-$$"
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

# Container içinde git ve kabuk. `-u agent`: runner da o kullanıcıyla koşuyor;
# root'la çalıştırmak .git altında root'a ait dosya bırakır ve bir sonraki
# gitkit çağrısını bozar.
# `safe.directory=*`: workspace bind mount üzerinden geliyor, sahiplik uid
# eşleşmiyor. gitkit de git'i aynı bayrakla çağırıyor (packages/gitkit/src/git.ts);
# kapının okuması ürünün okumasıyla aynı koşulda olmalı.
cgit()  { docker exec -u agent "$CONTAINER" git -c safe.directory='*' -C "/room/$WS" "$@" 2>&1; }
cexec() { docker exec -u agent "$CONTAINER" "$@" 2>&1; }
csh()   { docker exec -u agent "$CONTAINER" sh -c "$1" 2>&1; }

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
  echo "  · oda container'ı silindi ($removed)"
  echo ""
  echo "Hafta 6 kapısı: $PASS geçti, $FAIL kaldı"
  [ "$FAIL" -eq 0 ] || exit 1
}
trap cleanup EXIT

echo "Hafta 6 kapısı — taban, checkpoint, diff, git güvenliği ($ROOM_CONFIG)"

# --- önkoşullar ------------------------------------------------------------
if ! docker compose exec -T postgres pg_isready -U rooms -d agent_rooms >/dev/null 2>&1; then
  echo "  ✗ postgres ayakta değil — önce: npm run db:up"; trap - EXIT; exit 1
fi
if curl -s --max-time 2 "$BASE/health" >/dev/null 2>&1; then
  echo "  ✗ $PORT zaten dinleniyor — eski sunucuyu kapat"; trap - EXIT; exit 1
fi
# Agent yöneticisi yalnızca bir koşum ortamı kullanılabilirse kuruluyor. Bu kapı
# model İSTEĞİ harcamıyor ama agent'ı başlatıyor; anahtar yoksa `start` 503.
if ! grep -qE '^(GEMINI|ANTHROPIC)_API_KEY=.' .env 2>/dev/null \
   && [ -z "${GEMINI_API_KEY:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "  ✗ hiçbir anahtar tanımlı değil — runner başlatılamaz (model isteği harcanmaz, sadece süreç kalkar)"
  trap - EXIT; exit 1
fi
npm run build >/dev/null 2>&1 || { echo "build başarısız"; trap - EXIT; exit 1; }
npm run db:migrate >/dev/null 2>&1 || { echo "migration başarısız"; trap - EXIT; exit 1; }

AUTH_DEV_MODE=true ROOM_CONFIG="$ROOM_CONFIG" PORT="$PORT" \
  node apps/api/dist/index.js >"$TMP/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 40); do
  [ "$(curl -s --max-time 5 "$BASE/health" | jget ok)" = "true" ] && break
  sleep 0.5
done
if [ "$(curl -s --max-time 5 "$BASE/health" | jget ok)" != "true" ]; then
  echo "sunucu kalkmadı"; tail -20 "$TMP/server.log"; exit 1
fi

# --- iki kullanıcı: A owner, C viewer --------------------------------------
STAMP="$$-$(date +%s)"
A=$(node scripts/dev-login.mjs --base "$BASE" --email "gate6a-$STAMP@rooms.local")
C=$(node scripts/dev-login.mjs --base "$BASE" --email "gate6c-$STAMP@rooms.local")
if [ -z "$A" ] || [ -z "$C" ]; then echo "giriş başarısız"; exit 1; fi
acurl() { curl -s --max-time 60 -b "rooms_session=$A" "$@"; }
ccurl() { curl -s --max-time 60 -b "rooms_session=$C" "$@"; }

CREATE=$(acurl -X POST "$BASE/rooms" -H 'content-type: application/json' -d '{}')
ROOM=$(echo "$CREATE" | jget room.id)
SID=$(echo "$CREATE" | jget session.id)
if [ -z "$ROOM" ]; then echo "oda açılamadı: $CREATE"; exit 1; fi
CONTAINER="agent-rooms-room-$(echo "$ROOM" | tr -d '-' | cut -c1-8)"

INV_V=$(acurl -X POST "$BASE/rooms/$ROOM/invites" -H 'content-type: application/json' -d '{"role":"viewer"}' | jget url)
ccurl -o /dev/null -X POST "$BASE/invites/accept" -H 'content-type: application/json' \
  -d "{\"token\":\"${INV_V##*token=}\"}"

# --- fixture agent'tan ÖNCE kopyalanır -------------------------------------
# Taban checkpoint'i agent'ın ilk başlatılmasında alınıyor. Fixture sonradan
# kopyalansaydı bütün proje "agent'ın değişikliği" gibi görünürdü — README'de
# anlatılan tuzağın ta kendisi.
WSDIR="rooms-data/$ROOM/$WS"
mkdir -p "$WSDIR"
cp -r test/fixtures/week6-repo/. "$WSDIR/"
if [ ! -f "$WSDIR/src/order.js" ]; then echo "fixture kopyalanamadı: $WSDIR"; exit 1; fi

acurl -o /dev/null -X POST "$BASE/rooms/$ROOM/agents/$AGENT/start"
ST="?"
for _ in $(seq 1 90); do
  ST=$(acurl "$BASE/rooms/$ROOM/agents" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const a = JSON.parse(s).agents || [];
      const f = a.find((x) => x.name === process.argv[1]);
      console.log((f && f.runtime && f.runtime.status) || "?");
    });' "$AGENT")
  [ "$ST" = "idle" ] && break
  sleep 1
done
if [ "$ST" != "idle" ]; then
  echo "agent hazır olmadı (durum=$ST)"; tail -30 "$TMP/server.log"; exit 1
fi

BASELINE=$(psql_q "SELECT payload->>'checkpointId' FROM session_events WHERE session_id='$SID' AND type='checkpoint.created' AND payload->>'kind'='baseline' ORDER BY seq LIMIT 1")

# Diff yanıtından tek bir dosyayı okuyan yardımcı: <alan ifadesi> <yol>
file_field() {
  node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const f = (JSON.parse(s).files || []).find((x) => x.path === process.argv[1]);
        console.log(f ? eval(process.argv[2]) : "YOK");
      } catch (e) { console.log("HATA"); }
    });' "$1" "$2"
}

###############################################################################
step "1) Taban checkpoint'i var ve ref container içinde çözülüyor  [görev 1]"
if [ -n "$BASELINE" ]; then
  REF=$(cgit rev-parse --verify "refs/rooms/checkpoints/$BASELINE")
  if echo "$REF" | grep -qE '^[0-9a-f]{40}$'; then
    ok "baseline=$BASELINE, ref çözüldü"
  else
    no "ref çözülmedi: $REF"
  fi
else
  no "baseline checkpoint event'i yok"
fi

###############################################################################
step "2) Ekilmiş hook ve fsmonitor TETİKLENMİYOR  [görev 2]"
# Depoya saldırgan bir hook ve fsmonitor ekle. gitkit bunları kapatmıyorsa
# checkpoint alındığı anda çalışırlar.
csh "printf '#!/bin/sh\ntouch /tmp/pwned2\n' > /room/$WS/.git/hooks/post-commit" >/dev/null
csh "chmod +x /room/$WS/.git/hooks/post-commit" >/dev/null
csh "git -C /room/$WS config core.fsmonitor 'touch /tmp/pwned'" >/dev/null
csh "rm -f /tmp/pwned /tmp/pwned2" >/dev/null

HEAD_BEFORE=$(cgit rev-parse HEAD)
STATUS_BEFORE=$(cgit status --porcelain | sort | md5sum)
INDEX_BEFORE=$(csh "md5sum /room/$WS/.git/index 2>/dev/null | cut -d' ' -f1")

acurl -o /dev/null -X POST "$BASE/rooms/$ROOM/agents/$AGENT/checkpoints" \
  -H 'content-type: application/json' -d '{"label":"kapı: güvenlik"}'
acurl -o /dev/null "$BASE/rooms/$ROOM/agents/$AGENT/diff?from=$BASELINE"

PWNED=$(csh "ls /tmp/pwned /tmp/pwned2 2>/dev/null | wc -l" | tr -d ' ')
if [ "$PWNED" = "0" ]; then
  ok "post-commit hook'u ve fsmonitor çalışmadı (/tmp/pwned yok)"
else
  no "EKİLMİŞ KOD ÇALIŞTI — /tmp/pwned* sayısı: $PWNED"
fi

###############################################################################
step "3) Checkpoint depoya dokunmuyor: HEAD, çalışma ağacı ve index aynı  [görev 3]"
HEAD_AFTER=$(cgit rev-parse HEAD)
STATUS_AFTER=$(cgit status --porcelain | sort | md5sum)
INDEX_AFTER=$(csh "md5sum /room/$WS/.git/index 2>/dev/null | cut -d' ' -f1")
if [ "$HEAD_BEFORE" = "$HEAD_AFTER" ] && [ "$STATUS_BEFORE" = "$STATUS_AFTER" ] && [ "$INDEX_BEFORE" = "$INDEX_AFTER" ]; then
  ok "HEAD, çalışma ağacı ve .git/index değişmedi"
else
  no "depo değişti — HEAD:$HEAD_BEFORE→$HEAD_AFTER index:$INDEX_BEFORE→$INDEX_AFTER"
fi

###############################################################################
step "4) Host kodu agent deposunda git ÇALIŞTIRMIYOR  [görev 4]"
HITS=$(grep -rnE 'execFile\("git"|execFileSync\("git"|spawn\("git"' apps packages --include=*.ts 2>/dev/null \
  | grep -v node_modules | cut -d: -f1 | sort -u)
UNEXPECTED=$(echo "$HITS" | grep -v '^packages/gitkit/src/git.ts$' | grep -v '^$')
if [ -z "$UNEXPECTED" ]; then
  ok "doğrudan git çağrısı yalnızca packages/gitkit/src/git.ts içinde"
else
  no "git host tarafında çağrılıyor: $(echo "$UNEXPECTED" | tr '\n' ' ')"
fi

###############################################################################
step "5) Diff: değişen dosya modified, yeni dosya added  [görev 5-6'nın modelsiz karşılığı]"
csh "printf '// kapı: tek satırlık açıklama\n' > /tmp/hdr && cat /tmp/hdr /room/$WS/src/order.js > /tmp/o && cp /tmp/o /room/$WS/src/order.js" >/dev/null
csh "printf 'Notlar\n' > /room/$WS/NOTES.md" >/dev/null
acurl "$BASE/rooms/$ROOM/agents/$AGENT/diff?from=$BASELINE" > "$TMP/diff1.json"
ORDER=$(file_field "src/order.js" 'f.status + " +" + f.additions' < "$TMP/diff1.json")
NOTES=$(file_field "NOTES.md" 'f.status' < "$TMP/diff1.json")
if echo "$ORDER" | grep -q '^modified' && [ "$NOTES" = "added" ]; then
  ok "src/order.js=$ORDER · NOTES.md=$NOTES"
else
  no "beklenen modified/added değil — order:$ORDER notes:$NOTES"
fi

###############################################################################
step "6) node_modules diff'e GİRMİYOR  [görev 7]"
csh "mkdir -p /room/$WS/node_modules/x && printf 'module.exports=1\n' > /room/$WS/node_modules/x/index.js" >/dev/null
if acurl "$BASE/rooms/$ROOM/agents/$AGENT/diff?from=$BASELINE" | grep -q "node_modules"; then
  no "node_modules diff'te görünüyor"
else
  ok "node_modules yok sayıldı"
fi

###############################################################################
step "7) Büyük dosya kırpılıyor: truncated  [görev 11]"
csh "head -c 1048576 /dev/urandom | base64 > /room/$WS/big.txt" >/dev/null
acurl "$BASE/rooms/$ROOM/agents/$AGENT/diff?from=$BASELINE" > "$TMP/diff3.json"
BIG=$(file_field "big.txt" 'String(f.truncated)' < "$TMP/diff3.json")
SIZE=$(wc -c < "$TMP/diff3.json" | tr -d ' ')
if [ "$BIG" = "true" ] && [ "$SIZE" -lt 307200 ]; then
  ok "big.txt truncated=true, yanıt $SIZE bayt (300 KB altı)"
else
  no "truncated=$BIG, yanıt $SIZE bayt"
fi

###############################################################################
step "8) Yeniden adlandırma renamed + oldPath olarak görünüyor"
csh "mv /room/$WS/src/order.js /room/$WS/src/order-service.js" >/dev/null
acurl "$BASE/rooms/$ROOM/agents/$AGENT/diff?from=$BASELINE" > "$TMP/diff4.json"
REN=$(file_field "src/order-service.js" 'f.status + "|" + (f.oldPath || "")' < "$TMP/diff4.json")
if [ "$REN" = "renamed|src/order.js" ]; then
  ok "src/order.js → src/order-service.js renamed, oldPath dolu"
else
  # Git sürümüne göre benzerlik eşiği tutmazsa delete+add çıkar. Bu bir çökme
  # değil ama kapı sessizce geçmemeli: imajın git sürümü de yazdırılıyor.
  no "renamed beklenirken: $REN · imajdaki git: $(cexec git --version)"
fi
csh "mv /room/$WS/src/order-service.js /room/$WS/src/order.js" >/dev/null

###############################################################################
step "9) viewer yorum bırakamaz — 403  [görev 16'nın yetki kısmı]"
CODE=$(ccurl -o /dev/null -w '%{http_code}' -X POST "$BASE/rooms/$ROOM/agents/$AGENT/reviews" \
  -H 'content-type: application/json' \
  -d '{"comments":[{"path":"src/order.js","side":"new","line":1,"lineText":"x","body":"bunu böl","diffSeq":1}]}')
if [ "$CODE" = "403" ]; then
  ok "izleyici 403 aldı — yetki sunucuda, düğmenin gizlenmesinde değil"
else
  no "izleyici için beklenen 403, gelen $CODE"
fi

###############################################################################
step "10) Diff ucu kötü isteği reddediyor: 400 ve 404"
C400=$(acurl -o /dev/null -w '%{http_code}' "$BASE/rooms/$ROOM/agents/$AGENT/diff")
C404=$(acurl -o /dev/null -w '%{http_code}' "$BASE/rooms/$ROOM/agents/$AGENT/diff?from=cp_yokboyle01")
if [ "$C400" = "400" ] && [ "$C404" = "404" ]; then
  ok "from'suz istek 400, olmayan checkpoint 404"
else
  no "beklenen 400/404, gelen $C400/$C404"
fi

###############################################################################
step "11) Manuel checkpoint tabanı kaydırıyor, projeksiyonda diff sıfırlanıyor  [görev 18]"
CP2_ID=$(acurl -X POST "$BASE/rooms/$ROOM/agents/$AGENT/checkpoints" \
  -H 'content-type: application/json' -d '{"label":"kapı: yeni taban"}' | jget checkpointId)
BECOMES=$(psql_q "SELECT payload->>'becomesBase' FROM session_events WHERE session_id='$SID' AND type='checkpoint.created' AND payload->>'checkpointId'='$CP2_ID'")
sleep 2
FILES=$(acurl "$BASE/rooms/$ROOM/snapshot" | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    try {
      const o = JSON.parse(s);
      const st = o.state || o.snapshot || o;
      const a = (st.agents || {})[process.argv[1]] || {};
      console.log(Object.keys((a.diff && a.diff.files) || {}).length);
    } catch (e) { console.log("?"); }
  });' "$AGENT")
BASE_DB=$(psql_q "SELECT diff_base_checkpoint_id FROM agent_runtime WHERE room_id='$ROOM' AND agent_name='$AGENT'")
if [ "$BECOMES" = "true" ] && [ "$BASE_DB" = "$CP2_ID" ] && [ "$FILES" = "0" ]; then
  ok "becomesBase=true, taban=$CP2_ID, projeksiyonda 0 dosya"
else
  no "becomesBase=$BECOMES taban=$BASE_DB dosya=$FILES (beklenen true/$CP2_ID/0)"
fi

###############################################################################
step "12) Yeni tabandan sonraki diff yalnızca SONRAKİ değişikliği içeriyor  [görev 19]"
csh "printf 'yeni taban sonrası\n' >> /room/$WS/NOTES.md" >/dev/null
N5=$(acurl "$BASE/rooms/$ROOM/agents/$AGENT/diff?from=$CP2_ID" | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    console.log((JSON.parse(s).files || []).map((x) => x.path).sort().join(","));
  });')
N6=$(acurl "$BASE/rooms/$ROOM/agents/$AGENT/diff?from=$BASELINE" | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    console.log(String((JSON.parse(s).files || []).length));
  });')
if [ "$N5" = "NOTES.md" ] && [ "$N6" -ge 3 ] 2>/dev/null; then
  ok "yeni tabandan: NOTES.md · tabandan: $N6 dosya (tüm oturum)"
else
  no "yeni tabandan beklenen yalnızca NOTES.md, gelen: $N5 (tabandan $N6 dosya)"
fi

###############################################################################
step "13) Regresyon: birim testler  [görev 21]"
if npx vitest run >"$TMP/vitest.log" 2>&1; then
  TESTS=$(sed 's/\[[0-9;]*m//g' "$TMP/vitest.log" | grep -oE 'Tests +[0-9]+ passed' | tail -1 | tr -s ' ')
  ok "${TESTS:-birim testler geçti}"
else
  no "birim testler kaldı — çıktı: $TMP/vitest.log"
  tail -20 "$TMP/vitest.log"
fi

if [ "$RUN_REGRESSION" = "1" ]; then
  step "14) Regresyon: Hafta 1-5 kapıları (GATE_W6_REGRESSION=1)"
  for g in gate gate:w3 gate:w4 gate:w5; do
    if npm run "$g" >"$TMP/reg.log" 2>&1; then ok "$g geçti"; else no "$g kaldı"; fi
  done
else
  echo ""
  echo "  · Hafta 1-5 kapıları atlandı — GATE_W6_REGRESSION=1 ile koşar (~15 dk)"
fi
