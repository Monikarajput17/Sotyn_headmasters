# Isolated local testing

Local development runs the React frontend and the same Supabase Edge Function
backend used by production, with a separate database, Auth users and uploads.
The generated local stack lives in ignored `.local/`; it is never linked to a
hosted Supabase project. No production data or credentials are copied.

## First setup

Install Docker Desktop with WSL 2, restart Windows if requested, and start Docker
Desktop using Linux containers. Then, in PowerShell at the repository root:

```powershell
npm.cmd ci
npm.cmd ci --prefix client
npm.cmd run local:start
npm.cmd run dev
```

The first backend start downloads Supabase containers and initializes the local
database. Keep the frontend terminal open. Subsequent starts retain local test
data. `local:start` verifies the API and test login before reporting success.

- App: http://127.0.0.1:3055
- Local database UI (Supabase Studio): http://127.0.0.1:54323
- Local API: http://127.0.0.1:54321/functions/v1/api
- Local authentication email inbox: http://127.0.0.1:54324
- Test username: `local-admin`
- Test password: `LocalTest123!`

The test fixtures contain `LOCAL TEST SALON`, a sample service, stylist and
client. These credentials are only for the isolated local stack. The backend
creates the matching local Supabase Auth account on first successful login.

## Everyday commands

```powershell
npm.cmd run local:start   # Start/verify the local backend; retain test data
npm.cmd run dev           # Start the frontend after the backend is ready
npm.cmd run local:check   # Check local API, login and main salon endpoints
npm.cmd run local:status  # Show local addresses without displaying secret keys
npm.cmd run local:stop    # Stop the local backend; retain its data
```

For automatic checklist occurrences and ticket escalation checks while developing,
run `node scripts/workflows/local-scheduler.cjs` in a separate terminal (or use
`--once` for one run). It validates the isolated database marker and contacts only
loopback services. Close that process when ending the local session. Work settings
also exposes a permission-checked manual run and the latest job receipts.

The local Edge Runtime uses the development `oneshot` policy. The API loads route
modules on demand to keep cold workers small. After changing the API entrypoint,
restart the local Edge Runtime container before validating the change.

`local:prepare` generates the initial local schema and fixtures without Docker.
It reads schema code into an in-memory SQLite database, not `data/erp.db`.
The converter preserves primary/unique keys, defaults, enum checks, valid
foreign keys and indexes. References to missing legacy tables are documented
and omitted in the generated local baseline. Chat schema and existing Realtime
migrations are included. The local baseline is NOT a production migration.

The frontend development configuration refuses remote API, proxy and Realtime
endpoints. Local startup discards inherited database credentials. The backend
local flag checks that its Auth and database endpoints are local, disables TLS
only for that local database, and returns browser-accessible local upload URLs.
Do not put real SMTP, SMS, payment, AI or other external-service credentials in
the test database. Test fixture setup does not configure these integrations.

## Production deployment

Attendance permissions are shared through roles. Assign roles to logins in Users;
team and branch relationships only determine which records a role's scope covers.
The local role list hides generated attendance regression roles marked with both
the `af` timestamp prefix and the exact description `Synthetic fixture`. They are
retained with their assignments for regression testing. Authorized local diagnostics
can retrieve them with `GET /auth/roles?include_test=1`. Production role lists are
unfiltered.

Production settings remain separate in `client/.env.production` and the hosted
Supabase project's secrets. `LOCAL_DEVELOPMENT` must remain unset in production.
The normal production backend continues to require database TLS.

For an authorized deployment, build the frontend with production settings and
deploy the resulting `client/dist` to its existing host. Deploy the Edge Function
from the repository root to the existing hosted Supabase project. Do not deploy
from `.local/`, link `.local/` to any remote project, or upload local environment
files, fixtures or test records.

Database structure changes belong in reviewed, incremental SQL migrations under
`supabase/migrations/`. `local:start` copies and applies those migrations locally;
production migration application is a separate deployment step. Existing live
records remain in production when application code is deployed.

## Windows startup issues

If Docker reports that its engine is unavailable after installation, save your
work and restart Windows, then open Docker Desktop and wait until its engine is
running. This project does not restart Windows automatically. Use `npm.cmd` in
PowerShell if your execution policy blocks `npm.ps1`.
