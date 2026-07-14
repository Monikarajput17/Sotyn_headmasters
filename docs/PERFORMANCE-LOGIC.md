# SOTYN.AI — Performance (Scorecard) Logic

*How every employee's weekly performance number is calculated, displayed, and rolled up.*

Last updated: 2026-07-06

---

## 1. The one number

Every employee gets **one weekly performance number**. It answers a single question:

> *"Of everything this person was supposed to deliver this week, how much did they actually deliver — weighted by how important each thing is?"*

- **100%** = did exactly what was planned (on plan).
- **Below 100%** = fell short.
- **Above 100%** = beat the plan.

The Scorecard page shows this as a **variance vs plan** (100% is shown as **0%**, so a shortfall reads as a negative number — see §4). The same underlying number feeds the Team Overview board, the Champions League, and the War Room.

---

## 2. The building blocks

Performance is built from a **role template**. Each role (Site Engineer, Accountant, Sales, etc.) has a template; each employee is assigned one template.

A template is a list of **KPIs** (the things that matter for that role). Every KPI has four settings:

| Setting | Meaning |
|---|---|
| **Weight %** | How important this KPI is. All the weights in a template add up to 100%. |
| **Plan (Target)** | What the person is expected to achieve this week. |
| **Actual** | What they actually achieved. |
| **Direction** | *Higher is better* (e.g. tasks done) or *Lower is better* (e.g. late days, cost). |
| **Source** | Where **Actual** comes from — typed in **manually**, or pulled **automatically** live from the ERP (see §6). |

---

## 3. The core formula

### Step 1 — Achievement % for each KPI

For each KPI we compare Actual against Plan:

**Higher-is-better KPI:**
```
Achievement % = (Actual ÷ Plan) × 100
```
- 5 of 6 DPRs → 83%
- 3 of 3 tasks → 100%
- 4 of 3 (beat it) → 133%

**Lower-is-better KPI** (late days, cost, attrition — where less is good):
```
If Actual ≤ Plan   → 100%   (you stayed within the limit)
If Actual > Plan   → (Plan ÷ Actual) × 100   (eases down as you overshoot)
```
- Limit 1 late day, had 3 → 33%

**Rule:** a KPI's achievement is **never negative** — the lowest it can read is 0% (0 of 6 done = 0%, not −100%).

### Step 2 — Weighted weekly score

Each KPI's achievement is multiplied by its weight, and we take the weighted average:

```
Weekly Score  =  Σ ( Weight × Achievement% )  ÷  Σ ( Weight )
```

That is the person's performance for the week.

---

## 4. How it's shown on screen — "variance vs plan"

Internally the engine keeps the achievement % (100 = on plan) because the leaderboard needs "higher is better." But on the **Scorecard page** we subtract 100 so the number reads as a **gap from plan**:

```
Shown %  =  Weekly Score − 100
```

| Weekly Score (engine) | Shown on Scorecard | Meaning |
|---|---|---|
| 100% | **0%** | Exactly on plan |
| 78% | **−22%** | 22% behind plan |
| 112% | **+12%** | 12% ahead of plan |

This is why the page shows a number like **−21.8%** instead of "78.2%" — it tells the employee *how far off plan they are*, at a glance.

### Colour bands

| Shown % | Colour | Read as |
|---|---|---|
| 0% or better | 🟢 Green | On or ahead of plan |
| 0% to −50% | 🟠 Amber | Behind, but within range |
| Below −50% | 🔴 Red | Seriously behind |

---

## 5. Worked example — one week for a Site Engineer

| KPI | Weight | Plan | Actual | Direction | Achievement % |
|---|---|---|---|---|---|
| DPR submissions | 30% | 6 | 5 | higher | 5÷6 = **83%** |
| Indent vs Bill | 20% | 4 | 4 | higher | 4÷4 = **100%** |
| Collections (₹ lakh) | 25% | 10 | 6 | higher | 6÷10 = **60%** |
| Late days | 10% | 1 | 3 | lower | 1÷3 = **33%** |
| PMS tasks | 15% | 8 | 8 | higher | 8÷8 = **100%** |

```
Weekly Score = (30×83 + 20×100 + 25×60 + 10×33 + 15×100) ÷ 100
             = (2490 + 2000 + 1500 + 330 + 1500) ÷ 100
             = 7820 ÷ 100
             = 78.2%
```

- **Engine score:** 78.2%
- **Shown on Scorecard:** 78.2 − 100 = **−21.8%** (🟠 amber — behind plan)

---

## 6. Where "Actual" comes from

A KPI's **Actual** is filled one of two ways:

### Manual
The employee (or admin) types the number into the scorecard each week.

### Automatic (live from the ERP)
For `auto:*` sources the system reads the real data itself — no typing. For each auto source the system knows what feeds the **Plan** and what feeds the **Actual**. Examples:

| Auto source | Plan (target) | Actual (achieved) |
|---|---|---|
| Delegations | Delegations assigned this week | Delegations completed |
| PMS tasks | PMS tasks assigned | PMS tasks approved |
| DPR count | 6 days/week | DPRs submitted |
| Collections (₹ lakh) | You set | Money collected this week, in lakh |
| Attendance – late days | You set (lower better) | Late days this week |
| RACI steps | Steps the person owns this week | Steps they closed on time |

*(The Scorecard template editor shows this Plan/Actual explanation under every source, and an admin can preview any assigned user's live actuals.)*

**Resolution order for the Plan** (most specific wins):
1. A number typed into that week's entry, else
2. A per-user target override, else
3. The template's default target.

The same idea applies to **Weight** — a per-user weight override can raise, lower, or mute (0%) a KPI for one person without changing the template for everyone.

---

## 7. Accountability feed — RACI + SLA

Cross-module accountability flows in through the **RACI Steps** KPI. For each ERP process the person named *Responsible* for a step is scored on:

- **Steps done** — closed vs the steps assigned to them this week, and
- **On-time %** — how many of those closed steps were finished within the SLA.

This can be drilled down step-by-step on the scorecard (module → step → planned / done / pending / on-time).

---

## 8. The commitment layer — promise vs delivery *(added 2026-07-06)*

On top of the calculation, each employee makes a **commitment** for the coming week — a promise of where they'll land.

- **Commitment box** — the employee commits a target for next week, from **0% (will fully hit plan)** down to **−50% (the worst they'll allow themselves)**. They cannot commit below −50%, and cannot promise to beat plan.
- **Last week's committed target** — shown in its own box next to the actual result, so the promise is always visible against reality.
- **Committed-vs-Delivered graph** — bars show what was delivered each week against a dashed line of what was committed. Bars turn **red when they fall short of the promise** — the visible gap the employee owns and has to close.

The commitment is stored in the same "variance vs plan" language as the display (0 = on plan), so a commitment of −15% lines up directly with a delivered result of −21.8% → a **6.8% gap**.

---

## 9. How the number rolls up

The **same** weekly score is used everywhere, so every screen shows one number per person:

- **Scorecard → Team Overview** — every employee's weekly score, ranked.
- **Champions League** — Champions Score = 100 + the weekly variance %, plus teams, badges and the leaderboard. (A minimum-activity gate stops someone "winning" on two perfect tasks while doing almost nothing.)
- **War Room / QQTC** — feeds the performance and on-time views.

If a person has **no template assigned**, they fall back to a task/RACI activity score so their row is never blank.

---

## 10. Rules & edge cases (quick reference)

- A KPI achievement is **floored at 0%** — never negative.
- **Plan = 0** → that KPI scores 0 (nothing to measure against).
- **Lower-is-better** KPIs score 100% while at/under target, then ease down.
- Weights that don't sum to 100% still work (weighted average), but the template editor flags it so it can be corrected.
- The engine keeps the raw achievement % (higher-better); the minus-100 "variance" is **display only** — it never changes the leaderboard maths.
- The week runs **Monday → Saturday**; timestamps are handled in IST.

---

*Reference (for the technical team): the engine is `computeScorecard()` in `server/routes/scoring.js`; per-KPI achievement at lines 974–982, the weighted score at line 1019. The commitment layer is the `score_commitments` table with `GET/PUT /scoring/commitment(s)`.*
