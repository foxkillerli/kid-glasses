#!/usr/bin/env bash
set -euo pipefail

PORT="${SIM_PORT:-9898}"
BASE="http://127.0.0.1:${PORT}"
OUT_DIR="${SHOT_DIR:-docs/screenshots}"

api() { curl -s --noproxy '*' "$@"; }

case "${1:-}" in
  ping) api "$BASE/api/ping"; echo ;;
  input)
    shift
    for action in "$@"; do
      api -X POST -H 'Content-Type: application/json' -d "{\"action\":\"${action}\"}" "$BASE/api/input"; echo
      sleep "${INPUT_GAP:-0.6}"
    done
    ;;
  shot)
    name="$2"
    mkdir -p "$OUT_DIR"
    raw="$(mktemp --suffix=.png)"
    api "$BASE/api/screenshot/glasses" -o "$raw"
    magick "$raw" -background black -alpha remove -alpha off "$OUT_DIR/$name.png"
    rm -f "$raw"
    echo "$OUT_DIR/$name.png"
    ;;
  console)
    api "$BASE/api/console${2:+?since_id=$2}" | python3 -c 'import sys,json
for e in json.load(sys.stdin)["entries"]: print(e["id"], e["level"], e["message"][:240])'
    ;;
  *)
    echo "usage: $0 ping | input <action>... | shot <name> | console [since_id]" >&2
    exit 1
    ;;
esac
