// Mount table for the ops / admin modules (delegations, help tickets, audit,
// email triggers, AI settings, push, backups stub, business-book stub).
// Prefixes match server/index.js minus the leading '/api'.
import type { RouterImpl } from "../../_shared/express-lite.ts";
import delegations from "./delegations.ts";
import support from "./support.ts";
import audit from "./audit.ts";
import emailRules from "./emailRules.ts";
import aiAgent from "./aiAgent.ts";
import push from "./push.ts";
import backups from "./backups.ts";
import businessBook from "./businessBook.ts";

export const mounts: Array<[string, RouterImpl]> = [
  ["/delegations", delegations],
  ["/support", support],
  ["/admin/audit", audit],
  ["/email-rules", emailRules],
  ["/ai-agent", aiAgent],
  ["/push", push],
  ["/admin/backups", backups],
  ["/business-book", businessBook],
];
