#!/bin/sh
# Gercek runner'i sahte 503 sunucusuna karsi surer. Model istegi YOK (--network none).
# Not: GOOGLE_GEMINI_BASE_URL auth tipini "gateway" yapiyor; gercek odadaki gibi
# gemini-api-key olsun diye olcum ortamina settings.json yaziliyor (urunde yok).
export HOME=/tmp/h
mkdir -p $HOME/.gemini /tmp/w /room/contracts /room/worktrees/frontend
echo '{"security":{"auth":{"selectedType":"gemini-api-key"}}}' > $HOME/.gemini/settings.json
node /m/fake503.mjs > /tmp/srv.log &
sleep 1
cd /tmp/w
START=$(date +%s)
( echo '{"kind":"run","messageId":"44444444-4444-4444-8444-444444444444","text":"merhaba"}'; sleep 300 ) | \
  ROOM_ID=11111111-1111-4111-8111-111111111111 \
  SESSION_ID=22222222-2222-4222-8222-222222222222 \
  ROOM_AGENT_CONFIG='{"name":"frontend","systemPrompt":"olcum","runtime":"gemini","model":"gemini-3.5-flash","workspace":"worktrees/frontend","toolsAllow":["read","edit"],"writable":["worktrees/frontend","contracts"]}' \
  AGENT_RETRY_BUDGET="${1:-3}" GEMINI_API_KEY=fake GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:9999 \
  timeout 300 node /opt/runner/gemini/dist/runner.js > /tmp/runner.out 2> /tmp/runner.err &
RPID=$!
# turn_end gelene kadar bekle
i=0
while [ $i -lt 290 ]; do
  grep -q '"kind":"turn_end"' /tmp/runner.out 2>/dev/null && break
  kill -0 $RPID 2>/dev/null || { echo "runner oldu (turn_end yok)"; break; }
  sleep 1; i=$((i+1))
done
echo "turn_end: $(( $(date +%s) - START )) sn sonra"
sleep 6
echo "sahte sunucuya giden istek: $(grep -c REQ /tmp/srv.log)"
echo "--- runner protokol ciktisi (heartbeat/log haric):"
grep -v '"kind":"heartbeat"' /tmp/runner.out | grep -v '"kind":"log"' | cut -c1-330
echo "--- gemini sureci hala yasiyor mu:"
n=0
for p in /proc/[0-9]*; do
  if tr '\0' ' ' < $p/cmdline 2>/dev/null | grep -q "bin/gemini"; then n=$((n+1)); fi
done
echo "canli gemini sureci: $n"
kill $RPID 2>/dev/null
echo "--- runner stderr (son 15 satir):"
tail -15 /tmp/runner.err
