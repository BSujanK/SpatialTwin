#!/usr/bin/env bash
# Prompts for the Qualcomm Cloud AI Playground API key (hidden input), saves it to
# backend/.env (gitignored, never committed) and checks it against the API.
# Run:  bash scripts/set-qualcomm-key.sh
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$REPO/backend/.env"
ENDPOINT="https://aisuite.cirrascale.com/apis/v2"

echo "=== SpatialTwin: Qualcomm Cloud AI 100 API key ==="
read -r -s -p "Paste your Cloud AI Playground API key (input is hidden), then press Enter: " KEY; echo
KEY="$(echo -n "$KEY" | tr -d '[:space:]')"
[ -z "$KEY" ] && { echo "No key entered. Nothing saved."; exit 1; }

touch "$ENV_FILE"
grep -vE '^\s*QUALCOMM_(API_KEY|ENDPOINT)\s*=' "$ENV_FILE" > "$ENV_FILE.tmp" || true
printf 'QUALCOMM_API_KEY=%s\nQUALCOMM_ENDPOINT=%s\n' "$KEY" "$ENDPOINT" >> "$ENV_FILE.tmp"
mv "$ENV_FILE.tmp" "$ENV_FILE"; chmod 600 "$ENV_FILE"
echo "Saved to backend/.env (gitignored)."
(cd "$REPO" && git check-ignore -q backend/.env) || echo "WARNING: backend/.env is NOT gitignored. Do not commit!"

echo "Checking the key against $ENDPOINT/models ..."
CODE=$(curl -s -o /tmp/qc_models.json -w '%{http_code}' -H "Authorization: Bearer $KEY" "$ENDPOINT/models" || echo 000)
if [ "$CODE" = "200" ]; then
  echo "Key works. Models:"; python3 -c "import json;d=json.load(open('/tmp/qc_models.json'));d=d.get('data',d);[print('  -',m.get('id',m) if isinstance(m,dict) else m) for m in d[:25]]" 2>/dev/null || head -c 600 /tmp/qc_models.json
else
  echo "Could not list models (HTTP $CODE). Key saved anyway; Claude-2 will confirm the endpoint path (B7)."
fi
rm -f /tmp/qc_models.json
