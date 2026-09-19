#!/usr/bin/env bash
#
# Hafta 4 kapısı — redaction, snapshot, auth, davet, presence.
#
#   npm run gate:w4
#
# AGENT GEREKTİRMEZ. Bu haftanın konusu agent değil GEÇİT: secret'ın event
# log'a yazılmadan temizlenmesi, snapshot'ın doğruluğu, yetkinin sunucuda
# olması ve presence. Event üretmek için dev ucu kullanılır — gerçek event,
# gerçek DB, gerçek SSE, gerçek redaction; ama deterministik ve ücretsiz.
#
# Gerçek agent'ın .env okumasıyla yapılan kontrol AYRI: npm run gate:w4:agent
set -uo pipefail
export MSYS_NO_PATHCONV=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${GATE_PORT:-8798}"
BASE="http://localhost:$PORT"
export DATABASE_URL="${DATABASE_URL:-postgres://rooms:Kk2007..@localhost:5433/agent_rooms}"

PASS=0; FAIL=0
SERVER_PID=""
ROOM=""; SID=""
# Klasör adı KOŞUMA ÖZEL: asılı kalmış bir kapının temizlik kancası, sonradan
# başlayan kapının klasörünü siliyordu ve 5 kontrol sahtelikten düştü.
TMP=".gate4-tmp-$$"
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

# --- SAHTE secret'lar. Formatları gerçek, değerleri uydurma. ----------------
S_AWS="AKIAIOSFODNN7EXAMPLE"
S_ANT="sk-ant-api03-GateTestFakeKeyAbCdEfGhIjKl"
S_B64="Zt9xQv2LmNpR4sT7uWyA3bCdEfGhJkLmNpQrStUv"
S_DB="gate-fake-db-password-9xQ"

cleanup() {
  step "20) Temizlik"
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

echo "Hafta 4 kapısı — $BASE"

# --- ön koşullar -----------------------------------------------------------
if ! docker compose exec -T postgres pg_isready -U rooms -d agent_rooms >/dev/null 2>&1; then
  echo "  ✗ postgres ayakta değil — önce: npm run db:up"; exit 1
fi
# Port doluysa eski bir sunucu vardır ve kapı ESKİ derlemeyi ölçer; bu oturumda
# iki kez başımıza geldi, artık baştan reddediyoruz.
if curl -s --max-time 2 "$BASE/health" >/dev/null 2>&1; then
  echo "  ✗ $PORT zaten dinleniyor — eski sunucuyu kapat (kapı eski derlemeyi ölçmesin)"; exit 1
fi
npm run build >/dev/null 2>&1 || { echo "build başarısız"; exit 1; }
npm run db:migrate >/dev/null 2>&1 || { echo "migration başarısız"; exit 1; }

AUTH_DEV_MODE=true SPAWN_CONTAINER=0 PORT="$PORT" node apps/api/dist/index.js >"$TMP/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 40); do
  [ "$(curl -s --max-time 5 "$BASE/health" | jget ok)" = "true" ] && break
  sleep 0.5
done

# --- iki kullanıcı: A oda sahibi, B davetli izleyici ------------------------
STAMP="$$-$(date +%s)"
A_MAIL="gate4a-$STAMP@rooms.local"
B_MAIL="gate4b-$STAMP@rooms.local"
A=$(node scripts/dev-login.mjs --base "$BASE" --email "$A_MAIL")
B=$(node scripts/dev-login.mjs --base "$BASE" --email "$B_MAIL")
if [ -z "$A" ] || [ -z "$B" ]; then echo "giriş başarısız"; exit 1; fi

acurl() { curl -s --max-time 30 -b "rooms_session=$A" "$@"; }
bcurl() { curl -s --max-time 30 -b "rooms_session=$B" "$@"; }

CREATE=$(acurl -X POST "$BASE/rooms" -H 'content-type: application/json' -d '{}')
ROOM=$(echo "$CREATE" | jget room.id)
SID=$(echo "$CREATE" | jget session.id)
if [ -z "$ROOM" ]; then echo "oda açılamadı: $CREATE"; exit 1; fi

# Dev ucuyla event yaz (A olarak).
write_event() { # <type> <payload-json>
  acurl -o /dev/null -X POST "$BASE/sessions/$SID/events" \
    -H 'content-type: application/json' \
    -d "{\"type\":\"$1\",\"payload\":$2}"
}

MSG_ID="11111111-1111-4111-8111-111111111111"

###############################################################################
step "1) .env çıktısı log'a temiz giriyor"
ENV_OUT="cat .env\\nAWS_ACCESS_KEY_ID=$S_AWS\\nANTHROPIC_API_KEY=$S_ANT\\nSESSION_SECRET=$S_B64\\nDB_PASSWORD=$S_DB\\nPORT=8787"
write_event "tool.result" "{\"agent\":\"backend\",\"messageId\":\"$MSG_ID\",\"toolUseId\":\"call-env\",\"isError\":false,\"truncated\":false,\"output\":\"$ENV_OUT\"}"
sleep 1
LEAKS=0
for s in "$S_AWS" "$S_ANT" "$S_B64" "$S_DB"; do
  N=$(psql_q "SELECT count(*) FROM session_events WHERE session_id='$SID' AND payload::text LIKE '%$s%'")
  if [ "$N" != "0" ]; then LEAKS=$((LEAKS + 1)); fi
done
if [ "$LEAKS" = "0" ]; then ok "dört sahte secret'ın hiçbiri DB'de yok"; else no "$LEAKS secret DB'de duruyor"; fi

###############################################################################
step "2) SSE çıktısında da yok"
node scripts/sse-probe.mjs "$ROOM" --base "$BASE" --session "$A" --duration 4 --out "$TMP/sse.json" >/dev/null
# Dosya yoksa bu kontrol SESSİZCE geçerdi; olmayan dosyada grep hiçbir şey
# bulamaz. "Bulamadım" ile "bakamadım" aynı şey değil.
if [ ! -s "$TMP/sse.json" ]; then
  no "SSE çıktısı alınamadı (probe dosyası yok)"
else
  SSE_LEAK=0
  for s in "$S_AWS" "$S_ANT" "$S_B64" "$S_DB"; do
    if grep -q "$s" "$TMP/sse.json"; then SSE_LEAK=$((SSE_LEAK + 1)); fi
  done
  if [ "$SSE_LEAK" = "0" ]; then ok "akışta da sızıntı yok"; else no "$SSE_LEAK secret SSE'de göründü"; fi
fi

###############################################################################
step "3) Çıktı silinmedi, sadece maskelendi"
MARKS=$(psql_q "SELECT count(*) FROM session_events WHERE session_id='$SID' AND payload::text LIKE '%[redacted:%'")
KEEPS=$(psql_q "SELECT count(*) FROM session_events WHERE session_id='$SID' AND payload::text LIKE '%ANTHROPIC_API_KEY=%'")
if [ "$MARKS" -ge 1 ] && [ "$KEEPS" -ge 1 ]; then
  ok "[redacted: işareti var ve anahtar ADI okunabilir kalmış"
else
  no "işaret=$MARKS · anahtar adı korunmuş satır=$KEEPS"
fi

###############################################################################
step "4) Bulgu kaydı var ve ham secret içermiyor"
FCOUNT=$(psql_q "SELECT count(*) FROM redaction_findings WHERE session_id='$SID'")
FLEAK=0
for s in "$S_AWS" "$S_ANT" "$S_B64" "$S_DB"; do
  N=$(psql_q "SELECT count(*) FROM redaction_findings WHERE session_id='$SID' AND (rule LIKE '%$s%' OR path LIKE '%$s%' OR hash8 LIKE '%$s%')")
  if [ "$N" != "0" ]; then FLEAK=$((FLEAK + 1)); fi
done
if [ "$FCOUNT" -ge 4 ] && [ "$FLEAK" = "0" ]; then
  ok "$FCOUNT bulgu, hiçbirinde ham değer yok"
else
  no "bulgu=$FCOUNT (en az 4 bekleniyor) · ham değer taşıyan=$FLEAK"
fi

###############################################################################
step "5) Yanlış pozitif yok — normal kaynak dosya"
SAFE="const roomId = 3437e583-ca04-4f96-a9ef-817e6111a371;\\n// 9f2a1c4e7b8d3a5f6e0c9b2d4a7f1e8c3b6d5a09 tarihli commit\\nimport { project } from @agent-rooms/view;\\nconst p = /room/worktrees/backend/node_modules/@agent-rooms/protocol/dist/index.js;"
BEFORE=$(psql_q "SELECT count(*) FROM redaction_findings WHERE session_id='$SID'")
write_event "tool.result" "{\"agent\":\"backend\",\"messageId\":\"$MSG_ID\",\"toolUseId\":\"call-safe\",\"isError\":false,\"truncated\":false,\"output\":\"$SAFE\"}"
sleep 1
AFTER=$(psql_q "SELECT count(*) FROM redaction_findings WHERE session_id='$SID'")
if [ "$BEFORE" = "$AFTER" ]; then
  ok "git sha, UUID ve uzun yol maskelenmedi (bulgu sayısı $BEFORE değişmedi)"
else
  no "yanlış pozitif: bulgu $BEFORE → $AFTER"
fi

###############################################################################
step "6) Anahtar sunucu logunda da yok"
if [ ! -f "$TMP/server.log" ]; then
  no "sunucu logu bulunamadı — kontrol yapılamadı"
elif grep -q "$S_ANT" "$TMP/server.log"; then
  no "anahtar sunucu loguna düşmüş"
else
  ok "sunucu logu temiz (logger redaction'dan geçiyor)"
fi

###############################################################################
step "7) Redaction birim testleri"
if npx vitest run packages/redact/test >"$TMP/redact-test.log" 2>&1; then
  ok "kural, entropi, motor ve performans testleri geçti"
else
  no "redact testleri düştü"; tail -5 "$TMP/redact-test.log"
fi

###############################################################################
step "8) Tek geçit: session_events'e başka yazan yok"
HITS=$(grep -rln "INSERT INTO session_events" --include=*.ts --include=*.mjs packages apps scripts 2>/dev/null | grep -v dist | grep -v node_modules | tr -d ' \r')
if [ "$HITS" = "packages/core/src/db/eventStore.ts" ]; then
  ok "yalnızca appendEvent yazıyor"
else
  no "başka yazan var: $HITS"
fi

###############################################################################
step "9) Snapshot üretiliyor"
# ÇIPLAK `wait` KULLANMA: arka planda sunucu da var, onu beklerse kapı
# sonsuza kadar asılı kalır (Hafta 3 kapısındaki aynı uyarı).
WRITERS=""
for i in $(seq 1 205); do
  write_event "debug.note" "{\"text\":\"gate4-$i\"}" &
  WRITERS="$WRITERS $!"
  if [ $((i % 20)) = 0 ]; then
    for pid in $WRITERS; do wait "$pid" 2>/dev/null; done
    WRITERS=""
  fi
done
for pid in $WRITERS; do wait "$pid" 2>/dev/null; done
sleep 3
SNAPS=$(psql_q "SELECT count(*) FROM snapshots WHERE session_id='$SID'")
SNAPSEQ=$(psql_q "SELECT max(seq) FROM snapshots WHERE session_id='$SID'")
if [ "$SNAPS" -ge 1 ]; then ok "$SNAPS snapshot (son seq=$SNAPSEQ)"; else no "snapshot üretilmedi"; fi

###############################################################################
step "10) project(hepsi) == snapshot + sonrası"
EQ=$(ROOM="$ROOM" BASE="$BASE" TOKEN="$A" node --input-type=module -e '
  const { project } = await import("./packages/view/dist/project.js");
  const h = { cookie: `rooms_session=${process.env.TOKEN}` };
  const room = process.env.ROOM, base = process.env.BASE;
  const snap = await (await fetch(`${base}/rooms/${room}/snapshot`, { headers: h })).json();
  const all = [];
  let since = 0;
  for (;;) {
    const page = await (await fetch(`${base}/rooms/${room}/events?since=${since}&limit=500`, { headers: h })).json();
    all.push(...page.events);
    if (!page.hasMore) break;
    since = page.lastSeq;
  }
  const full = project(all);
  const incremental = project(all.filter((e) => e.seq > snap.seq), snap.state ?? undefined);
  // DERİN eşitlik, metin eşitliği değil: snapshot JSONB olarak gidip geliyor ve
  // Postgres nesne anahtarlarını yeniden sıralıyor. JSON.stringify ile
  // karşılaştırmak, sıra farkını veri farkı sanar.
  const { isDeepStrictEqual } = await import("node:util");
  console.log(isDeepStrictEqual(full, incremental) ? "esit" : "farkli");
' 2>"$TMP/eq.log")
if [ "$EQ" = "esit" ]; then
  ok "derin eşit — projeksiyon saf"
else
  no "eşit değil ($EQ)"; tail -3 "$TMP/eq.log"
fi

###############################################################################
step "11) Snapshot'tan bağlanan ile sıfırdan bağlanan aynı yere varıyor"
FROM0=$(node scripts/sse-probe.mjs "$ROOM" --base "$BASE" --session "$A" --since 0 --duration 6 | jget range)
FROMSNAP=$(node scripts/sse-probe.mjs "$ROOM" --base "$BASE" --session "$A" --since "$SNAPSEQ" --duration 6 | jget range)
END0="${FROM0##*..}"; ENDS="${FROMSNAP##*..}"
if [ -n "$END0" ] && [ "$END0" = "$ENDS" ]; then
  ok "ikisi de seq $END0 noktasına ulaştı (replay $FROM0 · snapshot sonrası $FROMSNAP)"
else
  no "farklı son: $FROM0 vs $FROMSNAP"
fi

###############################################################################
step "12) Yetki: 401 / 403 ayrımı"
C1=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/rooms/$ROOM/events")
C2=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -b "rooms_session=$B" "$BASE/rooms/$ROOM/events")
C3=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -b "rooms_session=$B" "$BASE/rooms/00000000-0000-4000-8000-000000000000/events")
if [ "$C1" = "401" ] && [ "$C2" = "403" ] && [ "$C3" = "403" ]; then
  ok "oturumsuz 401 · üye değil 403 · olmayan oda 403 (404 değil, kimlik sızdırmaz)"
else
  no "oturumsuz=$C1 üyesiz=$C2 olmayan=$C3"
fi

###############################################################################
step "13) Davet: B katılıyor ve snapshot alabiliyor"
# ROL AÇIKÇA `viewer`: Hafta 5'te davetin varsayılanı `member` oldu. Bu
# kapının ölçtüğü şey "izleyici yazamaz" olduğu için rolü burada açıkça
# söylemek gerekiyor — varsayılana güvenmek testin ne ölçtüğünü sessizce
# değiştirdi (bir kez düştü, sebebi buydu).
INV=$(acurl -X POST "$BASE/rooms/$ROOM/invites" -H 'content-type: application/json' -d '{"expiresInHours":2,"role":"viewer"}')
INV_URL=$(echo "$INV" | jget url)
INV_TOKEN=$(node -e 'console.log(new URL(process.argv[1]).searchParams.get("token"))' "$INV_URL" 2>/dev/null)
ACC=$(bcurl -X POST "$BASE/invites/accept" -H 'content-type: application/json' -d "{\"token\":\"$INV_TOKEN\"}" | jget role)
SNAP_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -b "rooms_session=$B" "$BASE/rooms/$ROOM/snapshot")
if [ "$ACC" = "viewer" ] && [ "$SNAP_CODE" = "200" ]; then
  ok "davet kabul edildi (viewer), snapshot 200"
else
  no "rol=$ACC snapshot=$SNAP_CODE"
fi

###############################################################################
step "14) İzleyici yazamıyor"
W1=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -b "rooms_session=$B" -X POST "$BASE/rooms/$ROOM/agents/backend/message" -H 'content-type: application/json' -d '{"text":"merhaba"}')
W2=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -b "rooms_session=$B" -X POST "$BASE/rooms/$ROOM/agents/backend/start")
W3=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -b "rooms_session=$B" -X POST "$BASE/rooms/$ROOM/invites" -H 'content-type: application/json' -d '{}')
if [ "$W1" = "403" ] && [ "$W2" = "403" ] && [ "$W3" = "403" ]; then
  ok "mesaj/başlat/davet üçü de 403"
else
  no "mesaj=$W1 başlat=$W2 davet=$W3"
fi

###############################################################################
step "15) Tek kullanımlık link, süresi dolmuş ve iptal edilmiş davet"
TMP_MAIL="gate4c-$STAMP@rooms.local"
LINK=$(curl -s --max-time 10 -X POST "$BASE/auth/request" -H 'content-type: application/json' -d "{\"email\":\"$TMP_MAIL\"}" | jget devLink)
TOK=$(node -e 'console.log(new URL(process.argv[1]).searchParams.get("token"))' "$LINK")
U1=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/auth/callback?token=$TOK")
U2=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/auth/callback?token=$TOK")

INV2=$(acurl -X POST "$BASE/rooms/$ROOM/invites" -H 'content-type: application/json' -d '{"role":"viewer"}')
T2=$(node -e 'console.log(new URL(process.argv[1]).searchParams.get("token"))' "$(echo "$INV2" | jget url)")
P2=$(echo "$INV2" | jget prefix)
psql_q "UPDATE room_invites SET expires_at = now() - interval '1 hour' WHERE token_prefix='$P2'" >/dev/null
E2=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -b "rooms_session=$B" -X POST "$BASE/invites/accept" -H 'content-type: application/json' -d "{\"token\":\"$T2\"}")

INV3=$(acurl -X POST "$BASE/rooms/$ROOM/invites" -H 'content-type: application/json' -d '{"role":"viewer"}')
T3=$(node -e 'console.log(new URL(process.argv[1]).searchParams.get("token"))' "$(echo "$INV3" | jget url)")
P3=$(echo "$INV3" | jget prefix)
acurl -o /dev/null -X DELETE "$BASE/rooms/$ROOM/invites/$P3"
E3=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -b "rooms_session=$B" -X POST "$BASE/invites/accept" -H 'content-type: application/json' -d "{\"token\":\"$T3\"}")

if [ "$U1" = "302" ] && [ "$U2" = "400" ] && [ "$E2" = "400" ] && [ "$E3" = "400" ]; then
  ok "ikinci kullanım 400 · süresi dolmuş 400 · iptal edilmiş 400"
else
  no "ilk=$U1 ikinci=$U2 süresi dolmuş=$E2 iptal=$E3"
fi

###############################################################################
step "16) DB'de ham token yok"
RAW1=$(psql_q "SELECT count(*) FROM magic_links WHERE token_hash='$TOK'")
RAW2=$(psql_q "SELECT count(*) FROM room_invites WHERE token_hash='$INV_TOKEN'")
RAW3=$(psql_q "SELECT count(*) FROM auth_sessions WHERE token_hash='$A'")
if [ "$RAW1" = "0" ] && [ "$RAW2" = "0" ] && [ "$RAW3" = "0" ]; then
  ok "magic link, davet ve oturum token'ları yalnızca hash olarak duruyor"
else
  no "ham token bulundu: magic=$RAW1 davet=$RAW2 oturum=$RAW3"
fi

###############################################################################
step "17) Davetli 3 saniyenin altında senkron oluyor"
SYNC=$(node scripts/sse-probe.mjs "$ROOM" --base "$BASE" --session "$B" --since "$SNAPSEQ" --duration 4 | jget firstFrameMs)
if [ -n "$SYNC" ] && [ "$SYNC" -lt 3000 ]; then
  ok "ilk frame $SYNC ms (hedef < 3000)"
else
  no "ilk frame $SYNC ms"
fi

###############################################################################
step "18) Presence: iki kişi, bakış değişimi ve kopma"
(
  sleep 2
  node scripts/sse-probe.mjs "$ROOM" --base "$BASE" --session "$A" --duration 8 >/dev/null 2>&1
) &
AWATCH=$!
(
  sleep 4
  curl -s --max-time 10 -b "rooms_session=$A" -X POST "$BASE/rooms/$ROOM/presence" \
    -H 'content-type: application/json' -d '{"viewing":"backend"}' >/dev/null
) &
POKE=$!
node scripts/sse-probe.mjs "$ROOM" --base "$BASE" --session "$B" --duration 22 \
  --presence-out "$TMP/presence.json" >/dev/null
wait "$AWATCH" 2>/dev/null
wait "$POKE" 2>/dev/null

PRES=$(node -e '
  const f = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const two = f.find((x) => x.people.length === 2);
  const viewing = f.find((x) => x.people.some((p) => p.viewing === "backend"));
  const backToOne = f.filter((x) => x.people.length === 1).pop();
  const dropMs = two && backToOne && backToOne.atMs > two.atMs ? backToOne.atMs - two.atMs : null;
  const seeMs = two && viewing ? viewing.atMs - two.atMs : null;
  console.log(JSON.stringify({ frames: f.length, two: Boolean(two), seeMs, dropMs }));
' "$TMP/presence.json")
TWO=$(echo "$PRES" | jget two); SEE=$(echo "$PRES" | jget seeMs); DROP=$(echo "$PRES" | jget dropMs)
if [ "$TWO" = "true" ] && [ -n "$SEE" ] && [ "$SEE" -lt 2000 ] && [ -n "$DROP" ] && [ "$DROP" -lt 15000 ]; then
  ok "iki kişi görüldü · bakış değişimi $SEE ms içinde · kopma $DROP ms içinde düştü"
else
  no "presence: $PRES"
fi

###############################################################################
step "19) Presence event log'a yazılmıyor"
PEVENTS=$(psql_q "SELECT count(*) FROM session_events WHERE type LIKE 'presence%'")
if [ "$PEVENTS" = "0" ]; then ok "session_events içinde presence tipi yok"; else no "$PEVENTS presence event'i yazılmış"; fi

###############################################################################
step "(regresyon) Hafta 1 ve Hafta 3 kapıları"
if bash scripts/week1-gate.sh >"$TMP/w1.log" 2>&1; then ok "Hafta 1 kapısı 10/10"; else no "Hafta 1 kapısı düştü"; tail -6 "$TMP/w1.log"; fi
if bash scripts/week3-gate.sh >"$TMP/w3.log" 2>&1; then ok "Hafta 3 kapısı 11/11"; else no "Hafta 3 kapısı düştü"; tail -6 "$TMP/w3.log"; fi

trap - EXIT
cleanup

echo ""
echo "──────────────────────────────"
echo "Geçen: $PASS   Kalan: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "HAFTA 4 KAPISI GEÇİLEMEDİ."
  exit 1
fi
echo "HAFTA 4 KAPISI GEÇİLDİ — gerçek agent'la .env kontrolü ayrı: npm run gate:w4:agent"
