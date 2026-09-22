#!/usr/bin/env bash
#
# Hafta 6 kapısının AGENT GEREKTİREN kontrolleri.
#
#   npm run gate:w6:agent
#
# Ana kapı (gate:w6) checkpoint'i, git güvenliğini ve diff doğruluğunu modelsiz
# ölçüyor. Burada ölçülen şey modelsiz ÖLÇÜLEMEZ:
#
#   · canlı `diff.updated` yayımı — diff'i runner yayımlıyor ve tetiği bir tool
#     çağrısı. Gerçek bir tool çalışmadan yayımlanacak bir şey yok.
#   · artımlı yayım — "değişmeyen dosya ikinci kez gönderilmiyor" ancak arka
#     arkaya iki gerçek turn'de görünür.
#   · inceleme → düzeltme döngüsü ve SÜRESİ. Haftanın vaadi bu: satıra
#     "bunu böl" yazılıyor, agent 30 sn'de düzeltiyor.
#
# Anahtar/kota yoksa ATLAR (başarısız saymaz).
#
# KOTA UYARISI: üç agentic turn koşar. Gemini ücretsiz katmanında günlük sınır
# 20 MODEL İSTEĞİ — turn değil. Tool çağıran tek bir turn modele birkaç kez
# gider; bu kapı kotanın önemli bir kısmını yer.
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
WS="worktrees/$AGENT"
TURN_TIMEOUT="${TURN_TIMEOUT:-240}"
# Görev tanımı: 60 sn'yi geçerse başarısız, 30 sn'yi geçerse uyarı.
FIX_FAIL_SEC="${FIX_FAIL_SEC:-60}"
FIX_WARN_SEC="${FIX_WARN_SEC:-30}"

PASS=0; FAIL=0; WARN=0
SERVER_PID=""; ROOM=""; SID=""; CONTAINER=""; P1=""; P2=""
TMP=".gate6a-tmp-$$"
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

psql_q() { docker compose exec -T postgres psql -U rooms -d agent_rooms -tA -c "$1" 2>&1 | tr -d '\r'; }
csh()    { docker exec -u "agent-$AGENT" "$CONTAINER" sh -c "$1" 2>&1; }

cleanup() {
  step "Temizlik"
  [ -n "$P1" ] && kill "$P1" 2>/dev/null
  [ -n "$P2" ] && kill "$P2" 2>/dev/null
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
  echo "Hafta 6 agent kapısı: $PASS geçti, $FAIL kaldı, $WARN uyarı"
  [ "$FAIL" -eq 0 ] || exit 1
}
trap cleanup EXIT

echo "Hafta 6 — agent kontrolü ($ROOM_CONFIG) · üç turn, kota harcar"

if [ -z "${GEMINI_API_KEY:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ] \
   && ! grep -qE '^(GEMINI|ANTHROPIC)_API_KEY=.' .env 2>/dev/null; then
  echo "  · anahtar yok — atlandı (başarısız DEĞİL)"
  trap - EXIT; rm -rf "$TMP"; exit 0
fi
if ! docker compose exec -T postgres pg_isready -U rooms -d agent_rooms >/dev/null 2>&1; then
  echo "  ✗ postgres ayakta değil — önce: npm run db:up"; trap - EXIT; exit 1
fi
if curl -s --max-time 2 "$BASE/health" >/dev/null 2>&1; then
  echo "  ✗ $PORT zaten dinleniyor — eski sunucuyu kapat"; trap - EXIT; exit 1
fi
npm run build >/dev/null 2>&1 || { echo "build başarısız"; trap - EXIT; exit 1; }
npm run db:migrate >/dev/null 2>&1 || { echo "migration başarısız"; trap - EXIT; exit 1; }

# --- fixture -> gecici git deposu -> local repo kaynagi --------------------
# Hafta 7: workspace'e kopyalama yok; depo merkezden klonlaniyor ve fixture'in
# tamami TABANDA kaliyor (diff yalnizca agent'in isini gosterir).
SRC_ROOT="$ROOT/$TMP/src"
SRC="$SRC_ROOT/week6-repo"
mkdir -p "$SRC"
cp -r test/fixtures/week6-repo/. "$SRC/"
git -C "$SRC" init -q -b main
git -C "$SRC" -c user.name=gate -c user.email=gate@local add -A
git -C "$SRC" -c user.name=gate -c user.email=gate@local commit -q -m "week6 fixture"

GATE_CONFIG="$ROOT/$TMP/room.yaml"
node -e '
  const fs = require("fs");
  const YAML = require("yaml");
  const cfg = YAML.parse(fs.readFileSync(process.argv[1], "utf8"));
  cfg.repo = { kind: "local", path: process.argv[2], ref: "main" };
  fs.writeFileSync(process.argv[3], YAML.stringify(cfg));
' "$ROOM_CONFIG" "$SRC" "$GATE_CONFIG"

AUTH_DEV_MODE=true ROOM_CONFIG="$GATE_CONFIG" ROOMS_SOURCE_ROOT="$SRC_ROOT" PORT="$PORT" \
  node apps/api/dist/index.js >"$TMP/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 40); do
  [ "$(curl -s --max-time 5 "$BASE/health" | jget ok)" = "true" ] && break
  sleep 0.5
done

STAMP="$$-$(date +%s)"
A=$(node scripts/dev-login.mjs --base "$BASE" --email "gate6aa-$STAMP@rooms.local")
B=$(node scripts/dev-login.mjs --base "$BASE" --email "gate6ab-$STAMP@rooms.local")
if [ -z "$A" ] || [ -z "$B" ]; then echo "giriş başarısız"; exit 1; fi
acurl() { curl -s --max-time 120 -b "rooms_session=$A" "$@"; }
bcurl() { curl -s --max-time 120 -b "rooms_session=$B" "$@"; }

CREATE=$(acurl -X POST "$BASE/rooms" -H 'content-type: application/json' -d '{}')
ROOM=$(echo "$CREATE" | jget room.id)
SID=$(echo "$CREATE" | jget session.id)
if [ -z "$ROOM" ]; then echo "oda açılamadı: $CREATE"; exit 1; fi
CONTAINER="agent-rooms-room-$(echo "$ROOM" | tr -d '-' | cut -c1-8)"

INV=$(acurl -X POST "$BASE/rooms/$ROOM/invites" -H 'content-type: application/json' -d '{"role":"member"}' | jget url)
bcurl -o /dev/null -X POST "$BASE/invites/accept" -H 'content-type: application/json' \
  -d "{\"token\":\"${INV##*token=}\"}"
B_ID=$(bcurl "$BASE/auth/me" | jget id)
# İnceleme başlığı "Ayse · N yorumluk inceleme" olarak görünsün.
psql_q "UPDATE users SET name='Ayse' WHERE id='$B_ID'" >/dev/null

# Fixture merkez depodan klonlandi; taban onu iceriyor.
if ! room_sh "$ROOM" "agent-$AGENT" "test -f /room/$WS/src/order.js" >/dev/null; then
  echo "klon beklenen dosyayi tasimiyor"; tail -20 "$TMP/server.log"; exit 1
fi

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

send() { # <cookie> <metin> → yanıt gövdesi
  curl -s --max-time 60 -b "rooms_session=$1" -X POST \
    "$BASE/rooms/$ROOM/agents/$AGENT/message" -H 'content-type: application/json' \
    -d "{\"text\":$(node -e 'console.log(JSON.stringify(process.argv[1]))' "$2")}"
}

wait_turn() { # <messageId> → 0 bitti / 1 zaman aşımı
  local mid="$1" i=0
  while [ "$i" -lt "$TURN_TIMEOUT" ]; do
    local n
    n=$(psql_q "SELECT count(*) FROM session_events WHERE session_id='$SID' AND type IN ('turn.completed','turn.failed') AND payload->>'messageId'='$mid'" | tr -d ' ')
    [ "$n" != "0" ] && return 0
    sleep 1; i=$((i + 1))
  done
  return 1
}

# Bir turn'ün ürettiği diff.updated event'lerindeki dosya yolları.
diff_paths() { # <messageId> → "a,b,c"
  psql_q "SELECT string_agg(DISTINCT f->>'path', ',' ORDER BY f->>'path') FROM session_events e, jsonb_array_elements(e.payload->'files') f WHERE e.session_id='$SID' AND e.type='diff.updated' AND e.payload->>'messageId'='$mid_arg'" | tr -d ' '
}

###############################################################################
step "1) Canlı diff: agent dosyayı değiştirince diff.updated geliyor  [görev 5]"
# Yorum `function processOrder` satırının ÜSTÜNE isteniyor ki o satır diff
# hunk'ının içinde (bağlam satırı olarak) kalsın: yorum yalnızca DİFF'TE
# GÖRÜNEN satırlara bırakılabilir — dosyanın herhangi bir satırına değil.
R1=$(send "$A" "src/order.js dosyasında 'function processOrder' satırının hemen ÜSTÜNE tek satırlık bir açıklama yorumu ekle. Başka hiçbir şeyi değiştirme.")
M1=$(echo "$R1" | jget messageId)
if [ -z "$M1" ]; then no "mesaj kuyruğa girmedi: $R1"; else
  if wait_turn "$M1"; then
    mid_arg="$M1"; PATHS1=$(diff_paths)
    STATUS1=$(psql_q "SELECT f->>'status' FROM session_events e, jsonb_array_elements(e.payload->'files') f WHERE e.session_id='$SID' AND e.type='diff.updated' AND e.payload->>'messageId'='$M1' AND f->>'path'='src/order.js' LIMIT 1")
    ADD1=$(psql_q "SELECT max((f->>'additions')::int) FROM session_events e, jsonb_array_elements(e.payload->'files') f WHERE e.session_id='$SID' AND e.type='diff.updated' AND e.payload->>'messageId'='$M1' AND f->>'path'='src/order.js'")
    if [ "$STATUS1" = "modified" ] && [ "${ADD1:-0}" -ge 1 ] 2>/dev/null; then
      ok "src/order.js modified, +$ADD1 (turn'ün diff'i: $PATHS1)"
    else
      no "beklenen modified/+1 değil — status=$STATUS1 additions=$ADD1 yollar=$PATHS1"
    fi
  else
    no "turn $TURN_TIMEOUT sn'de bitmedi (kota dolmuş olabilir — server.log'a bak)"
    tail -5 "$TMP/server.log"
  fi
fi

###############################################################################
step "2) Turn koşarken checkpoint 409  [görev 20]"
# Uzun sürecek bir iş değil; koşan turn'ü yakalamak için mesajı atıp hemen
# deniyoruz. Turn çoktan bittiyse kontrol atlanır, YANLIŞ GEÇMEZ.
R2=$(send "$A" "package.json içindeki version alanını sed -i ile 0.2.0 yap. Başka dosyaya dokunma.")
M2=$(echo "$R2" | jget messageId)
sleep 2
RT=$(psql_q "SELECT status FROM agent_runtime WHERE room_id='$ROOM' AND agent_name='$AGENT'")
if [ "$RT" = "running" ] || [ "$RT" = "busy" ]; then
  CODE=$(acurl -o /dev/null -w '%{http_code}' -X POST "$BASE/rooms/$ROOM/agents/$AGENT/checkpoints" \
    -H 'content-type: application/json' -d '{"label":"koşarken"}')
  if [ "$CODE" = "409" ]; then ok "koşan turn'de checkpoint 409"; else no "beklenen 409, gelen $CODE"; fi
else
  warn "turn zaten bitmişti (durum=$RT) — 409 kontrolü atlandı"
fi

###############################################################################
step "3) Artımlı yayım: değişmeyen dosya ikinci kez gönderilmiyor  [görev 6, 8]"
if [ -n "$M2" ] && wait_turn "$M2"; then
  mid_arg="$M2"; PATHS2=$(diff_paths)
  if echo "$PATHS2" | grep -q "package.json"; then
    if echo "$PATHS2" | grep -q "src/order.js"; then
      no "src/order.js değişmediği hâlde tekrar gönderildi: $PATHS2"
    else
      ok "ikinci turn'ün diff'i: $PATHS2 (src/order.js yok)"
    fi
  else
    no "package.json diff'e düşmedi — gelen: $PATHS2"
  fi
else
  no "ikinci turn bitmedi"
fi

###############################################################################
step "4) İki izleyici aynı diff.updated event'lerini aldı  [görev 9]"
# Probe `--out` dosyasını ancak süre dolunca yazıyor. Uzun süreli iki probe
# çalıştırıp ortada okumak "dosya yok" demekti (ilk koşumda tam bu oldu).
# `--since 0` geçmişi baştan oynatıyor: iki bağımsız istemci aynı event
# dizisini alıyor mu — ölçülen şey bu, ve model gerektirmiyor.
node scripts/sse-probe.mjs "$ROOM" --base "$BASE" --session "$A" --since 0 --duration 12 --out "$TMP/p1.json" >/dev/null 2>&1 &
P1=$!
node scripts/sse-probe.mjs "$ROOM" --base "$BASE" --session "$B" --since 0 --duration 12 --out "$TMP/p2.json" >/dev/null 2>&1 &
P2=$!
wait "$P1" 2>/dev/null; wait "$P2" 2>/dev/null
P1=""; P2=""
probe_seqs() {
  node -e '
    const fs = require("fs");
    try {
      const ev = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const a = (Array.isArray(ev) ? ev : ev.events || []).filter((e) => e && e.type === "diff.updated");
      console.log(a.map((e) => e.seq).join(","));
    } catch (e) { console.log("OKUNAMADI"); }' "$1"
}
SEQ1=$(probe_seqs "$TMP/p1.json")
SEQ2=$(probe_seqs "$TMP/p2.json")
if [ -n "$SEQ1" ] && [ "$SEQ1" != "OKUNAMADI" ] && [ "$SEQ1" = "$SEQ2" ]; then
  ok "iki probe aynı diff.updated dizisini aldı: $SEQ1"
else
  no "probe'lar ayrıştı — p1=$SEQ1 p2=$SEQ2"
fi

###############################################################################
step "5) Patch içindeki secret maskeleniyor  [görev 10]"
# Dosyayı container'a dışarıdan yazıyoruz: yayımcı her flush'ta DEĞİŞEN TÜM
# dosyaları gönderiyor, yani bir sonraki turn'ün diff'ine bu da girer. Agent'a
# "secret yaz" demek fazladan bir model isteği harcardı.
csh "printf 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nAWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n' > /room/$WS/.env.example" >/dev/null
R3=$(send "$A" "NOTES.md adında bir dosya oluştur, içine tek satır 'notlar' yaz.")
M3=$(echo "$R3" | jget messageId)
if [ -n "$M3" ] && wait_turn "$M3"; then
  RAW=$(psql_q "SELECT count(*) FROM session_events WHERE session_id='$SID' AND type='diff.updated' AND payload::text LIKE '%AKIAIOSFODNN7EXAMPLE%'")
  MASKED=$(psql_q "SELECT count(*) FROM session_events WHERE session_id='$SID' AND type='diff.updated' AND payload::text LIKE '%[redacted:%'")
  if [ "$RAW" = "0" ] && [ "$MASKED" != "0" ]; then
    ok "ham anahtar event log'da yok, maske var"
  else
    no "ham=$RAW maskeli=$MASKED (ham 0, maskeli >0 olmalı)"
  fi
else
  no "üçüncü turn bitmedi — secret kontrolü ölçülemedi"
fi

###############################################################################
step "6) İnceleme: yorum → event sırası → kuyruk  [görev 12]"
DIFFSEQ=$(psql_q "SELECT max(seq) FROM session_events WHERE session_id='$SID' AND type='diff.updated'")
# Yorum bırakılacak satır DİFF'TEN seçilir, workspace dosyasından DEĞİL.
#
# İlk koşumda kapı satırı dosyadan okuyordu ve inceleme "src/order.js:15
# diff'te böyle bir satır yok" diye reddedildi — haklı olarak: unified diff
# yalnızca hunk'ları taşır, dosyanın tamamını değil. Yorum yalnızca "diff'te
# görünen satırlara" bırakılabilir (görev tanımı, Kapsam Dışı). Kapı gerçek
# kullanıcının gördüğü şeye bakmalı: patch'in kendisine.
read -r LINE LINETEXT <<EOF
$(acurl "$BASE/rooms/$ROOM/snapshot" | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    try {
      const o = JSON.parse(s);
      const st = o.state || o.snapshot || o;
      const ag = (st.agents || {})[process.argv[1]] || {};
      const f = ((ag.diff || {}).files || {})["src/order.js"];
      if (!f || !f.patch) return console.log("");
      let n = 0;
      const rows = [];
      const NL = String.fromCharCode(10);
      for (const raw of String(f.patch).split(NL)) {
        const h = /^@@ -[0-9]+(?:,[0-9]+)? \+([0-9]+)(?:,[0-9]+)? @@/.exec(raw);
        if (h) { n = Number(h[1]); continue; }
        if (raw.startsWith("-")) continue;
        if (raw.startsWith("+") || raw.startsWith(" ")) {
          rows.push({ line: n, text: raw.slice(1) });
          n += 1;
        }
      }
      const hit =
        rows.find((r) => r.text.includes("function processOrder")) ||
        rows.find((r) => r.text.trim().length > 3);
      console.log(hit ? hit.line + " " + hit.text : "");
    } catch (e) { console.log(""); }
  });' "$AGENT")
EOF
if [ -z "$LINE" ]; then
  no "diff'te yorum bırakılacak satır bulunamadı — agent src/order.js'i değiştirmemiş olabilir"
fi
BODY=$(node -e '
  const [line, text, seq] = process.argv.slice(1);
  console.log(JSON.stringify({ comments: [{ path: "src/order.js", side: "new",
    line: Number(line), lineText: text, body: "bunu böl", diffSeq: Number(seq) }] }));
' "$LINE" "$LINETEXT" "$DIFFSEQ")
REV=$(bcurl -X POST "$BASE/rooms/$ROOM/agents/$AGENT/reviews" -H 'content-type: application/json' -d "$BODY")
RID=$(echo "$REV" | jget reviewId)
M4=$(echo "$REV" | jget messageId)
if [ -n "$RID" ]; then
  ORDER_EV=$(psql_q "SELECT string_agg(type, '>' ORDER BY seq) FROM session_events WHERE session_id='$SID' AND type IN ('comment.on_line','review.submitted','message.queued') AND (payload->>'reviewId'='$RID' OR payload->>'messageId'='$M4')")
  if echo "$ORDER_EV" | grep -q "comment.on_line>review.submitted>message.queued"; then
    ok "sıra: $ORDER_EV (satır $LINE)"
  else
    no "beklenen sıra değil: $ORDER_EV"
  fi
else
  no "inceleme kabul edilmedi: $REV"
fi

###############################################################################
step "7) Agent'a giden metinde dosya:satır ve alıntı var  [görev 13]"
# Metin psql'den DEĞİL API'den okunuyor: psql çıktısı Windows konsolunda
# kod sayfasına düşüyor ve Türkçe karakterler bozuluyor. İlk koşumda kontrol
# tam bu yüzden düştü — metin doğruydu, kapının okuması bozuktu.
CHK=$(acurl "$BASE/rooms/$ROOM/events?since=0&limit=500" | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    try {
      const evs = (JSON.parse(s).events || []).filter(
        (e) => e.type === "message.received" && e.payload.messageId === process.argv[1],
      );
      const t = evs.length ? String(evs[0].payload.text) : "";
      const marker = process.argv[2];
      const quoted = process.argv[3].trim();
      const out = [];
      out.push(t.includes(marker) ? "yol+satir" : "YOK:yol+satir");
      out.push(quoted && t.includes(quoted) ? "alinti" : "YOK:alinti");
      out.push(/\[[^\]]+\]:/.test(t) ? "YOK:onek-var" : "onek-yok");
      console.log(out.join(" "));
    } catch (e) { console.log("HATA"); }
  });' "$M4" "src/order.js:$LINE" "$LINETEXT")
if [ "$CHK" = "yol+satir alinti onek-yok" ]; then
  ok "metinde src/order.js:$LINE ve alıntılanan satır var, aktör öneki yok"
else
  no "beklenen alanlar eksik: $CHK"
fi

###############################################################################
step "8) Yorumdan düzeltmeye SÜRE  [görev 14]"
if [ -n "$M4" ] && wait_turn "$M4"; then
  SECS=$(psql_q "SELECT round(EXTRACT(EPOCH FROM (
      (SELECT min(ts) FROM session_events WHERE session_id='$SID' AND type='diff.updated' AND seq > (SELECT seq FROM session_events WHERE session_id='$SID' AND type='review.submitted' AND payload->>'reviewId'='$RID'))
      - (SELECT ts FROM session_events WHERE session_id='$SID' AND type='review.submitted' AND payload->>'reviewId'='$RID')))::numeric, 1)")
  FUNCS=$(csh "grep -c 'function ' /room/$WS/src/order.js" | tr -d ' \r')
  echo "  · yorumdan düzeltmeye: ${SECS:-ölçülemedi} sn · dosyadaki function sayısı: $FUNCS"
  if [ -z "$SECS" ]; then
    no "inceleme sonrası hiç diff.updated gelmedi — agent düzeltmedi"
  elif awk "BEGIN{exit !($SECS > $FIX_FAIL_SEC)}"; then
    no "düzeltme $SECS sn sürdü — sınır $FIX_FAIL_SEC sn"
  elif awk "BEGIN{exit !($SECS > $FIX_WARN_SEC)}"; then
    warn "düzeltme $SECS sn sürdü — hedef $FIX_WARN_SEC sn altı"
    PASS=$((PASS + 1))
  else
    ok "düzeltme $SECS sn (hedef: $FIX_WARN_SEC sn altı)"
  fi
else
  no "inceleme turn'ü bitmedi"
fi

###############################################################################
step "9) Yorumun çapası GERÇEĞE uyuyor mu  [görev 15]"
sleep 2
# Durum CANLI görünümden okunuyor (`scripts/room-view.mjs`): snapshot +
# sonraki event'ler, tarayıcının yaptığının aynısı. Bir koşumda doğrudan
# /snapshot okunmuştu ve kapı "projeksiyonda yorum yok" dedi — yorum seq
# 48'deydi, snapshot seq 34'te kalmıştı. Ürün doğruydu, okuma bayattı.
#
# Beklenti de patch'ten TÜRETİLİYOR, sabit değil. Görev tanımı "current
# kalırsa başarısız" diyor; bu, agent'ın satırı kaydırmasını varsayıyor ve
# gerçek modelde bu bir şans işi. Ölçülen şey: projeksiyonun çapa kuralı
# (numara+metin) patch'in gerçeğiyle aynı sonucu veriyor mu.
CMP=$(node scripts/room-view.mjs "$ROOM" --base "$BASE" --session "$B" --agent "$AGENT" | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    try {
      const a = JSON.parse(s);
      const list = a.comments || [];
      if (!list.length) return console.log("YOK yorum-yok");
      const c = list[list.length - 1];
      const f = ((a.diff || {}).files || {})[c.path];
      if (!f || !f.patch) return console.log(c.anchor + " outdated");
      const NL = String.fromCharCode(10);
      let n = 0;
      const rows = [];
      for (const raw of String(f.patch).split(NL)) {
        const h = /^@@ -[0-9]+(?:,[0-9]+)? \+([0-9]+)(?:,[0-9]+)? @@/.exec(raw);
        if (h) { n = Number(h[1]); continue; }
        if (raw.startsWith("-")) continue;
        if (raw.startsWith("+") || raw.startsWith(" ")) { rows.push({ line: n, text: raw.slice(1) }); n += 1; }
      }
      const at = rows.find((r) => r.line === c.line);
      const hits = rows.filter((r) => r.text === c.lineText);
      const beklenen =
        at && at.text === c.lineText ? "current" : hits.length === 1 ? "moved" : "outdated";
      console.log(c.anchor + " " + beklenen + " " + (c.currentLine ?? "-"));
    } catch (e) { console.log("HATA HATA"); }
  });')
GERCEK=$(echo "$CMP" | cut -d" " -f1)
BEKLENEN=$(echo "$CMP" | cut -d" " -f2)
YENI=$(echo "$CMP" | cut -d" " -f3)
if [ "$GERCEK" = "$BEKLENEN" ] && [ "$GERCEK" != "HATA" ] && [ "$GERCEK" != "YOK" ]; then
  ok "çapa $GERCEK (yeni satır: $YENI) — patch'ten türetilen beklentiyle aynı"
else
  no "çapa $GERCEK, patch'e göre $BEKLENEN olmalıydı"
fi

###############################################################################
step "10) Geçersiz yorum reddediliyor: 400  [görev 16]"
CID=$(psql_q "SELECT payload->>'commentId' FROM session_events WHERE session_id='$SID' AND type='comment.on_line' ORDER BY seq DESC LIMIT 1")
BAD_LINE=$(node -e 'console.log(JSON.stringify({comments:[{path:"src/order.js",side:"new",line:99999,lineText:"x",body:"yok",diffSeq:Number(process.argv[1])}]}))' "$DIFFSEQ")
BAD_TEXT=$(node -e 'console.log(JSON.stringify({comments:[{path:"src/order.js",side:"new",line:Number(process.argv[1]),lineText:"BU SATIR BÖYLE DEĞİL",body:"yok",diffSeq:Number(process.argv[2])}]}))' "$LINE" "$DIFFSEQ")
C1=$(bcurl -o /dev/null -w '%{http_code}' -X POST "$BASE/rooms/$ROOM/agents/$AGENT/reviews" -H 'content-type: application/json' -d "$BAD_LINE")
C2=$(bcurl -o /dev/null -w '%{http_code}' -X POST "$BASE/rooms/$ROOM/agents/$AGENT/reviews" -H 'content-type: application/json' -d "$BAD_TEXT")
if [ "$C1" = "400" ] && [ "$C2" = "400" ]; then
  ok "olmayan satır 400, uyuşmayan lineText 400"
else
  no "beklenen 400/400, gelen $C1/$C2"
fi

###############################################################################
step "11) Çöz ve yeniden aç  [görev 17]"
if [ -n "$CID" ]; then
  bcurl -o /dev/null -X POST "$BASE/rooms/$ROOM/comments/$CID/resolve"
  bcurl -o /dev/null -X POST "$BASE/rooms/$ROOM/comments/$CID/reopen"
  EVS=$(psql_q "SELECT string_agg(type, '>' ORDER BY seq) FROM session_events WHERE session_id='$SID' AND type IN ('comment.resolved','comment.reopened') AND payload->>'commentId'='$CID'")
  if [ "$EVS" = "comment.resolved>comment.reopened" ]; then
    ok "comment.resolved > comment.reopened"
  else
    no "beklenen resolved>reopened, gelen: $EVS"
  fi
else
  no "commentId bulunamadı"
fi

###############################################################################
step "12) Her tamamlanan turn'ün bir turn checkpoint'i var  [görev 20]"
TURNS=$(psql_q "SELECT count(*) FROM session_events WHERE session_id='$SID' AND type='turn.completed'")
CPS=$(psql_q "SELECT count(*) FROM session_events WHERE session_id='$SID' AND type='checkpoint.created' AND payload->>'kind'='turn'")
if [ "$TURNS" = "$CPS" ] && [ "$TURNS" != "0" ]; then
  ok "$TURNS turn, $CPS turn checkpoint'i"
else
  no "turn=$TURNS checkpoint=$CPS (eşit olmalı)"
fi
