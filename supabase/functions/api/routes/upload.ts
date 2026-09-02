// POST /api/upload — multipart file → Supabase Storage `uploads` bucket.
// Response shape kept identical to the old multer handler: { url, filename }.
import { Router } from "../../_shared/express-lite.ts";
import { authMiddleware } from "../../_shared/auth.ts";
import { storeUpload } from "../../_shared/storage.ts";
const router = Router();

router.post("/", authMiddleware, async (req, res) => {
  try {
    const f = req.file || (req.files && req.files[0]);
    if (!f) return res.status(400).json({ error: "No file uploaded" });
    if (f.size > 20 * 1024 * 1024) return res.status(413).json({ error: "File too large (max 20 MB)" });
    const { url, path } = await storeUpload(f);
    res.json({ url, filename: path, originalName: f.originalname, size: f.size, mimetype: f.mimetype });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

export default router;
