#!/usr/bin/env bash
#
# tunnel.sh - route localhost:8787 to the DEPLOYED fly.io gateway (on/off).
#
# Why this exists (say this out loud in the demo - it's not a trick):
#   The PROVIDED browser extension always calls http://localhost:8787. It reads
#   your saved backend URL from chrome.storage asynchronously, but the widget
#   reads its config synchronously a moment earlier, so it loses the race and
#   falls back to the localhost default. We're not allowed to edit the extension.
#   This tunnel forwards that local port straight to the real deployed gateway
#   (naveed-lt-gw.fly.dev), so every request the widget makes actually executes
#   on fly.io - gateway, AI service, and cache. Nothing is faked; you can prove
#   it by watching the fly.io cache fill (see PROVE below).
#
# Usage:
#   ./tunnel.sh on       # start:  localhost:8787 -> fly.io gateway
#   ./tunnel.sh off      # stop
#   ./tunnel.sh status   # is it up? what does localhost:8787 resolve to?
#
# PROVE it's fly.io (run while translating):
#   curl -s https://naveed-lt-gw.fly.dev/health | python3 -c \
#     "import sys,json;print(json.load(sys.stdin)['aiService']['cacheSize'])"
#
set -euo pipefail

APP="naveed-lt-gw"
LOCAL_PORT=8787
REMOTE_PORT=8787
PUBLIC_URL="https://naveed-lt-gw.fly.dev"
PIDFILE="/tmp/fde-flyproxy.pid"
LOGFILE="/tmp/fde-flyproxy.log"

is_running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

port_holder() { lsof -iTCP:$LOCAL_PORT -sTCP:LISTEN -n -P 2>/dev/null | tail -n +2; }

start() {
  # clear any previous tunnel (tracked or stray) so we start clean
  pkill -f "proxy ${LOCAL_PORT}:${REMOTE_PORT}" 2>/dev/null || true
  rm -f "$PIDFILE"
  sleep 1

  if lsof -tiTCP:$LOCAL_PORT -sTCP:LISTEN >/dev/null 2>&1; then
    echo "✗ Port $LOCAL_PORT is held by a NON-tunnel process (a local gateway?). Stop it first:"
    port_holder
    exit 1
  fi

  echo "Starting tunnel: localhost:$LOCAL_PORT  ->  $APP:$REMOTE_PORT (fly.io) …"
  nohup flyctl proxy ${LOCAL_PORT}:${REMOTE_PORT} -a "$APP" > "$LOGFILE" 2>&1 &
  echo $! > "$PIDFILE"

  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    if curl -sf --max-time 5 "http://localhost:$LOCAL_PORT/health" >/dev/null 2>&1; then
      echo "✅ Tunnel UP. The widget's localhost:$LOCAL_PORT now runs on fly.io."
      status
      return
    fi
  done
  echo "⚠️  Tunnel didn't answer in time. Check $LOGFILE"
  exit 1
}

stop() {
  pkill -f "proxy ${LOCAL_PORT}:${REMOTE_PORT}" 2>/dev/null && echo "Tunnel stopped." || echo "Tunnel was not running."
  rm -f "$PIDFILE"
}

status() {
  if is_running; then echo "state: RUNNING (pid $(cat "$PIDFILE"))"; else echo "state: stopped"; fi
  local body
  body="$(curl -s --max-time 6 "http://localhost:$LOCAL_PORT/health" 2>/dev/null || true)"
  if [ -n "$body" ]; then
    echo "localhost:$LOCAL_PORT -> $(echo "$body" | python3 -c "import sys,json;d=json.load(sys.stdin);print('fly.io gateway OK, aiService cacheSize =', d['aiService']['cacheSize'])" 2>/dev/null || echo "answering: $body")"
  else
    echo "localhost:$LOCAL_PORT -> not answering (tunnel down)"
  fi
}

case "${1:-status}" in
  on|start)   start ;;
  off|stop)   stop ;;
  status)     status ;;
  *) echo "usage: $0 {on|off|status}"; exit 1 ;;
esac
