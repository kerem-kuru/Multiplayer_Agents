#!/usr/bin/env bash
#
# Hafta 7 kapısı — worktree izolasyonu, git katmanı, çökme yalıtımı, temizlik
# ve arayüz.
#
#   npm run gate:w7
#
# MODEL İSTEĞİ HARCAMAZ. Hafta 6'daki gibi bilinçli bir bölme:
#
#   1. Bu kapı: izolasyonun DOSYA SİSTEMİNDE kurulduğunu kanıtlayan her şey.
#      İzin matrisi, G1–G7, üçüncü agent, geçersiz config, çökme yalıtımı,
#      izin kayması (sunucu denetimi), silme, sweeper ve arayüzün modelsiz
#      kısmı. Agent'lar BAŞLATILIR (runner'ın ayağa kalkması model isteği
#      harcamaz) çünkü "runner kendi kullanıcısıyla koşuyor" ve "biri çökünce
#      diğeri koşmaya devam ediyor" canlı süreç ister.
#
#   2. `npm run gate:w7:agent`: agent'ın kendisinin izin hatası alması,
#      örtüşen turn'ler, çakışma tespiti, contracts olayları, turn sonu
#      denetimi, koşarken kart satırı ve okunmamış işareti. Bunlar gerçek bir
#      tool çağrısı ister.
#
# Gerekenler: postgres ayakta (npm run db:up), güncel oda imajı
# (npm run room:build), bir anahtar (runner kalkabilsin), Playwright
# chromium (npx playwright install chromium).
#
# Görev tanımındaki numaralar köşeli parantezde: [3] = kontrol 3, [G2] = git
# katmanı 2, [M] = izin matrisi.
set -uo pipefail
export MSYS_NO_PATHCONV=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
. "$ROOT/scripts/lib/room-exec.sh"

PORT="${GATE_PORT:-8797}"
WEB_PORT="${GATE_WEB_PORT:-5197}"
BASE="http://localhost:$PORT"
export DATABASE_URL="${DATABASE_URL:-postgres://rooms:Kk2007..@localhost:5433/agent_rooms}"
# Önceki haftaların kapıları ~15 dakika sürüyor; varsayılan olarak atlanır.
RUN_REGRESSION="${GATE_W7_REGRESSION:-0}"
RUN_UI="${GATE_W7_UI:-1}"

PASS=0; FAIL=0
SERVER_PID=""; WEB_PID=""; ROOM=""; ROOM3=""; SID=""; C=""; SHORT=""
TMP=".gate7-tmp-$$"
rm -rf "$TMP"; mkdir -p "$TMP"
ORPHAN_ID=""

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

kill_tree() {
  # Git Bash'te `kill` yalnızca MSYS sürecini öldürür; node alt süreci kalır.
  local pid="$1"
  [ -z "$pid" ] && return
  local win; win=$(ps -p "$pid" -o winpid= 2>/dev/null | tr -d ' ')
  kill "$pid" 2>/dev/null
  [ -n "$win" ] && taskkill //F //T //PID "$win" >/dev/null 2>&1
}

# Portu dinleyen Windows sürecini öldürür. Vite alt kabukta (`cd apps/web &&
# npx vite`) başlıyor; MSYS pid'i üzerinden ağaç öldürme onu yakalamıyor.
kill_port() {
  local p
  for p in $(netstat -ano 2>/dev/null | grep -E "[:.]$1 " | grep LISTEN | awk '{print $5}' | sort -u); do
    taskkill //F //T //PID "$p" >/dev/null 2>&1
  done
}

cleanup() {
  step "Temizlik"
  kill_tree "$WEB_PID"
  kill_tree "$SERVER_PID"
  kill_port "$WEB_PORT"
  kill_port "$PORT"
  local removed=0
  for r in "$ROOM" "$ROOM3" "$ORPHAN_ID"; do
    [ -z "$r" ] && continue
    for c in $(docker ps -aq --filter "label=agent-rooms.room=$r"); do
      docker rm -f "$c" >/dev/null 2>&1 && removed=$((removed + 1))
    done
    docker volume rm -f "room-$r" >/dev/null 2>&1
  done
  rm -rf "$TMP"
  echo "  · oda container'ları ve volume'ları silindi ($removed container)"
  echo ""
  echo "Hafta 7 kapısı: $PASS geçti, $FAIL kaldı"
  [ "$FAIL" -eq 0 ] || exit 1
}
trap cleanup EXIT

echo "Hafta 7 kapısı — izolasyon, git katmanı, çökme, temizlik, arayüz"

# --- önkoşullar ------------------------------------------------------------
if ! docker compose exec -T postgres pg_isready -U rooms -d agent_rooms >/dev/null 2>&1; then
  echo "  ✗ postgres ayakta değil — önce: npm run db:up"; trap - EXIT; exit 1
fi
if curl -s --max-time 2 "$BASE/health" >/dev/null 2>&1; then
  echo "  ✗ $PORT zaten dinleniyor — eski sunucuyu kapat"; trap - EXIT; exit 1
fi
if ! grep -qE '^(GEMINI|ANTHROPIC)_API_KEY=.' .env 2>/dev/null \
   && [ -z "${GEMINI_API_KEY:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "  ✗ hiçbir anahtar tanımlı değil — runner başlatılamaz (model isteği harcanmaz, sadece süreç kalkar)"
  trap - EXIT; exit 1
fi
npm run build >/dev/null 2>&1 || { echo "build başarısız"; trap - EXIT; exit 1; }
npm run db:migrate >/dev/null 2>&1 || { echo "migration başarısız"; trap - EXIT; exit 1; }

# --- fixture -> git deposu -> local kaynak ----------------------------------
SRC_ROOT="$ROOT/$TMP/src"
SRC="$SRC_ROOT/week7-repo"
mkdir -p "$SRC"
cp -r test/fixtures/week7-repo/. "$SRC/"
git -C "$SRC" init -q -b main
git -C "$SRC" -c user.name=gate -c user.email=gate@local add -A
git -C "$SRC" -c user.name=gate -c user.email=gate@local commit -q -m "week7 fixture"
SRC_SHA=$(git -C "$SRC" rev-parse HEAD)

# Üç config: iki agent'lı ana oda, üç agent'lı (security okur) ve GEÇERSİZ.
# Yollar repo kökünün altında olmalı (resolveConfigPath).
node -e '
  const fs = require("fs");
  const YAML = require("yaml");
  const [src, repo, dir] = process.argv.slice(1);
  const cfg = YAML.parse(fs.readFileSync(src, "utf8"));
  cfg.repo = { kind: "local", path: repo, ref: "main" };
  fs.writeFileSync(`${dir}/room.yaml`, YAML.stringify(cfg));

  const three = structuredClone(cfg);
  three.agents.push({
    ...cfg.agents[0],
    name: "security",
    systemPrompt: "Sen bu odanin guvenlik incelemecisisin.",
    workspace: "worktrees/security",
    writable: ["worktrees/security", "contracts"],
    readable: ["worktrees/*"],
  });
  fs.writeFileSync(`${dir}/room3.yaml`, YAML.stringify(three));

  const bad = structuredClone(cfg);
  bad.agents[0].writable = ["worktrees/frontend", "worktrees/backend"];
  fs.writeFileSync(`${dir}/bad.yaml`, YAML.stringify(bad));
' config/room.week7.yaml "$SRC" "$TMP"

AUTH_DEV_MODE=true ROOM_CONFIG="$TMP/room.yaml" ROOMS_SOURCE_ROOT="$SRC_ROOT" PORT="$PORT" \
  node apps/api/dist/index.js >"$TMP/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 60); do
  [ "$(curl -s --max-time 5 "$BASE/health" | jget ok)" = "true" ] && break
  sleep 0.5
done
if [ "$(curl -s --max-time 5 "$BASE/health" | jget ok)" != "true" ]; then
  echo "sunucu kalkmadı"; tail -20 "$TMP/server.log"; exit 1
fi

# --- iki kullanıcı: A owner, B member ---------------------------------------
STAMP="$$-$(date +%s)"
B_NAME="gate7b-$STAMP"
A=$(node scripts/dev-login.mjs --base "$BASE" --email "gate7a-$STAMP@rooms.local")
B=$(node scripts/dev-login.mjs --base "$BASE" --email "$B_NAME@rooms.local")
if [ -z "$A" ] || [ -z "$B" ]; then echo "giriş başarısız"; exit 1; fi
acurl() { curl -s --max-time 120 -b "rooms_session=$A" "$@"; }
bcurl() { curl -s --max-time 120 -b "rooms_session=$B" "$@"; }

CREATE=$(acurl -X POST "$BASE/rooms" -H 'content-type: application/json' -d '{}')
ROOM=$(echo "$CREATE" | jget room.id)
SID=$(echo "$CREATE" | jget session.id)
if [ -z "$ROOM" ]; then echo "oda açılamadı: $CREATE"; tail -30 "$TMP/server.log"; exit 1; fi
C="$(room_container "$ROOM")"
SHORT=$(echo "$ROOM" | tr -d '-' | cut -c1-8)
echo "  · oda $ROOM (container $C)"

INV=$(acurl -X POST "$BASE/rooms/$ROOM/invites" -H 'content-type: application/json' -d '{"role":"member"}' | jget url)
bcurl -o /dev/null -X POST "$BASE/invites/accept" -H 'content-type: application/json' \
  -d "{\"token\":\"${INV##*token=}\"}"

# Event sayacı: tür (+ isteğe bağlı agent) → adet.
events_json() { acurl "$BASE/rooms/$1/events?since=0&limit=1000"; }
count_events() {
  local room="$1" type="$2" agent="${3:-}"
  events_json "$room" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const [type, agent] = process.argv.slice(1);
      const ev = (JSON.parse(s).events || []).filter(
        (e) => e.type === type && (!agent || (e.payload && e.payload.agent === agent)),
      );
      console.log(ev.length);
    });' "$type" "$agent"
}

agent_status() {
  acurl "$BASE/rooms/$1/agents" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const a = (JSON.parse(s).agents || []).find((x) => x.name === process.argv[1]);
      console.log((a && a.runtime && a.runtime.status) || "?");
    });' "$2"
}
wait_idle() {
  local room="$1" agent="$2" st="?"
  for _ in $(seq 1 120); do
    st=$(agent_status "$room" "$agent")
    [ "$st" = "idle" ] && return 0
    sleep 1
  done
  echo "  · $agent hazır olmadı (durum=$st)"; return 1
}

for a in frontend backend; do acurl -o /dev/null -X POST "$BASE/rooms/$ROOM/agents/$a/start"; done
for a in frontend backend; do wait_idle "$ROOM" "$a" || { tail -30 "$TMP/server.log"; exit 1; }; done

# Kapının KENDİ git okumaları nötr: hook/fsmonitor çalıştırmaz (22 Eylül dersi).
ngit() {
  local user="$1" dir="$2"; shift 2
  docker exec -u "$user" -e GIT_OPTIONAL_LOCKS=0 "$C" \
    git -c core.hooksPath=/dev/null -c core.fsmonitor=false -C "$dir" "$@" 2>&1
}

###############################################################################
step "Kurulum"

BASE_SHA=$(events_json "$ROOM" | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const e = (JSON.parse(s).events || []).find((x) => x.type === "room.repo_initialized");
    console.log(e ? e.payload.baseSha : "");
  });')
N_REPO=$(count_events "$ROOM" room.repo_initialized)
N_READY=$(count_events "$ROOM" agent.workspace_ready)
if [ "$N_REPO" = "1" ] && [ "$N_READY" = "2" ] && [ "$BASE_SHA" = "$SRC_SHA" ]; then
  ok "[1] room.repo_initialized ×1, agent.workspace_ready ×2, base_sha = fixture HEAD"
else
  no "[1] repo_initialized=$N_REPO workspace_ready=$N_READY base=$BASE_SHA fixture=$SRC_SHA"
fi
DB_BASE=$(psql_q "SELECT base_sha FROM rooms WHERE id='$ROOM'")
[ "$DB_BASE" = "$BASE_SHA" ] && ok "[1] rooms.base_sha kaydedildi" || no "[1] rooms.base_sha='$DB_BASE'"

for a in frontend backend; do
  br=$(ngit "agent-$a" "/room/worktrees/$a" branch --show-current)
  hd=$(ngit "agent-$a" "/room/worktrees/$a" rev-parse HEAD)
  alt=$(room_exec "$ROOM" "agent-$a" cat "/room/worktrees/$a/.git/objects/info/alternates")
  if [ "$br" = "room-$SHORT/$a" ] && [ "$hd" = "$BASE_SHA" ] && [ "$alt" = "/room/repo.git/objects" ]; then
    ok "[1] $a: branch room-$SHORT/$a, HEAD=base_sha, alternates merkezde"
  else
    no "[1] $a: branch='$br' HEAD='$hd' alternates='$alt'"
  fi
done

# [2] İzinler planla aynı. Beklenen tablo BURADA, elle; plan koddan
# üretilseydi kapı kodun kendisiyle karşılaştırırdı.
cat >"$TMP/expected-stat.txt" <<'EOF'
/room root root 755
/room/repo.git rooms-integrator rooms-integrator 755
/room/worktrees root root 755
/room/worktrees/frontend agent-frontend wtr-frontend 750
/room/worktrees/backend agent-backend wtr-backend 750
/room/contracts root rooms-contracts 2775
/room/journal root root 755
/home/agents/frontend agent-frontend agent-frontend 700
/home/agents/backend agent-backend agent-backend 700
EOF
while read -r path owner group mode; do
  got=$(room_stat "$ROOM" "$path" | tr -d '\r')
  if [ "$got" = "$path $owner $group $mode" ]; then
    ok "[2] $got"
  else
    no "[2] $path: beklenen '$owner $group $mode', gerçek '$got'"
  fi
done <"$TMP/expected-stat.txt"

for a in frontend backend; do
  ids=$(room_exec "$ROOM" root id -nG "agent-$a" | tr -d '\r')
  case " $ids " in
    *" rooms-contracts "*) case "$ids" in *wtr-*) no "[2] agent-$a başka worktree grubunda: $ids" ;; *) ok "[2] id agent-$a → $ids" ;; esac ;;
    *) no "[2] agent-$a rooms-contracts grubunda değil: $ids" ;;
  esac
done
integ=$(room_exec "$ROOM" root id -nG rooms-integrator | tr -d '\r')
[ "$integ" = "rooms-integrator" ] && ok "[2] rooms-integrator hiçbir agent grubunda değil" \
  || no "[2] rooms-integrator grupları: $integ"

# [3] Runner'lar kendi kullanıcılarıyla.
PS=$(room_exec "$ROOM" root ps -eo user:32,args | tr -d '\r')
for a in frontend backend; do
  if echo "$PS" | grep -E "^agent-$a +node .*runner" >/dev/null; then
    ok "[3] runner agent-$a kullanıcısıyla koşuyor"
  else
    no "[3] agent-$a runner'ı yok ya da yanlış kullanıcı:"; echo "$PS" | grep runner | sed 's/^/      /'
  fi
done
if echo "$PS" | grep -E "^root +node .*runner" >/dev/null; then no "[3] root olarak koşan runner var"
else ok "[3] root olarak koşan runner yok"; fi

###############################################################################
step "İzin matrisi  [M, G3]"
#
# Görev tanımındaki tablo, KOD İÇİNDE TABLO olarak. Bir satır eklemek bir satır.
#   kullanıcı | komut | beklenen (ok = başarılı, denied = izin hatası, fail = başarısız)
# `umask 002` runner'ın kendi umask'ı: contracts'a yazılan dosya grupça yazılabilir.
MATRIX=$(cat <<'EOF'
agent-frontend|umask 002; echo x > /room/worktrees/frontend/x|ok
agent-frontend|echo x > /room/worktrees/backend/x|denied
agent-frontend|ls /room/worktrees/backend|denied
agent-frontend|umask 002; echo v1 > /room/contracts/api.md && test "$(stat -c %G /room/contracts/api.md)" = rooms-contracts|ok
agent-backend|echo v2 >> /room/contracts/api.md|ok
agent-frontend|echo x > /room/repo.git/refs/heads/x|denied
agent-frontend|echo x > /room/repo.git/hooks/post-update|denied
agent-frontend|echo x >> /room/repo.git/config|denied
agent-frontend|echo x > /room/worktrees/backend/.git/config|denied
agent-frontend|echo x > /room/worktrees/backend/.git/objects/x|denied
agent-frontend|git -C /room/worktrees/backend status|fail
agent-frontend|echo x > /room/journal/x|denied
agent-backend|echo x > /room/worktrees/frontend/x|denied
agent-backend|cat /room/worktrees/frontend/web/app.js|denied
agent-backend|echo x > /home/agents/frontend/x|denied
agent-frontend|ls /home/agents/backend|denied
EOF
)
while IFS='|' read -r user cmd want; do
  [ -z "$user" ] && continue
  out=$(room_sh "$ROOM" "$user" "$cmd"); code=$?
  label="[M] $user: $cmd → $want"
  case "$want" in
    ok)     [ $code -eq 0 ] && ok "$label" || no "$label (kod $code: $out)" ;;
    fail)   [ $code -ne 0 ] && ok "$label" || no "$label (BAŞARILI oldu)" ;;
    denied)
      if [ $code -ne 0 ] && echo "$out" | grep -qi "permission denied"; then ok "$label"
      else no "$label (kod $code: $out)"; fi ;;
  esac
done <<<"$MATRIX"

CAT=$(room_exec "$ROOM" agent-frontend cat /room/contracts/api.md | tr '\n' ' ')
[ "$CAT" = "v1 v2 " ] && ok "[M] contracts/api.md iki agent'ın yazdığını taşıyor" || no "[M] api.md içeriği: '$CAT'"

###############################################################################
step "Sözleşme okuma ucu symlink ile izolasyonu delmiyor  [Adım 7]"
# 23 Eylül'de bulundu: uç root ile okuyordu, bu linkler içerik döndürdü.
room_sh "$ROOM" agent-backend 'echo BACKEND-GIZLI > /room/worktrees/backend/secret.txt' >/dev/null
room_sh "$ROOM" agent-frontend 'umask 002; ln -s /room/worktrees/backend/secret.txt /room/contracts/leak; ln -s /etc/shadow /room/contracts/shadow; ln -s api.md /room/contracts/alias' >/dev/null
for f in leak shadow; do
  body=$(acurl -w '|%{http_code}' "$BASE/rooms/$ROOM/contracts/$f")
  case "$body" in
    *BACKEND-GIZLI*|*root:*) no "contracts/$f İÇERİK SIZDIRDI: $body" ;;
    *"|400"|*"|404") ok "contracts/$f → ${body##*|} (içerik yok)" ;;
    *) no "contracts/$f beklenmeyen: $body" ;;
  esac
done
# jget kendi satır sonunu ekliyor; içerik satırlarını boşlukla birleştirip karşılaştır.
body=$(acurl "$BASE/rooms/$ROOM/contracts/alias" | jget content | tr -s '\n' ' ' | sed 's/ *$//')
[ "$body" = "v1 v2" ] && ok "contracts içi link ve normal dosya okunuyor" || no "contracts/alias: '$body'"
room_sh "$ROOM" root 'rm -f /room/contracts/leak /room/contracts/shadow /room/contracts/alias /room/worktrees/backend/secret.txt' >/dev/null

###############################################################################
step "Git katmanı"

MAIN_BEFORE=$(ngit rooms-integrator /room/repo.git rev-parse refs/heads/main)
BACK_BEFORE=$(ngit agent-backend /room/worktrees/backend rev-parse "refs/heads/room-$SHORT/backend")

g1_fail() { local out; out=$(room_sh "$ROOM" agent-frontend "$1"); [ $? -ne 0 ] && ok "[G1] reddedildi: $1" || no "[G1] BAŞARILI oldu: $1 ($out)"; }
g1_fail "git -C /room/worktrees/backend branch -D room-$SHORT/backend"
g1_fail "git -C /room/repo.git update-ref -d refs/heads/main"
g1_fail "git -C /room/worktrees/frontend push origin :refs/heads/main"
g1_fail "git -C /room/worktrees/frontend push origin HEAD:refs/heads/room-$SHORT/backend"
MAIN_AFTER=$(ngit rooms-integrator /room/repo.git rev-parse refs/heads/main)
BACK_AFTER=$(ngit agent-backend /room/worktrees/backend rev-parse "refs/heads/room-$SHORT/backend")
[ "$MAIN_BEFORE" = "$MAIN_AFTER" ] && [ "$BACK_BEFORE" = "$BACK_AFTER" ] \
  && ok "[G1] merkezdeki main ve backend'in branch'i değişmedi" \
  || no "[G1] değişti: main $MAIN_BEFORE→$MAIN_AFTER backend $BACK_BEFORE→$BACK_AFTER"

# [G2] Hook sızmaz. contracts herkese yazılabilir: en gerçekçi saldırı yolu.
room_sh "$ROOM" agent-frontend '
  umask 002
  mkdir -p /room/contracts/hooks
  for h in pre-commit post-commit reference-transaction post-checkout; do
    printf "#!/bin/sh\ntouch /room/contracts/PWNED\n" > /room/contracts/hooks/$h
    chmod +x /room/contracts/hooks/$h
  done
  git -C /room/worktrees/frontend config core.hooksPath /room/contracts/hooks' >/dev/null
room_sh "$ROOM" root 'rm -f /room/contracts/PWNED' >/dev/null
out=$(room_sh "$ROOM" agent-backend "git -C /room/worktrees/backend -c user.name=b -c user.email=b@local commit -q --allow-empty -m g2")
[ $? -eq 0 ] || no "[G2] backend commit atamadı: $out"
if room_sh "$ROOM" root 'test -e /room/contracts/PWNED' >/dev/null; then
  no "[G2] backend'in commit'i frontend'in hook'unu ÇALIŞTIRDI"
else
  ok "[G2] backend commit attı, frontend'in ektiği hook çalışmadı"
fi
acurl -o /dev/null -X POST "$BASE/rooms/$ROOM/agents/frontend/checkpoints" \
  -H 'content-type: application/json' -d '{"label":"kapı G2"}'
N_CP=$(count_events "$ROOM" checkpoint.created frontend)
if room_sh "$ROOM" root 'test -e /room/contracts/PWNED' >/dev/null; then
  no "[G2] sunucunun gitkit checkpoint'i frontend'in hook'unu ÇALIŞTIRDI"
elif [ "$N_CP" -ge 2 ]; then
  ok "[G2] gitkit frontend deposunda checkpoint aldı, hook çalışmadı"
else
  no "[G2] checkpoint alınamadı (checkpoint.created=$N_CP)"
fi
room_sh "$ROOM" agent-frontend 'git -C /room/worktrees/frontend config --unset core.hooksPath; rm -rf /room/contracts/hooks' >/dev/null

# [G4] gc sonrası klonlar sağlam.
gc=$(room_sh "$ROOM" rooms-integrator 'git -C /room/repo.git gc -q')
[ $? -eq 0 ] && ok "[G4] merkezde gc koştu (config'e uyarak)" || no "[G4] gc düştü: $gc"
for a in frontend backend; do
  r=$(room_sh "$ROOM" "agent-$a" "git -c core.hooksPath=/dev/null -C /room/worktrees/$a fsck --connectivity-only 2>&1 && git -C /room/worktrees/$a log -1 --format=%H")
  [ $? -eq 0 ] && ok "[G4] $a klonu gc sonrası sağlam (fsck + log -1)" || no "[G4] $a klonu bozuk: $r"
done
for kv in gc.auto=0 gc.pruneExpire=never gc.reflogExpire=never gc.reflogExpireUnreachable=never \
          core.logAllRefUpdates=always receive.denyDeletes=true receive.denyNonFastForwards=true; do
  k=${kv%%=*}; v=${kv#*=}
  got=$(ngit rooms-integrator /room/repo.git config --get "$k" | tr -d '\r')
  [ "$got" = "$v" ] && ok "[G4] $k = $v" || no "[G4] $k = '$got', beklenen $v"
done
bref=$(ngit rooms-integrator /room/repo.git rev-parse "refs/rooms/base/$SHORT" | tr -d '\r')
[ "$bref" = "$BASE_SHA" ] && ok "[G4] refs/rooms/base/$SHORT taban commit'i gösteriyor" || no "[G4] base ref='$bref'"
own=$(room_sh "$ROOM" root 'find /room/repo.git ! -user rooms-integrator | head -3')
[ -z "$own" ] && ok "[G4] merkez deponun her dosyası rooms-integrator'a ait" || no "[G4] başka sahipli dosyalar: $own"

# [G5] Geçmiş yeniden yazma reddedilir — ALICI tarafta, --force'a rağmen.
g5=$(room_sh "$ROOM" rooms-integrator '
  cd /tmp && rm -rf g5 && git clone -q /room/repo.git g5 && cd g5 &&
  git checkout -q --orphan yeni && git -c user.name=g -c user.email=g@local commit -q --allow-empty -m yeni &&
  git push --force origin HEAD:refs/heads/main 2>&1; echo "[nonff=$?]";
  git push origin :refs/heads/main 2>&1; echo "[del=$?]"; cd /tmp && rm -rf g5')
if echo "$g5" | grep -q '\[nonff=[1-9]' && echo "$g5" | grep -qi 'non-fast-forward'; then
  ok "[G5] fast-forward olmayan push (--force ile) reddedildi"
else no "[G5] non-ff push reddedilmedi: $(echo "$g5" | tr '\n' ' ')"; fi
if echo "$g5" | grep -q '\[del=[1-9]' && echo "$g5" | grep -qi 'deletion prohibited'; then
  ok "[G5] branch silme push'u reddedildi"
else no "[G5] silme reddedilmedi: $(echo "$g5" | tr '\n' ' ')"; fi
MAIN_G5=$(ngit rooms-integrator /room/repo.git rev-parse refs/heads/main)
[ "$MAIN_G5" = "$MAIN_BEFORE" ] && ok "[G5] main değişmedi" || no "[G5] main değişti"

# [G6] safe.directory: sistem düzeyinde TAM OLARAK bir kayıt (/room/repo.git,
# gerekçesi README "Hafta 7 kararları"), global düzeyde hiç yok.
sys=$(room_sh "$ROOM" root 'git config --system --get-all safe.directory' | tr -d '\r')
[ "$sys" = "/room/repo.git" ] && ok "[G6] sistem düzeyi yalnızca /room/repo.git" || no "[G6] sistem düzeyi: '$sys'"
for u in agent-frontend agent-backend rooms-integrator root; do
  g=$(room_sh "$ROOM" "$u" 'git config --global --get-all safe.directory' | tr -d '\r')
  [ -z "$g" ] && ok "[G6] $u için global safe.directory yok" || no "[G6] $u global: '$g'"
done
# Kaynak kodda `safe.directory=*` İSTEYEN satır yok. Yorum satırları ve
# yasaklayan testler hariç; local kaynak için KULLAN-AT container'daki /src
# istisnası repo.ts'te gerekçesiyle.
hits=$(grep -rn 'safe\.directory' packages/*/src apps/*/src rooms/Dockerfile 2>/dev/null \
  | grep -vE '^[^:]+:[0-9]+:\s*(\*|//|/\*|#)' \
  | grep -vE 'safe\.directory /src(/\.git)? ' \
  | grep -vE 'config --system safe\.directory /room/repo\.git$')
[ -z "$hits" ] && ok "[G6] kodda safe.directory ayarlayan başka satır yok" || { no "[G6] şüpheli satırlar:"; echo "$hits" | sed 's/^/      /'; }

# [G7] Yanlış kullanıcı yakalanır.
out=$(room_sh "$ROOM" agent-backend 'git -C /room/worktrees/frontend status')
if [ $? -ne 0 ] && echo "$out" | grep -qi 'permission denied'; then ok "[G7] agent-backend frontend deposunda izin hatası aldı"
else no "[G7] agent-backend: $out"; fi
out=$(room_sh "$ROOM" root 'git -C /room/worktrees/frontend status')
if [ $? -ne 0 ] && echo "$out" | grep -qi 'dubious ownership'; then ok "[G7] root 'dubious ownership' aldı — sahiplik kontrolü açık"
else no "[G7] root: $out"; fi

###############################################################################
step "Agent düzeyi (modelsiz kısım)"

# [7] Geçersiz config → 400 ve kuralın kendi cümlesi.
resp=$(acurl -w '|%{http_code}' -X POST "$BASE/rooms" -H 'content-type: application/json' \
  -d "{\"configPath\":\"$TMP/bad.yaml\"}")
if [ "${resp##*|}" = "400" ] && echo "$resp" | grep -q "tek yazarı sahibidir"; then
  ok "[7] geçersiz config → 400, \"tek yazarı sahibidir\""
else
  no "[7] beklenen 400: ${resp:0:300}"
fi
case "$resp" in *"$ROOT"*|*"C:\\"*|*"C:/"*) no "[7] hata mesajı sunucu dosya yolunu sızdırıyor" ;; *) ok "[7] mesajda sunucu dosya yolu yok" ;; esac

# [6] Üçüncü agent: security her şeyi OKUR, kendi yerinden başka yere YAZAMAZ.
C3=$(acurl -X POST "$BASE/rooms" -H 'content-type: application/json' -d "{\"configPath\":\"$TMP/room3.yaml\"}")
ROOM3=$(echo "$C3" | jget room.id)
if [ -z "$ROOM3" ]; then
  no "[6] üç agent'lı oda açılamadı: ${C3:0:300}"
else
  N3=$(echo "$C3" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log((JSON.parse(s).agents||[]).length))')
  [ "$N3" = "3" ] && ok "[6] üç agent'lı oda açıldı" || no "[6] agent sayısı $N3"
  r=$(room_exec "$ROOM3" agent-security cat /room/worktrees/backend/api/server.js)
  echo "$r" | grep -q "createServer" && ok "[6] security backend'in dosyasını OKUYABİLİYOR" || no "[6] security okuyamadı: $r"
  room_denied "$ROOM3" agent-security 'echo x >> /room/worktrees/backend/api/server.js' >/dev/null \
    && ok "[6] security backend'in dosyasına YAZAMIYOR" || no "[6] security yazabildi"
  room_denied "$ROOM3" agent-security 'echo x > /room/worktrees/frontend/yeni.txt' >/dev/null \
    && ok "[6] security frontend'e dosya YARATAMIYOR" || no "[6] security frontend'e yazdı"
  room_denied "$ROOM3" agent-frontend 'ls /room/worktrees/security' >/dev/null \
    && ok "[6] frontend security'nin klasörünü göremiyor (readable yok)" || no "[6] frontend security'yi gördü"
  ids=$(room_exec "$ROOM3" root id -nG agent-security | tr -d '\r')
  case "$ids" in *wtr-frontend*wtr-backend*|*wtr-backend*wtr-frontend*) ok "[6] id agent-security → $ids" ;; *) no "[6] security grupları: $ids" ;; esac
fi

# [9, modelsiz] Çökme yalıtımı: backend runner'ı kill -9 → backend crashed ve
# yeniden kalkıyor, frontend'in SÜRECİ hiç değişmiyor. Turn ortasındaki hali
# (frontend turn'ünü bitiriyor) gate:w7:agent'ta.
runner_pid() { room_exec "$ROOM" root ps -eo pid=,user:32=,args= | tr -d '\r' | awk -v u="agent-$1" '$2==u && /runner/ {print $1; exit}'; }
FPID=$(runner_pid frontend); BPID=$(runner_pid backend)
if [ -z "$FPID" ] || [ -z "$BPID" ]; then
  no "[9] runner pid'leri bulunamadı (frontend=$FPID backend=$BPID)"
else
  room_exec "$ROOM" root kill -9 "$BPID" >/dev/null
  crashed=0
  for _ in $(seq 1 30); do
    [ "$(count_events "$ROOM" agent.crashed backend)" -ge 1 ] && { crashed=1; break; }
    sleep 1
  done
  [ $crashed -eq 1 ] && ok "[9] backend kill -9 → agent.crashed" || no "[9] agent.crashed yazılmadı"
  if wait_idle "$ROOM" backend; then
    NB=$(runner_pid backend)
    [ -n "$NB" ] && [ "$NB" != "$BPID" ] && ok "[9] backend yeniden başladı (pid $BPID → $NB)" || no "[9] backend pid: $NB"
  else no "[9] backend yeniden hazır olmadı"; fi
  [ "$(runner_pid frontend)" = "$FPID" ] && ok "[9] frontend'in runner'ı aynı süreç (pid $FPID)" || no "[9] frontend süreci değişti"
  [ "$(count_events "$ROOM" agent.crashed frontend)" = "0" ] && ok "[9] frontend için crashed yok" || no "[9] frontend de çöktü"
  [ "$(agent_status "$ROOM" frontend)" = "idle" ] && ok "[9] frontend hâlâ idle" || no "[9] frontend durumu: $(agent_status "$ROOM" frontend)"
fi

# [13, sunucu denetimi] Agent boştayken kendi klasörünü gevşetir → 5 dakikalık
# denetim düzeltir ve TEK event yazar. Turn sonu yolu gate:w7:agent'ta.
room_sh "$ROOM" agent-frontend 'chmod 777 /room/worktrees/frontend' >/dev/null
before=$(room_stat "$ROOM" /room/worktrees/frontend | awk '{print $4}')
audit=$(node scripts/lib/w7-core.mjs audit "$ROOM" 2>&1)
after=$(room_stat "$ROOM" /room/worktrees/frontend | awk '{print $4}' | tr -d '\r')
nv=$(count_events "$ROOM" isolation.violation frontend)
fixed=$(events_json "$ROOM" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const e=(JSON.parse(s).events||[]).filter(x=>x.type==="isolation.violation").pop();console.log(e?String(e.payload.fixed):"")})')
if [ "$(echo "$before" | tr -d '\r')" = "777" ] && [ "$after" = "750" ] && [ "$nv" = "1" ] && [ "$fixed" = "true" ]; then
  ok "[13] 777 → denetim → 750, tek isolation.violation (fixed: true)"
else
  no "[13] önce=$before sonra=$after event=$nv fixed=$fixed denetim=$audit"
fi
node scripts/lib/w7-core.mjs audit "$ROOM" >/dev/null 2>&1
[ "$(count_events "$ROOM" isolation.violation frontend)" = "1" ] && ok "[13] temiz odada ikinci denetim event yazmıyor" || no "[13] ikinci denetim yeni event yazdı"

###############################################################################
step "Arayüz (Playwright, modelsiz)  [16, 17, 19, 20]"
if [ "$RUN_UI" != "1" ]; then
  echo "  · GATE_W7_UI=0 — atlandı (geçti SAYILMAZ)"; FAIL=$((FAIL + 1))
else
  (cd apps/web && API_URL="$BASE" npx vite --port "$WEB_PORT" --strictPort >"../../$TMP/web.log" 2>&1) &
  WEB_PID=$!
  for _ in $(seq 1 60); do
    curl -s -o /dev/null --max-time 2 "http://localhost:$WEB_PORT/" && break
    sleep 0.5
  done
  (cd apps/web && E2E_BASE_URL="http://localhost:$WEB_PORT" W7_ROOM="$ROOM" W7_ROOM3="$ROOM3" \
    W7_A="$A" W7_B="$B" W7_B_NAME="$B_NAME" npx playwright test tests/week7.spec.ts --reporter=line) \
    >"$TMP/pw.log" 2>&1
  pw=$?
  passed=$(grep -oE '[0-9]+ passed' "$TMP/pw.log" | head -1)
  if [ $pw -eq 0 ]; then ok "[16,17,19,20] Playwright: $passed"
  else no "[16,17,19,20] Playwright düştü:"; tail -40 "$TMP/pw.log" | sed 's/^/      /'; fi
fi

###############################################################################
step "Temizlik  [14, 15]"

# [15] Etiketli ama DB'de karşılığı olmayan container ve volume.
ORPHAN_ID=$(node -e 'console.log(crypto.randomUUID())')
docker volume create --label agent-rooms.managed=true --label "agent-rooms.room=$ORPHAN_ID" "room-$ORPHAN_ID" >/dev/null
docker run -d --label agent-rooms.managed=true --label "agent-rooms.room=$ORPHAN_ID" \
  --name "agent-rooms-orphan-${ORPHAN_ID:0:8}" --entrypoint sleep agent-rooms/room:dev 600 >/dev/null
sweep=$(node scripts/lib/w7-core.mjs sweep 2>&1)
left_c=$(docker ps -aq --filter "label=agent-rooms.room=$ORPHAN_ID" | wc -l | tr -d ' ')
left_v=$(docker volume ls -q --filter "label=agent-rooms.room=$ORPHAN_ID" | wc -l | tr -d ' ')
[ "$left_c" = "0" ] && [ "$left_v" = "0" ] && ok "[15] sweeper sahipsiz container ve volume'u sildi" \
  || no "[15] kalan container=$left_c volume=$left_v ($sweep)"
# Canlı odalara dokunmamış olmalı.
docker ps -q --filter "name=$C" | grep -q . && ok "[15] sweeper canlı odaya dokunmadı" || no "[15] canlı oda da silindi"

# [14] DELETE.
N_BEFORE=$(events_json "$ROOM" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log((JSON.parse(s).events||[]).length))')
del=$(acurl -w '|%{http_code}' -X DELETE "$BASE/rooms/$ROOM")
bdel=$(bcurl -o /dev/null -w '%{http_code}' -X DELETE "$BASE/rooms/$ROOM3")
[ "$bdel" = "403" ] && ok "[14] member odayı silemiyor (403)" || no "[14] member DELETE → $bdel"
[ "${del##*|}" = "200" ] && ok "[14] owner DELETE → 200" || no "[14] DELETE: $del"
[ -z "$(docker ps -aq --filter "label=agent-rooms.room=$ROOM")" ] && ok "[14] container yok" || no "[14] container duruyor"
docker volume inspect "room-$ROOM" >/dev/null 2>&1 && no "[14] volume duruyor" || ok "[14] volume yok"
st=$(psql_q "SELECT status FROM rooms WHERE id='$ROOM'")
[ "$st" = "archived" ] && ok "[14] rooms.status = archived" || no "[14] status = $st"
N_AFTER=$(events_json "$ROOM" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log((JSON.parse(s).events||[]).length))')
[ "$N_AFTER" -ge "$N_BEFORE" ] && [ "$N_AFTER" -gt 0 ] && ok "[14] event'ler hâlâ okunuyor ($N_AFTER)" || no "[14] event sayısı $N_BEFORE → $N_AFTER"
[ -n "$ROOM3" ] && acurl -o /dev/null -X DELETE "$BASE/rooms/$ROOM3"

###############################################################################
if [ "$RUN_REGRESSION" = "1" ]; then
  step "Regresyon  [22]"
  kill_tree "$SERVER_PID"; SERVER_PID=""
  for g in gate gate:w3 gate:w4 gate:w5 gate:w6; do
    if npm run "$g" >"$TMP/reg-$g.log" 2>&1; then
      ok "[22] $g: $(grep -E 'kapısı: [0-9]+ geçti' "$TMP/reg-$g.log" | tail -1)"
    else
      no "[22] $g düştü"; tail -15 "$TMP/reg-$g.log" | sed 's/^/      /'
    fi
  done
else
  echo ""
  echo "  · regresyon atlandı (GATE_W7_REGRESSION=1 ile koşar, ~15 dk)"
fi
