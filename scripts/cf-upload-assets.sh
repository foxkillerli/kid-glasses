#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
ACCOUNT_ID="${CF_ACCOUNT_ID:?set CF_ACCOUNT_ID}"
JWT_FILE="${1:?usage: $0 <file holding the upload-session jwt> <hash>=<path>...}"
shift
URL="https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/assets/upload?base64=true"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

for pair in "$@"; do
  hash="${pair%%=*}"
  path="${pair#*=}"
  case "$path" in
    *.html) type=text/html ;;
    *.js) type=application/javascript ;;
    *.css) type=text/css ;;
    *.png) type=image/png ;;
    *) type=application/octet-stream ;;
  esac
  base64 -w0 "$path" > "$WORK/$hash.b64"
  curl -s -X POST "$URL" -H "Authorization: Bearer $(cat "$JWT_FILE")" -F "${hash}=<$WORK/$hash.b64;type=${type}" |
    python3 -c 'import sys, json
d = json.load(sys.stdin)
r = d.get("result") or {}
print("ok" if d.get("success") else "FAIL", sys.argv[1], d.get("errors"), "completion_jwt=" + r["jwt"] if r.get("jwt") else "")' "$path"
done
