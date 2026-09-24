#!/bin/sh
# Kullanim: measure.sh <maxAttempts|none> [auth|noauth]
MA="$1"
AUTH="${2:-auth}"
export HOME=/tmp/h
mkdir -p $HOME/.gemini /tmp/w
if [ "$MA" != "none" ]; then
  if [ "$AUTH" = "auth" ]; then
    echo '{"general":{"maxAttempts":'"$MA"'},"security":{"auth":{"selectedType":"gemini-api-key"}}}' > $HOME/.gemini/settings.json
  else
    echo '{"general":{"maxAttempts":'"$MA"'}}' > $HOME/.gemini/settings.json
  fi
  cat $HOME/.gemini/settings.json
fi
node /m/fake503.mjs > /tmp/srv.log &
sleep 1
cd /tmp/w
START=$(date +%s)
GEMINI_API_KEY=fake GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:9999 GEMINI_CLI_TRUST_WORKSPACE=true \
  timeout 400 /opt/runner/gemini/node_modules/.bin/gemini --skip-trust -o stream-json -m gemini-3.1-flash-lite -p "merhaba" \
  > /tmp/out.log 2> /tmp/err.log
echo "exit=$? sure=$(( $(date +%s) - START ))s"
echo "istek sayisi: $(grep -c REQ /tmp/srv.log)"
grep REQ /tmp/srv.log | head -3
echo "--- stderr Attempt satirlari:"
grep -oE "Attempt [0-9]+ failed[^_{]*" /tmp/err.log
echo "--- stdout:"
cut -c1-300 /tmp/out.log
echo "--- err (ilk 600):"
head -c 600 /tmp/err.log
