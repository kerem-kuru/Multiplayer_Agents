#!/usr/bin/env bash
#
# Hafta 3 kapısı — sunum düzlemi.
#
#   npm run gate:w3
#
# Bu haftanın konusu AGENT DEĞİL, AKIŞ. Event üretmek için dev ucu
# (`POST /sessions/:sid/events`) kullanılır: gerçek event'ler, gerçek DB,
# gerçek SSE — ama deterministik ve ücretsiz. Kapıyı canlı bir agent'a
# bağlamak testi yavaşlatıp kararsızlaştırır, ölçtüğü şeye hiçbir şey katmaz.
#
# Agent gerektiren iki kontrol (tarayıcı testleri, gate:w2) ANAHTAR
# İSTEDİĞİ İÇİN AYRI: npm run gate:w3:agent
set -uo pipefail
export MSYS_NO_PATHCONV=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${GATE_PORT:-8794}"
BASE="http://localhost:$PORT"
export DATABASE_URL="${DATABASE_URL:-postgres://rooms:Kk2007..@localhost:5433/agent_rooms}"

PASS=0; FAIL=0
SERVER_PID=""
ROOM=""; SID=""
# Yol GÖRELİ olmalı: Git Bash'in mutlak yollarını (/tmp/..., /c/Users/...)
# Node Windows tarafında C:\tmp ve C:\c\Users diye çözüyor ve yazamıyor.
# Script yukarıda `cd "$ROOT"` yaptığı için göreli yol iki tarafta da doğru.
TMPDIR_G=".gate-tmp"
rm -rf "$TMPDIR_G"; mkdir -p "$TMPDIR_G"

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

# Her curl ZAMAN SINIRLI: sinirsiz bir curl takilirsa onu bekleyen alt kabuk
# hic bitmez ve kapi sonsuza kadar asili kalir — bir kez basimiza geldi.
note() { # <n> — dev ucuyla gerçek event yaz
  curl -s --max-time 10 -b "rooms_session=$SESSION" -o /dev/null -X POST "$BASE/sessions/$SID/events" \
    -H 'content-type: application/json' \
    -d "{\"type\":\"debug.note\",\"payload\":{\"text\":\"gate-$1\"}}"
}

cleanup() {
  step "12) Temizlik"
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  rm -rf "$TMPDIR_G"
  local removed=0
  if [ -n "$ROOM" ]; then
    for c in $(docker ps -aq --filter "label=agent-rooms.room=$ROOM"); do
      docker rm -f "$c" >/dev/null 2>&1 && removed=$((removed + 1))
    done
  fi
  ok "temizlendi (container: $removed)"
}
trap cleanup EXIT

echo "Hafta 3 kapısı — $BASE"

# --- ön koşullar ----------------------------------------------------------
if ! docker compose exec -T postgres pg_isready -U rooms -d agent_rooms >/dev/null 2>&1; then
  echo "  ✗ postgres ayakta değil — önce: npm run db:up"; exit 1
fi
npm run build >/dev/null 2>&1 || { echo "build başarısız"; exit 1; }

# Container'a gerek yok: bu kapı akışı ölçüyor.
AUTH_DEV_MODE=true SPAWN_CONTAINER=0 PORT="$PORT" node apps/api/dist/index.js >"$TMPDIR_G/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 40); do
  [ "$(curl -s --max-time 5 "$BASE/health" | jget ok)" = "true" ] && break
  sleep 0.5
done

# Hafta 4: her uc uyelik ister; kapi normal giris yolundan gecer.
# Kapı e-postası HER KOŞUMDA FARKLI: magic link hız sınırı (5 dk'da 3)
# gerçek bir koruma ve kapıyı iki kez koşturmak onu tetikliyordu.
GATE_EMAIL="gate-$$-$(date +%s)@rooms.local"
SESSION=$(node scripts/dev-login.mjs --base "$BASE" --email $GATE_EMAIL)
export ROOMS_SESSION="$SESSION"   # sse-probe bunu okur

CREATE=$(curl -s --max-time 30 -b "rooms_session=$SESSION" -X POST "$BASE/rooms" -H 'content-type: application/json' -d '{}')
ROOM=$(echo "$CREATE" | jget room.id)
SID=$(echo "$CREATE" | jget session.id)
[ -z "$ROOM" ] && { echo "oda açılamadı: $CREATE"; exit 1; }
for i in 1 2 3 4 5; do note "$i"; done

# --- 1 --------------------------------------------------------------------
step "1) Geçmiş replay"
R=$(node scripts/sse-probe.mjs "$ROOM" --base "$BASE" --duration 5)
G=$(echo "$R" | jget gaps); D=$(echo "$R" | jget duplicates); N=$(echo "$R" | jget events)
[ "$G" = "0" ] && [ "$D" = "0" ] && [ "$N" -gt 0 ] \
  && ok "$N event, boşluk 0, tekrar 0" || no "probe: $R"

# --- 2 --------------------------------------------------------------------
step "2) Canlı akış"
( sleep 2; for i in 6 7 8; do note "$i"; sleep 0.4; done ) &
WRITER=$!
R=$(node scripts/sse-probe.mjs "$ROOM" --base "$BASE" --duration 7)
wait "$WRITER" 2>/dev/null
N=$(echo "$R" | jget events)
[ "$N" -ge 8 ] && ok "canlı event'ler 2 sn içinde ulaştı (toplam $N)" || no "probe: $R"

# --- 3 --------------------------------------------------------------------
step "3) Frame batch'leme"
# Yoğun yazımda birden çok event tek frame'e girmeli; aksi hâlde 50 ms
# tamponu çalışmıyor demektir.
# Yoğun ama sınırlı: 15 paralel yazım yeter, 30 gereksiz yere sunucuyu zorluyor.
( sleep 1; for i in $(seq 20 34); do note "$i" & done; wait ) &
WRITER=$!
R=$(node scripts/sse-probe.mjs "$ROOM" --base "$BASE" --duration 8)
wait "$WRITER" 2>/dev/null
EPF=$(echo "$R" | jget eventsPerFrame)
node -e "process.exit(Number(process.argv[1]) > 1.5 ? 0 : 1)" "$EPF" \
  && ok "event/frame = $EPF (> 1.5)" || no "batch'lenmiyor: event/frame = $EPF"

# --- 4 --------------------------------------------------------------------
step "4) Kopma ve boşluk doldurma"
( sleep 2; for i in $(seq 60 69); do note "$i"; sleep 0.3; done ) &
WRITER=$!
R=$(node scripts/sse-probe.mjs "$ROOM" --base "$BASE" --drop-after 3 --duration 12)
wait "$WRITER" 2>/dev/null
G=$(echo "$R" | jget gaps); D=$(echo "$R" | jget duplicates); N=$(echo "$R" | jget events)
MAXSEQ=$(psql_q "SELECT max(seq) FROM session_events WHERE session_id='$SID'" | tr -d ' \r')
if [ "$G" = "0" ] && [ "$D" = "0" ] && [ "$N" = "$MAXSEQ" ]; then
  ok "kopma sonrası boşluk 0, tekrar 0, toplam=$N = DB max(seq)"
else
  no "probe=$R · DB max(seq)=$MAXSEQ"
fi

# --- 5 --------------------------------------------------------------------
step "5) Last-Event-ID query'yi ezer"
FIRST=$(timeout 6 curl -sN -b "rooms_session=$SESSION" -H 'Accept: text/event-stream' -H 'Last-Event-ID: 3' \
  "$BASE/rooms/$ROOM/events?since=0" 2>/dev/null \
  | grep '^data: \[' | head -1 \
  | sed 's/^data: //' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s)[0].seq)}catch{console.log("")}});')
[ "$FIRST" = "4" ] && ok "ilk event seq=4 (başlık kazandı, since=0 yok sayıldı)" \
                   || no "ilk event seq=$FIRST, beklenen 4"

# --- 6 --------------------------------------------------------------------
step "6) Eşzamanlı üç izleyici"
PROBES=""
for i in 1 2 3; do
  node scripts/sse-probe.mjs "$ROOM" --base "$BASE" --duration 6 --out "$TMPDIR_G/p$i.json" >/dev/null &
  PROBES="$PROBES $!"
done
sleep 2
for i in 80 81 82; do note "$i"; sleep 0.3; done
# Çıplak `wait` DEĞİL: sadece bu üç probe'u bekle.
for pid in $PROBES; do wait "$pid" 2>/dev/null; done
if diff -q "$TMPDIR_G/p1.json" "$TMPDIR_G/p2.json" >/dev/null 2>&1 &&
   diff -q "$TMPDIR_G/p2.json" "$TMPDIR_G/p3.json" >/dev/null 2>&1; then
  ok "üç izleyici de aynı event kümesini aldı"
else
  no "izleyiciler farklı event kümesi aldı"
fi

# --- 7 --------------------------------------------------------------------
step "7) Sızıntı yok"
HEAP0=$(curl -s --max-time 5 "$BASE/health" | jget heapUsedMb)
for _ in $(seq 1 10); do
  timeout 1 curl -sN -b "rooms_session=$SESSION" -H 'Accept: text/event-stream' "$BASE/rooms/$ROOM/events?since=0" >/dev/null 2>&1
done
sleep 3
SUBS=$(curl -s --max-time 5 "$BASE/health" | jget sseSubscribers)
HEAP1=$(curl -s --max-time 5 "$BASE/health" | jget heapUsedMb)
# Negatif sayıyı argv ile geçmek olmuyor: node "-0.1" i seçenek sanıyor.
GROWTH=$(H0="$HEAP0" H1="$HEAP1" node -e "console.log((Number(process.env.H1)-Number(process.env.H0)).toFixed(1))")
if [ "$SUBS" = "0" ] && GROWTH="$GROWTH" node -e "process.exit(Number(process.env.GROWTH) < 50 ? 0 : 1)"; then
  ok "10 bağlan-kopar sonrası abone=0, heap +${GROWTH} MB (< 50)"
else
  no "abone=$SUBS, heap +${GROWTH} MB"
fi

# --- 8 --------------------------------------------------------------------
step "8) Ham byte akıtma yok"
# Event verisi SADECE writeFrame içinden yazılmalı; event başına doğrudan
# yazan kod olmamalı.
FRAMES=$(grep -c "event: SSE_EVENT_NAME" apps/api/src/routes/events-sse.ts)
FLUSH=$(grep -c "SSE_FLUSH_MS" apps/api/src/routes/events-sse.ts)
if [ "$FRAMES" = "1" ] && [ "$FLUSH" -ge 1 ]; then
  ok "event yazımı tek yerde (writeFrame), 50 ms tampon kullanılıyor"
else
  no "event yazan yer sayısı=$FRAMES, tampon referansı=$FLUSH"
fi

# --- 9 --------------------------------------------------------------------
step "9) Birim testleri"
if npm test >"$TMPDIR_G/test.log" 2>&1; then
  ok "birim testleri geçti ($(grep -acE 'passed' "$TMPDIR_G/test.log" >/dev/null && sed 's/\[[0-9;]*m//g' "$TMPDIR_G/test.log" | grep -oE 'Tests +[0-9]+ passed' | tail -1 || echo 'tamam'))"
else
  no "birim testleri düştü"; tail -5 "$TMPDIR_G/test.log"
fi

# --- 10 -------------------------------------------------------------------
step "10) Hafta 1 kapısı hâlâ geçiyor"
if bash scripts/week1-gate.sh >"$TMPDIR_G/w1.log" 2>&1; then
  ok "Hafta 1 kapısı 10/10"
else
  no "Hafta 1 kapısı düştü"; tail -6 "$TMPDIR_G/w1.log"
fi

# --- 11 -------------------------------------------------------------------
step "11) Agent gerektiren kontroller"
echo "  · tarayıcı testleri (Playwright) ve gate:w2 gerçek agent koşumu ister."
echo "    Anahtar/kota geldiğinde: npm run gate:w3:agent"

trap - EXIT
cleanup

echo ""
echo "──────────────────────────────"
echo "Geçen: $PASS   Kalan: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "HAFTA 3 KAPISI (akış) GEÇİLEMEDİ."
  exit 1
fi
echo "HAFTA 3 KAPISI (akış) GEÇİLDİ — agent gerektiren 2 kontrol bekliyor."
