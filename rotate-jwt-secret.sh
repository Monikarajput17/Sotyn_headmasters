#!/bin/bash
# Rotate the ERP JWT signing secret  —  RUN ON THE VPS, IN /root/erp
# =====================================================================
# WARNING: this logs out EVERY user at once (all existing tokens become
# invalid). Run ONLY in an agreed off-hours window, AFTER mam is told.
# (mam's standing rule: auto-logout is "very bad".)
#
# Why this script and not just `export JWT_SECRET=...`:
#   getSecret() in server/middleware/auth.js reads app_settings.jwt_secret
#   from data/erp.db in PREFERENCE to the env var. So the DB row is the
#   source of truth and MUST be overwritten. We also update .env for
#   consistency, but the DB write is the one that matters.
#
# Usage:
#   cd /root/erp && bash rotate-jwt-secret.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/root/erp}"
DB="$APP_DIR/data/erp.db"
cd "$APP_DIR"

echo "==> 1) Current prod secret (confirm what is actually live):"
node -e "const D=require('better-sqlite3');const db=new D('$DB',{readonly:true});const r=db.prepare(\"SELECT value,length(value) len FROM app_settings WHERE key='jwt_secret'\").get();console.log('   value =',JSON.stringify(r&&r.value),' length =',r&&r.len);"

# Capture the OLD secret so we can prove old tokens get rejected at the end.
OLD_SECRET="$(node -e "const D=require('better-sqlite3');const db=new D('$DB',{readonly:true});const r=db.prepare(\"SELECT value FROM app_settings WHERE key='jwt_secret'\").get();process.stdout.write((r&&r.value)||'');")"

echo "==> 2) Backup DB before any write:"
BAK="$DB.bak-$(date +%Y%m%d-%H%M%S)"
cp "$DB" "$BAK"
echo "   backup -> $BAK"

echo "==> 3) Generate a strong random secret (64-char base64url, never printed):"
NEW_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")"

echo "==> 4) Overwrite app_settings.jwt_secret (the source of truth):"
node -e "const D=require('better-sqlite3');const db=new D('$DB');db.prepare(\"INSERT OR REPLACE INTO app_settings(key,value) VALUES('jwt_secret',?)\").run(process.argv[1]);const r=db.prepare(\"SELECT length(value) len FROM app_settings WHERE key='jwt_secret'\").get();console.log('   new secret length =',r.len);" "$NEW_SECRET"

echo "==> 5) Update .env for consistency (DB still wins, but keep them in sync):"
if [ -f .env ]; then cp .env ".env.bak-$(date +%Y%m%d-%H%M%S)"; fi
if grep -q '^JWT_SECRET=' .env 2>/dev/null; then
  # portable in-place edit
  tmp="$(mktemp)"; sed "s|^JWT_SECRET=.*|JWT_SECRET=$NEW_SECRET|" .env > "$tmp" && mv "$tmp" .env
else
  printf 'JWT_SECRET=%s\n' "$NEW_SECRET" >> .env
fi
echo "   .env JWT_SECRET updated"

echo "==> 6) Restart the app so it loads the new secret:"
pm2 restart erp
sleep 3

echo "==> 7a) VERIFY fresh login works (expect HTTP 200 + a token):"
echo "    (set ERP_LOGIN_USER / ERP_LOGIN_PASS env vars before running to use real creds)"
LOGIN_USER="${ERP_LOGIN_USER:-admin@erp.com}"
LOGIN_PASS="${ERP_LOGIN_PASS:-admin123}"
curl -s -o /tmp/login.json -w "   login HTTP=%{http_code}\n" \
  -X POST http://localhost:5000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$LOGIN_USER\",\"password\":\"$LOGIN_PASS\"}"
node -e "try{const t=require('/tmp/login.json').token;console.log('   got token:',t?('yes ('+t.length+' chars)'):'NO');}catch(e){console.log('   could not parse login response');}"

echo "==> 7b) VERIFY an OLD-secret token is now REJECTED (expect HTTP 401):"
OLD_TOKEN="$(node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({id:1,email:'x',role:'admin',name:'x'},process.argv[1],{expiresIn:'7d'}))" "$OLD_SECRET")"
curl -s -o /dev/null -w "   /auth/me with OLD token HTTP=%{http_code}  (must be 401)\n" \
  http://localhost:5000/api/auth/me -H "Authorization: Bearer $OLD_TOKEN"

echo ""
echo "==> DONE. If login=200 and old-token=401, rotation succeeded."
echo "    Tell mam the one-time logout is complete; users just log back in once."
echo "    Keep the DB backup ($BAK) until verified stable."
