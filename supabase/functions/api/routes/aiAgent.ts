// deno-lint-ignore-file no-explicit-any
// AI Agent — settings slice only (port of server/routes/aiAgent.js):
//   GET/PUT /settings        admin: paste the Anthropic API key inside the ERP
//   GET/PUT /email-settings  admin: SMTP credentials in app_settings
//   POST    /email-test      admin: send a test email through lib/email
//   GET     /status          ai_agent.view: is the chatbot configured?
// /ask (the chatbot), /rate-suggestion and /item-history are NOT ported here.
import { Router } from "../../_shared/express-lite.ts";
import type { Handler } from "../../_shared/express-lite.ts";
import pg from "../../_shared/pg.ts";
import { authMiddleware, requirePermission } from "../../_shared/auth.ts";
import { sendEmail } from "../../_shared/lib/email.ts";
const router = Router();
router.use(authMiddleware);

// Read/write helpers for the key-value app_settings table. Keys we own:
//   ai_provider  — 'anthropic' (only one for now)
//   ai_api_key   — the secret (server-side only; masked in GET)
//   ai_model     — model id (default claude-opus-4-7)
async function getSetting(key: string): Promise<string | null> {
  const row = await pg.get("SELECT value FROM app_settings WHERE key=?", key);
  return row?.value ?? null;
}
async function setSetting(key: string, value: string) {
  await pg.run(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
                   ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`, key, value);
}
// Local admin gate kept so the 'Admin only' response text is unchanged.
const adminOnly: Handler = (req, res, next) => {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Admin only" });
  next();
};

// ─── AI Settings (admin) ─────────────────────────────────────────────
// Mam pastes her Anthropic API key here, no SSH/.env editing needed.
// GET returns a masked key so the UI can show "configured / not configured"
// without ever sending the secret back to the browser.

router.get("/settings", adminOnly, async (_req, res) => {
  try {
    const key = await getSetting("ai_api_key");
    res.json({
      provider: (await getSetting("ai_provider")) || "anthropic",
      model: (await getSetting("ai_model")) || "claude-opus-4-7",
      api_key_set: !!key,
      api_key_masked: key ? `${key.slice(0, 7)}…${key.slice(-4)}` : null,
    });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

router.put("/settings", adminOnly, async (req, res) => {
  try {
    const { provider, model, api_key } = req.body || {};
    if (provider) await setSetting("ai_provider", String(provider).trim() || "anthropic");
    if (model) await setSetting("ai_model", String(model).trim() || "claude-opus-4-7");
    if (typeof api_key === "string" && api_key.trim()) {
      // Accept both bare keys and "sk-ant-..."; just trim and store.
      await setSetting("ai_api_key", api_key.trim());
    }
    res.json({ message: "AI settings saved" });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// Email (SMTP) settings — also lives in app_settings. Admin-only;
// password is never echoed back. Separate from the AI Agent settings
// so the UI can show two clear panels even though both go through this
// router. Recipient defaults to director@securedengineers.com (mam's
// loss-streak alert target).
router.get("/email-settings", adminOnly, async (_req, res) => {
  try {
    const host = await getSetting("email_smtp_host");
    const user = await getSetting("email_smtp_user");
    const pass = await getSetting("email_smtp_pass");
    res.json({
      host: host || "",
      port: (await getSetting("email_smtp_port")) || "587",
      secure: (await getSetting("email_smtp_secure")) === "1",
      user: user || "",
      from: (await getSetting("email_from")) || "",
      director_to: (await getSetting("email_director_to")) || "director@securedengineers.com",
      pass_set: !!pass,
      pass_masked: pass ? `${"•".repeat(8)}${pass.slice(-2)}` : null,
    });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

router.put("/email-settings", adminOnly, async (req, res) => {
  try {
    const b = req.body || {};
    if (b.host !== undefined) await setSetting("email_smtp_host", String(b.host).trim());
    if (b.port !== undefined) await setSetting("email_smtp_port", String(b.port).trim() || "587");
    if (b.secure !== undefined) await setSetting("email_smtp_secure", b.secure ? "1" : "0");
    if (b.user !== undefined) await setSetting("email_smtp_user", String(b.user).trim());
    if (typeof b.pass === "string" && b.pass.trim()) await setSetting("email_smtp_pass", b.pass.trim());
    if (b.from !== undefined) await setSetting("email_from", String(b.from).trim());
    if (b.director_to !== undefined) await setSetting("email_director_to", String(b.director_to).trim());
    res.json({ message: "Email settings saved" });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// Send a test email to confirm SMTP works.
router.post("/email-test", adminOnly, async (req, res) => {
  const to = String(req.body?.to || "").trim() || (await getSetting("email_director_to").catch(() => null)) || "director@securedengineers.com";
  try {
    const r = await sendEmail({
      to,
      subject: "[SEPL ERP] Test email",
      html: "<p>This is a test email from SEPL ERP. SMTP is configured correctly.</p>",
      text: "This is a test email from SEPL ERP. SMTP is configured correctly.",
    });
    if (r?.skipped) return res.status(400).json({ error: `Not configured: ${r.reason}` });
    res.json({ message: `Test email sent to ${to}`, messageId: r?.messageId });
  } catch (e) {
    res.status(502).json({ error: `Send failed: ${(e as Error).message}` });
  }
});

// Lets users with ai_agent.view check if the chatbot is configured so
// the floating bubble can render only for permitted users.
router.get("/status", requirePermission("ai_agent", "view"), async (_req, res) => {
  try {
    res.json({ configured: !!(await getSetting("ai_api_key")) });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

export default router;
