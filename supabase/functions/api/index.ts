// Sotyn.Headmasters API — a single Supabase Edge Function that serves the
// same /api/... contract the React client already speaks (see
// docs/SUPABASE-NATIVE-PLAN.md). Route modules are the Phase-3 Postgres
// versions of server/routes/*, ported to ESM on top of _shared/express-lite.
import { App } from "../_shared/express-lite.ts";
import { auditMiddleware } from "../_shared/audit.ts";

import authRouter from "./routes/auth.ts";
import uploadRouter from "./routes/upload.ts";
import salonServices from "./routes/salonServices.ts";
// Ported modules are registered here as they land (see routes/README).
import { extraMounts } from "./routes/_mounts.ts";

const app = new App({ prefixes: ["/functions/v1/api", "/api"] });

app.use(auditMiddleware);

app.use("/auth", authRouter);
app.use("/upload", uploadRouter);
app.use("/salon/services", salonServices);
for (const [prefix, router] of extraMounts) app.use(prefix, router);

Deno.serve((req) => app.handle(req));
