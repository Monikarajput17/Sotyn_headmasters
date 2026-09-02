// Mount table for the salon route modules — merged into _mounts.ts by the
// coordinator. Order matters only for the mount prefixes, which are all
// distinct here (express-lite sorts longest-prefix-first anyway).
import type { RouterImpl } from "../../_shared/express-lite.ts";
import salonStylists from "./salonStylists.ts";
import salonClients from "./salonClients.ts";
import salonProducts from "./salonProducts.ts";
import salonAppointments from "./salonAppointments.ts";
import salonPos from "./salonPos.ts";
import salonMemberships from "./salonMemberships.ts";
import salonCommissions from "./salonCommissions.ts";
import salonPublic from "./salonPublic.ts";

export const mounts: Array<[string, RouterImpl]> = [
  ["/salon/stylists", salonStylists],
  ["/salon/clients", salonClients],
  ["/salon/products", salonProducts],
  ["/salon/appointments", salonAppointments],
  ["/salon/pos", salonPos],
  ["/salon/memberships", salonMemberships],
  ["/salon/commissions", salonCommissions],
  ["/salon/public", salonPublic],
];
