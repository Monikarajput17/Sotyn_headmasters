#!/bin/bash
# ERP Endpoint Health Check — hits every monitored API with a logged-in
# admin session and prints a pass/fail status for each. Use this whenever
# someone claims "the ERP is down" — it gives you an objective answer.
#
# Usage:
#   bash /root/erp/health-check.sh
#   ADMIN_EMAIL=admin@erp.com ADMIN_PASSWORD=YourPassword bash /root/erp/health-check.sh

set -u

BASE="${BASE_URL:-https://securederp.in}"
EMAIL="${ADMIN_EMAIL:-admin@erp.com}"
PASSWORD="${ADMIN_PASSWORD:-admin123}"

# 1. Login — gets JWT token
echo "=== Logging in as $EMAIL ==="
LOGIN_RESPONSE=$(curl -s -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")

TOKEN=$(echo "$LOGIN_RESPONSE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('token',''))" 2>/dev/null)

if [ -z "$TOKEN" ]; then
  echo "❌ LOGIN FAILED. Response: $LOGIN_RESPONSE"
  echo "Set ADMIN_EMAIL and ADMIN_PASSWORD env vars and retry."
  exit 1
fi
echo "✅ Got token (${#TOKEN} chars)"
echo ""

# 2. Hit every monitored endpoint
declare -a ENDPOINTS=(
  "GET|/api/auth/me|auth/me (session)"
  "GET|/api/dashboard|dashboard"
  "GET|/api/admin/audit?limit=5|audit log"
  "GET|/api/orders|orders"
  "GET|/api/leads|leads"
  "GET|/api/customers|customers (clients)"
  "GET|/api/business-book|business-book (projects)"
  "GET|/api/installation|installation"
  "GET|/api/complaints|complaints"
  "GET|/api/delegations|delegations"
  "GET|/api/expenses|expenses"
  "GET|/api/auth/users|users"
  "GET|/api/support|support"
)

PASS=0; FAIL=0
echo "=== Endpoint Status (admin session) ==="
printf "%-6s %-40s %s\n" "STATUS" "ENDPOINT" "LABEL"
echo "------------------------------------------------------------------------"

for entry in "${ENDPOINTS[@]}"; do
  # IMPORTANT: avoid the variable name `PATH` — bash treats it as the
  # executable search path, and overwriting it makes curl/python3
  # unfindable for the rest of the script. Use EP_PATH instead.
  IFS='|' read -r METHOD EP_PATH LABEL <<< "$entry"
  URL="$BASE$EP_PATH"

  # -w prints status code, -o discards body, -m 10 = 10s timeout
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" -m 10 \
    -X "$METHOD" \
    -H "Authorization: Bearer $TOKEN" \
    "$URL")

  if [ "$STATUS" = "200" ]; then
    printf "✅ %-3s  %-40s %s\n" "$STATUS" "$EP_PATH" "$LABEL"
    PASS=$((PASS+1))
  elif [ "$STATUS" = "403" ]; then
    # 403 means the route works but admin doesn't have permission — still healthy
    printf "🟡 %-3s  %-40s %s (perm-blocked, not crashed)\n" "$STATUS" "$EP_PATH" "$LABEL"
    PASS=$((PASS+1))
  else
    printf "❌ %-3s  %-40s %s\n" "$STATUS" "$EP_PATH" "$LABEL"
    FAIL=$((FAIL+1))
  fi
done

echo "------------------------------------------------------------------------"
TOTAL=$((PASS+FAIL))
echo ""
echo "=== RESULT: $PASS/$TOTAL passed ==="
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo "⚠️  $FAIL endpoint(s) returned non-200/403. Investigate the failures above."
  exit 2
else
  echo "✅ All $TOTAL endpoints healthy. ERP is fully operational."
fi
