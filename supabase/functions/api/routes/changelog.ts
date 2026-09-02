// deno-lint-ignore-file no-explicit-any
// "What's new in the ERP" — admin-only changelog reader for the
// Daily Activity page. Returns the list of git commits for a given
// date / date range so MD can see what new systems / features /
// fixes shipped each day.
// Ported from server/routes/changelog.js.
//
// Source of truth = git log on the deployed repo. No manual upkeep
// required — every feature ships with a commit, the commit shows up
// here automatically the next time mam opens this page.
//
// EDGE FUNCTION NOTE: the Express server ran `git log` via child_process on
// the VPS checkout. A Supabase Edge Function has no repo checkout and no
// subprocess permission, so the git call below fails and we take the SAME
// graceful path the original already had for a git-less host: an empty
// commit list plus `note: 'git log unavailable on this host'` so the page
// still renders. (Running the function locally with `deno` inside the repo
// still produces real commits.)
import { Router } from "../../_shared/express-lite.ts";
import { adminOnly, authMiddleware } from "../../_shared/auth.ts";

const router = Router();
router.use(authMiddleware);
router.use(adminOnly);

function categorise(subject: string) {
  const s = (subject || "").toLowerCase();
  if (/^(feat|new|add)/.test(s) || /\b(module|system|page)\b/.test(s) || /(create|build).*(system|module|page|dashboard)/.test(s)) {
    return { type: "new", emoji: "🆕", label: "New Feature" };
  }
  if (/^fix/.test(s) || /\b(bug|broken|error|crash|fail)\b/.test(s)) {
    return { type: "fix", emoji: "🛠️", label: "Fix" };
  }
  if (/^(refactor|cleanup|polish|tweak|improve|update|upgrade|enhance)/.test(s)) {
    return { type: "tweak", emoji: "🔧", label: "Improvement" };
  }
  if (/^(doc|docs|readme)/.test(s)) {
    return { type: "doc", emoji: "📝", label: "Docs" };
  }
  return { type: "other", emoji: "✨", label: "Update" };
}

// Best-effort `git log`. Returns null when git / a repo / subprocess
// permission is unavailable (the Edge Function case).
async function gitLog(since: string, until: string, fmt: string): Promise<string | null> {
  try {
    const cmd = new Deno.Command("git", {
      args: ["log", `--since=${since}`, `--until=${until}`, `--pretty=format:${fmt}`, "--no-merges"],
      stdout: "piped", stderr: "piped",
    });
    const out = await cmd.output();
    if (!out.success) return null;
    return new TextDecoder().decode(out.stdout);
  } catch { return null; }
}

router.get("/", async (req, res) => {
  const date = req.query.date;
  const dateTo = req.query.date_to;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "date=YYYY-MM-DD required" });
  }
  const since = `${date} 00:00:00`;
  const until = `${(dateTo && /^\d{4}-\d{2}-\d{2}$/.test(dateTo)) ? dateTo : date} 23:59:59`;

  // %H = full hash · %aI = author ISO date · %an = author name · %s = subject · %b = body
  // \x1f = unit separator inside a record · \x1e = record separator
  const fmt = "%H%x1f%aI%x1f%an%x1f%s%x1f%b%x1e";
  const stdout = await gitLog(since, until, fmt);
  if (stdout == null) {
    // git missing or not a repo on this host — return empty list,
    // not an error, so the page still renders.
    return res.json({ since: date, until: dateTo || date, commits: [], note: "git log unavailable on this host" });
  }
  const records = stdout.split("\x1e").map((r) => r.trim()).filter(Boolean);
  const commits = records.map((r) => {
    const [hash, iso, author, subject, body] = r.split("\x1f");
    const cat = categorise(subject);
    const cleanBody = (body || "")
      .split("\n")
      .filter((line) => !/^Co-Authored-By:/i.test(line) && !/Generated with \[Claude/i.test(line))
      .join("\n")
      .trim();
    return {
      hash: (hash || "").slice(0, 8),
      iso,
      date: iso ? iso.slice(0, 10) : null,
      time: iso ? iso.slice(11, 16) : null,
      author,
      subject: (subject || "").trim(),
      body: cleanBody,
      ...cat,
    };
  }).filter((c) => c.subject);

  // Group counts by category for the headline tiles
  const byType = commits.reduce((acc: Record<string, number>, c) => {
    acc[c.type] = (acc[c.type] || 0) + 1;
    return acc;
  }, {});

  res.json({
    since: date,
    until: dateTo || date,
    commits,
    total: commits.length,
    by_type: byType,
  });
});

export default router;
