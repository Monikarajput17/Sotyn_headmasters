// Business Book — stub. The salon has no projects; the Delegations page still
// calls GET /business-book to populate its project picker, so answer with an
// empty list instead of a 404.
import { Router } from "../../_shared/express-lite.ts";
import { authMiddleware } from "../../_shared/auth.ts";
const router = Router();
router.use(authMiddleware);

router.get("/", (_req, res) => {
  res.json([]);
});

export default router;
