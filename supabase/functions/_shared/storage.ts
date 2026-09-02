// File uploads → Supabase Storage bucket `uploads` (public-read, mirroring the
// old /uploads/* static folder). Returns the public URL the UI stores.
import { adminClient } from "./auth.ts";
import type { UploadedFile } from "./express-lite.ts";

const BUCKET = "uploads";

export async function storeUpload(file: UploadedFile, folder = ""): Promise<{ url: string; path: string }> {
  const safe = file.originalname.replace(/[^a-zA-Z0-9.-]/g, "_");
  const path = `${folder ? folder.replace(/\/$/, "") + "/" : ""}${Date.now()}-${safe}`;
  const { error } = await adminClient().storage.from(BUCKET).upload(path, file.buffer, { contentType: file.mimetype, upsert: false });
  if (error) throw new Error(`upload failed: ${error.message}`);
  const { data } = adminClient().storage.from(BUCKET).getPublicUrl(path);
  return { url: data.publicUrl, path };
}
