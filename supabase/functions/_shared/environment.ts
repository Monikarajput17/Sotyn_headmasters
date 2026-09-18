// This flag is supplied by the isolated local CLI config, never production.
export const isLocalDevelopment = Deno.env.get("LOCAL_DEVELOPMENT") === "1";

export function requireLocalEndpoint(value: string, name: string, extraHosts: string[] = []) {
  const url = new URL(value);
  const hosts = ["localhost", "127.0.0.1", "[::1]", ...extraHosts];
  if (!hosts.includes(url.hostname)) throw new Error(`${name}: remote services are blocked in local development`);
  return value;
}

if (isLocalDevelopment) {
  requireLocalEndpoint(Deno.env.get("SUPABASE_URL") || "", "SUPABASE_URL", ["kong", "supabase_kong_sotyn-headmasters-local"]);
  requireLocalEndpoint(Deno.env.get("DB_POOL_URL") || Deno.env.get("SUPABASE_DB_URL") || "", "database", ["db", "supabase_db_sotyn-headmasters-local"]);
}
