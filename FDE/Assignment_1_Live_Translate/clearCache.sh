#!/usr/bin/env bash
#
# clearCache.sh - wipe the translation cache so the next translate is a fresh miss.
#
# Clears BOTH tiers: the in-memory dict and the SQLite file (incl. its WAL sidecars).
# A restart alone won't do it - SQLite persists on disk (a Fly volume in the cloud),
# so this deletes the file and then restarts so the empty table is recreated.
#
# Usage:
#   ./clearCache.sh            # clear the DEPLOYED cache on Fly (default) - what the demo uses
#   ./clearCache.sh --local    # clear the LOCAL cache and restart uvicorn on :8000
#   ./clearCache.sh --help
#
set -euo pipefail

# --- config (edit if you rename the apps) ----------------------------------
AI_APP="naveed-lt-ai"
GATEWAY_URL="https://naveed-lt-gw.fly.dev"
AI_LOCAL_URL="http://127.0.0.1:8000"
DB_FILES="/data/translations.db /data/translations.db-wal /data/translations.db-shm"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AI_DIR="$SCRIPT_DIR/backend/ai-service-python"

cache_size() { # $1 = health url, $2 = json path (aiService.cacheSize | cacheSize)
  curl -s --max-time 20 "$1" 2>/dev/null | python3 -c "import sys,json;d=json.load(sys.stdin);print($2)" 2>/dev/null || echo "?"
}

clear_deployed() {
  command -v flyctl >/dev/null 2>&1 || { echo "ERROR: flyctl not installed."; exit 1; }
  flyctl auth whoami >/dev/null 2>&1 || { echo "ERROR: not logged in to Fly. Run: fly auth login"; exit 1; }

  echo "Target: DEPLOYED (fly.io)  gateway=$GATEWAY_URL  ai-app=$AI_APP"
  echo "Cache before: $(cache_size "$GATEWAY_URL/health" 'd["aiService"]["cacheSize"]') entries"

  echo "1/3  deleting SQLite files on the volume ($AI_APP)…"
  flyctl ssh console -a "$AI_APP" -C "rm -f $DB_FILES"

  echo "2/3  finding the machine and restarting (clears memory + recreates empty table)…"
  local mid
  mid="$(flyctl machines list -a "$AI_APP" --json 2>/dev/null | python3 -c "import sys,json;m=json.load(sys.stdin);print(m[0]['id'])")"
  flyctl machine restart "$mid" -a "$AI_APP"

  echo "3/3  verifying…"
  local n
  for _ in 1 2 3 4 5 6; do
    sleep 3
    n="$(cache_size "$GATEWAY_URL/health" 'd["aiService"]["cacheSize"]')"
    [ "$n" = "0" ] && break
  done
  if [ "$n" = "0" ]; then
    echo "✅ Deployed cache cleared - cacheSize = 0. Ready to re-record."
  else
    echo "⚠️  cacheSize = $n (expected 0). Give it a few seconds and re-check: curl -s $GATEWAY_URL/health"
  fi
}

clear_local() {
  echo "Target: LOCAL  gateway=http://localhost:8787  ai=$AI_LOCAL_URL"
  echo "Cache before: $(cache_size "$AI_LOCAL_URL/health" 'd["cacheSize"]') entries"

  echo "1/3  stopping the local AI service on :8000…"
  lsof -tiTCP:8000 -sTCP:LISTEN | xargs -r kill 2>/dev/null || true
  sleep 1.5

  echo "2/3  deleting the local SQLite files…"
  rm -f "$AI_DIR"/translations.db "$AI_DIR"/translations.db-wal "$AI_DIR"/translations.db-shm

  echo "3/3  restarting uvicorn…"
  ( cd "$AI_DIR" && nohup .venv/bin/uvicorn app:app --port 8000 > uvicorn.out 2>&1 & )
  local n
  for _ in 1 2 3 4 5; do
    sleep 2
    n="$(cache_size "$AI_LOCAL_URL/health" 'd["cacheSize"]')"
    [ "$n" = "0" ] && break
  done
  if [ "$n" = "0" ]; then
    echo "✅ Local cache cleared - cacheSize = 0, uvicorn back up on :8000."
  else
    echo "⚠️  Local AI didn't report cacheSize=0 (got '$n'). Check $AI_DIR/uvicorn.out"
  fi
}

case "${1:-}" in
  --local) clear_local ;;
  --help|-h)
    grep '^#' "$0" | sed 's/^# \{0,1\}//' | sed -n '2,12p' ;;
  ""|--deployed) clear_deployed ;;
  *) echo "Unknown option: $1  (use --help)"; exit 1 ;;
esac
