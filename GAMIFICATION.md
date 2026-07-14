# Champions League — ERP Gamification

Company-wide gamification that turns the existing **Performance (Scorecard)**
data into a fair, motivating competition: Employee of the Week / Month /
Quarter / Year, plus Team of the Month. Designed with mam on 2026-06-26.

---

## 1. The fairness principle

Different roles do different work, so raw output can't be compared. Champions
League **reuses each person's existing Performance scorecard**, where everyone
is already scored against **their own role template targets** (delegations
done, DPRs filed, collections, payments, etc.). That makes an accountant and a
site engineer directly comparable — both are "% of *your own* plan achieved".

> No new data entry. If a person has a Performance template assigned, they are
> automatically a player.

### Champions Score
- **Weekly** = `100 + (that week's scorecard %)`, clamped to `0…200`.
  - Hit your plan exactly → **100**. Beat it → above 100. Miss it → below.
- **Month / Quarter / Year** = the **average** of the weekly Champions Scores
  across the weeks the player *qualified* in.
- **Team score** = simple **average** of its members' scores (mam's pick), so
  small and large pods compete fairly.

### Guardrail (anti-gaming)
A week only counts if the player did at least **`min_activity`** units of work
that week (admin-tunable, default 1) — so nobody wins on two perfect tasks
while doing almost nothing. Quality/rework already pulls the underlying
scorecard down, and template weights cap any single KPI.

---

## 2. Teams

- **Cross-functional balanced pods of 7–10** (mam's pick).
- **Auto-balance** (headline feature): ranks every scorable employee by current
  score, then deals them into N pods with a **snake draft** (1→N, N→1, 1→N…) so
  each team gets a comparable mix of strong and developing players.
- Pods can also be edited by hand (add/remove members).
- Team names pool: Titans · Vanguard · Apex · Falcons · Dynamos · Pinnacle ·
  Spartans · Trailblazers · Phoenix · Olympians.

---

## 3. Awards & badges (Champions theme)

| Cycle    | Title                 | Badge |
|----------|-----------------------|-------|
| Weekly   | **Spark of the Week** | ⚡ |
| Monthly  | **Star Performer**    | 🌟 |
| Quarterly| **Quarter Champion**  | 🏆 |
| Yearly   | **Legend of the Year**| 👑 |
| Team (mo)| **Champions Circle**  | 🛡️ |

Winners are **automatic — highest score** each cycle, so there are no disputes.
Leaderboard is **fully transparent** to everyone.

---

## 4. Where it lives

- **Sidebar:** HRMS → **Champions League** (`/champions`), right under Performance.
- **Module key:** `gamification` (grantable in Roles & Permissions).
- **Visibility:** Leaderboard tab for everyone; **Teams & Setup** tab is admin-only.

---

## 5. Technical design

### Backend
- `server/routes/scoring.js` — extracted **`computeScorecard(db, userId, weekStart)`**
  (the role-normalized weekly score) so it can be reused without duplicating KPI
  math. The `/scorecard` route is now a thin wrapper; response unchanged. Adds
  an `activity` field (total auto work units) for the min-activity gate.
- `server/routes/champions.js` — mounted at `/api/gamification`:
  - `GET /leaderboard?period=week|month|quarter|year&date=YYYY-MM-DD`
    → ranked individuals, teams, award winners, not-qualified bucket. 90s cache.
  - `GET /teams`, `POST /teams`, `PUT /teams/:id`, `DELETE /teams/:id`
  - `POST /teams/:id/members`, `DELETE /teams/:id/members/:userId`
  - `POST /teams/auto-balance` `{count}` — snake-draft balanced pods
  - `GET /config`, `PUT /config` `{min_activity, league_name}`
  - Tables (self-creating, idempotent): `gam_team`, `gam_team_member`,
    `gam_config`, `gam_kudos`, `gam_bonus`, `gam_award`.

### Frontend
- `client/src/pages/Champions.jsx` — period switcher, award banners, podium
  (top 3), full ranking with score bars, team standings, admin Teams & Setup
  (auto-balance, config, manual roster edits).

---

## 6. Roadmap

- **Phase 1 — DONE (2026-06-26):** scoring engine (reuses Scorecard), leaderboard,
  teams + auto-balance, config, badges/awards UI.
- **Phase 2:** persisted Team-of-the-Month history + locked award records
  (`gam_award`); month-end auto-snapshot.
- **Phase 3:** peer **kudos** + manager **bonus** points on top of auto KPIs
  (`gam_kudos`, `gam_bonus` already provisioned); streak/special badges
  (On-Fire Streak 🔥, Zero-Late Hero 💎, Comeback Star 📈).

---

## 7. Decisions captured (mam, 2026-06-26)

Scoring: role-normalized %. Teams: cross-functional balanced pods of 7–10.
Team score: average of members. KPIs: task on-time %, SLA adherence, quality
(rework) — attendance deliberately excluded. Recognition: peer kudos + manager
bonus (Phase 3). Awards: week + month + quarter + year + team-of-month. Winner:
highest points automatic. Guardrails: quality penalty, min activity, category
cap. Visibility: fully transparent. Theme: Champions (Titans / Star Performer /
Legend).
