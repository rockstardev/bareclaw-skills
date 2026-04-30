#!/usr/bin/env bash
set -euo pipefail

CREDS="$(dirname "$(readlink -f "$0")")/.credentials"

OWNER_ID=$(python3 -c "import json; print(json.load(open('$CREDS'))['owner_id'])")

CHANNEL_NAME="${CHANNEL_NAME:-telegram-channel}"
CHANNEL_LINE=$(ps -ef | grep -E "channel\.ts.*--name ${CHANNEL_NAME}" | grep -v grep || true)
if [[ -z "$CHANNEL_LINE" ]]; then
  echo "FAIL: ${CHANNEL_NAME} is not running (set CHANNEL_NAME env if your channel uses a different --name)"
  exit 3
fi
CREATOR_ID=$(echo "$CHANNEL_LINE" | grep -oE -- '--creator-id [0-9]+' | awk '{print $2}' | head -1)

SELF_ID=$(python3 -c "import json; d=json.load(open('$CREDS')); print(d.get('self_id',''))")

if [[ "$OWNER_ID" != "$CREATOR_ID" ]]; then
  echo "FAIL: .credentials.owner_id=$OWNER_ID != channel --creator-id=$CREATOR_ID"
  exit 1
fi

if [[ -n "$SELF_ID" && "$OWNER_ID" == "$SELF_ID" ]]; then
  echo "FAIL: owner_id=$OWNER_ID equals self_id=$SELF_ID (owner_id must be CREATOR, not self)"
  exit 1
fi

HEALTH=$(curl -s localhost:15228/health || echo '{}')
CONNECTED=$(echo "$HEALTH" | python3 -c "import sys,json
try: print(json.loads(sys.stdin.read()).get('connected', False))
except Exception: print(False)")

echo "OK owner_id=$OWNER_ID creator_id=$CREATOR_ID self_id=${SELF_ID:-unset} relay_connected=$CONNECTED"
