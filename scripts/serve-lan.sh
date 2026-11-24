#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
PORT="${PORT:-5173}"
LAN_IP="${LAN_IP:-$(ip -4 route get 1.1.1.1 | awk '{for (i = 1; i <= NF; i++) if ($i == "src") print $(i + 1)}')}"
mkdir -p .dev

if [ -f .dev/server.pid ] && kill -0 "$(cat .dev/server.pid)" 2>/dev/null; then
  echo "server already running pid=$(cat .dev/server.pid)"
else
  npm run build > .dev/build.log 2>&1
  setsid nohup npx vite preview --host 0.0.0.0 --port "$PORT" --strictPort > .dev/server.log 2>&1 < /dev/null &
  echo $! > .dev/server.pid
  sleep 2
fi

URL="http://${LAN_IP}:${PORT}"
echo "$URL" > .dev/url.txt
npx evenhub qr --url "$URL" > .dev/sideload-qr.txt 2>&1
qrencode -o .dev/sideload-qr.png -s 10 -m 4 "$URL"
echo "pid=$(cat .dev/server.pid) url=$URL"
echo "qr png: .dev/sideload-qr.png  ascii: .dev/sideload-qr.txt  log: .dev/server.log"
