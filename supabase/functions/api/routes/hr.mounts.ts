// Mount table for the payroll + HR ports (picked up by routes/_mounts.ts).
import type { RouterImpl } from "../../_shared/express-lite.ts";
import payroll from "./payroll.ts";
import hr from "./hr.ts";

export const mounts: Array<[string, RouterImpl]> = [["/payroll", payroll], ["/hr", hr]];
