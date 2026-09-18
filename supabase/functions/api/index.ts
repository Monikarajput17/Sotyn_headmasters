// Sotyn.Headmasters API — a single Supabase Edge Function that serves the
// same /api/... contract the React client already speaks (see
// docs/SUPABASE-NATIVE-PLAN.md). Route modules are the Phase-3 Postgres
// versions of server/routes/*, ported to ESM on top of _shared/express-lite.
import { App } from "../_shared/express-lite.ts";
import { auditMiddleware } from "../_shared/audit.ts";

import { lazyMounts } from "./routes/lazy-mounts.ts";

const app = new App({ prefixes: ["/functions/v1/api", "/api"] });

app.use(auditMiddleware);

for (const [prefix, router] of lazyMounts) app.use(prefix, router);

Deno.serve((req) => app.handle(req));
