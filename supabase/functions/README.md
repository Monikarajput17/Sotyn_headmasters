# Headmasters API — Supabase Edge Function

One function (`api`) serves the whole `/api/...` contract the React client uses.
Design + scope: `docs/SUPABASE-NATIVE-PLAN.md`. Chat realtime contract:
`api/routes/CHAT-REALTIME.md`.

## Run locally (no Docker needed)
```bash
npx deno run --allow-all --env-file=supabase/functions/.env --config supabase/functions/api/deno.json supabase/functions/api/index.ts
```
Listens on http://127.0.0.1:8000 — the Vite dev proxy (`client/vite.config.js`)
forwards `/api` there. `supabase/functions/.env` (git-ignored) needs
`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DB_POOL_URL`.

## Type-check
```bash
npx deno check --config supabase/functions/api/deno.json supabase/functions/api/index.ts
```

## Deploy (one time: link; every time: deploy)
```bash
set SUPABASE_ACCESS_TOKEN=<personal access token>
npx supabase link --project-ref kxwejphtauqjxsruojwo
npx supabase secrets set DB_POOL_URL="postgresql://postgres.kxwejphtauqjxsruojwo:<url-encoded password>@aws-0-ap-south-1.pooler.supabase.com:6543/postgres"
npx supabase functions deploy api --no-verify-jwt
```
`--no-verify-jwt` is required: the function does its own auth (Supabase Auth
tokens are verified inside `_shared/auth.ts`), and the public booking + login
endpoints must be reachable without a token. `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` are injected automatically in
production.

Live base URL: `https://kxwejphtauqjxsruojwo.supabase.co/functions/v1/api`

## Users → Supabase Auth (one time)
```bash
node scripts/import-users-to-supabase-auth.js
```
Imports every `users` row's bcrypt hash into Supabase Auth (passwords
unchanged) and links `users.auth_user_id`. Any user missed is migrated
lazily on their first successful login.

## Frontend build for hosting (Cloudflare Pages / Vercel)
```bash
cd client && cp .env.production.example .env.production   # fill in anon key
npm run build   # → client/dist (static)
```
