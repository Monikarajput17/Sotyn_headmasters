// Mount table for ported modules (merged by the coordinator from each
// group's *.mounts.ts). Prefixes match server/index.js minus the leading '/api'.
import type { RouterImpl } from "../../_shared/express-lite.ts";
import { mounts as salon } from "./salon.mounts.ts";
import { mounts as chat } from "./chat.mounts.ts";
import { mounts as staff } from "./staff.mounts.ts";
import { mounts as hr } from "./hr.mounts.ts";
import { mounts as ops } from "./ops.mounts.ts";

export const extraMounts: Array<[string, RouterImpl]> = [
  ...salon,
  ...chat,
  ...staff,
  ...hr,
  ...ops,
];
