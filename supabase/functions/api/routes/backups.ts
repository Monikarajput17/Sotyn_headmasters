// Backups — stub for the Supabase deployment. The old server/routes/backups.js
// ran sqlite/pg dumps on the VPS; on Supabase, database backups are managed
// by the platform (Dashboard → Database → Backups). A nightly export job to
// Storage is scheduled separately. Response shape keeps the admin page happy.
import { Router } from "../../_shared/express-lite.ts";
import { adminOnly, authMiddleware } from "../../_shared/auth.ts";
const router = Router();
router.use(authMiddleware);
router.use(adminOnly);

router.get("/", (_req, res) => {
  res.json({
    backups: [],
    managed: true,
    note: "Backups are managed by Supabase (Database → Backups). Nightly export job to Storage is scheduled separately.",
  });
});

router.post("/run", (_req, res) => {
  res.status(200).json({ message: "Managed by Supabase — nothing to run" });
});

export default router;
