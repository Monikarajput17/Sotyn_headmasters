// Mount table for the staff / attendance route group. index.ts / _mounts.ts
// consume this — do not mount these routers anywhere else.
import type { RouterImpl } from "../../_shared/express-lite.ts";
import attendance from "./attendance.ts";
import locations from "./locations.ts";
import wordcount from "./wordcount.ts";
import changelog from "./changelog.ts";

export const mounts: Array<[string, RouterImpl]> = [
  ["/attendance", attendance],
  ["/admin/locations", locations],
  ["/admin/word-count", wordcount],
  ["/admin/changelog", changelog],
];
