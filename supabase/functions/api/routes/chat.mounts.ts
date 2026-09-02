// Mount table contributed by the chat port. index.ts / _mounts.ts spread this
// into the app; prefix matches server/index.js (`/api/site-chat`) minus '/api'.
import type { RouterImpl } from "../../_shared/express-lite.ts";
import siteChat from "./siteChat.ts";

export const mounts: Array<[string, RouterImpl]> = [["/site-chat", siteChat]];
