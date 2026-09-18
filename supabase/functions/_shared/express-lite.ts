// A deliberately small Express-compatible layer for the Edge Function, so the
// Phase-3 route modules (written for Express) run with near-zero changes:
//
//   const router = Router();
//   router.use(authMiddleware);
//   router.get('/:id(\\d+)', requirePermission('m','view'), async (req, res) => { ... });
//   export default router;
//
// Supported: req.params/query/body/headers(lowercase object)/user/ip/
// originalUrl/method/file/files; res.status().json()/send()/setHeader()/
// type()/end()/redirect()/on('finish'); middleware chains with next();
// Express path params incl. ':id(\\d+)' regex params; app.use(prefix, router).
// NOT supported (by design): res.sendFile / streaming — return Uint8Array via
// res.send() instead.

// deno-lint-ignore no-explicit-any
type Any = any;

export interface UploadedFile {
  fieldname: string; originalname: string; mimetype: string; size: number; buffer: Uint8Array;
}

export interface Req {
  method: string;
  url: string;              // path + query (relative to the API root), like Express req.url inside a router
  originalUrl: string;      // '/api/...' as the old server saw it (audit middleware relies on this)
  path: string;
  params: Record<string, string>;
  query: Record<string, Any>;
  body: Any;
  headers: Record<string, string>;
  ip: string;
  user?: Any;
  file?: UploadedFile;
  files?: UploadedFile[];
  raw: Request;
  // deno-lint-ignore no-explicit-any
  [k: string]: any;
}

export class Res {
  statusCode = 200;
  headers = new Headers();
  body: BodyInit | null = null;
  finished = false;
  private finishCbs: Array<() => void> = [];
  status(n: number) { this.statusCode = n; return this; }
  setHeader(k: string, v: string) { this.headers.set(k, String(v)); return this; }
  set(k: string, v: string) { return this.setHeader(k, v); }
  type(t: string) { this.headers.set("content-type", t.includes("/") ? t : `application/${t}`); return this; }
  json(obj: Any) {
    if (!this.headers.has("content-type")) this.headers.set("content-type", "application/json; charset=utf-8");
    this.body = JSON.stringify(obj === undefined ? null : obj);
    this.finished = true;
    return this;
  }
  send(data: Any) {
    if (data === undefined || data === null) { this.body = ""; }
    else if (typeof data === "string") { if (!this.headers.has("content-type")) this.headers.set("content-type", "text/html; charset=utf-8"); this.body = data; }
    else if (data instanceof Uint8Array || data instanceof ArrayBuffer || data instanceof Blob) { this.body = data as BodyInit; if (!this.headers.has("content-type")) this.headers.set("content-type", "application/octet-stream"); }
    else return this.json(data);
    this.finished = true;
    return this;
  }
  end(data?: Any) { if (data !== undefined) return this.send(data); this.body = this.body ?? ""; this.finished = true; return this; }
  sendStatus(n: number) { this.statusCode = n; return this.end(String(n)); }
  redirect(url: string, code = 302) { this.statusCode = code; this.headers.set("location", url); this.body = ""; this.finished = true; return this; }
  on(event: string, cb: () => void) { if (event === "finish") this.finishCbs.push(cb); }
  _emitFinish() { for (const cb of this.finishCbs) { try { cb(); } catch (_) { /* ignore */ } } }
  toResponse() { return new Response(this.body ?? "", { status: this.statusCode, headers: this.headers }); }
}

export type Next = (err?: Any) => void;
export type Handler = (req: Req, res: Res, next: Next) => Any;

interface Route { method: string; regex: RegExp; keys: string[]; handlers: Handler[] }

function compilePath(path: string): { regex: RegExp; keys: string[] } {
  const keys: string[] = [];
  let out = "^";
  let i = 0;
  while (i < path.length) {
    const ch = path[i];
    if (ch === ":") {
      let j = i + 1;
      while (j < path.length && /[A-Za-z0-9_]/.test(path[j])) j++;
      keys.push(path.slice(i + 1, j));
      let pattern = "[^/]+";
      if (path[j] === "(") {              // custom regex e.g. :id(\d+)
        let depth = 1, k = j + 1;
        for (; k < path.length && depth > 0; k++) { if (path[k] === "(") depth++; else if (path[k] === ")") depth--; }
        pattern = path.slice(j + 1, k - 1);
        j = k;
      }
      out += `(${pattern})`;
      i = j;
      continue;
    }
    if (ch === "*") { out += "(.*)"; keys.push("0"); i++; continue; }
    out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    i++;
  }
  if (out.endsWith("/")) out = out.slice(0, -1);
  out += "/?$";
  return { regex: new RegExp(out), keys };
}

export class RouterImpl {
  routes: Route[] = [];
  private pre: Handler[] = [];
  use(...args: Any[]) {
    // router.use(fn) → middleware for every route declared (Express: after; we apply to all)
    for (const a of args) if (typeof a === "function") this.pre.push(a);
    return this;
  }
  private add(method: string, path: string, handlers: Handler[]) {
    const { regex, keys } = compilePath(path);
    this.routes.push({ method, regex, keys, handlers });
    return this;
  }
  get(p: string, ...h: Handler[]) { return this.add("GET", p, h); }
  post(p: string, ...h: Handler[]) { return this.add("POST", p, h); }
  put(p: string, ...h: Handler[]) { return this.add("PUT", p, h); }
  patch(p: string, ...h: Handler[]) { return this.add("PATCH", p, h); }
  delete(p: string, ...h: Handler[]) { return this.add("DELETE", p, h); }
  all(p: string, ...h: Handler[]) { return this.add("*", p, h); }

  async handle(req: Req, res: Res, subPath: string): Promise<boolean> {
    for (const r of this.routes) {
      if (r.method !== "*" && r.method !== req.method) continue;
      const m = r.regex.exec(subPath);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, idx) => { params[k] = decodeURIComponent(m[idx + 1] ?? ""); });
      req.params = params;
      req.path = subPath;
      const chain = [...this.pre, ...r.handlers];
      const done = await runChain(chain, req, res);
      if (done) return true;
      // fell through (every handler called next) → try next matching route
    }
    return false;
  }
}
export function Router() { return new RouterImpl(); }

async function runChain(handlers: Handler[], req: Req, res: Res): Promise<boolean> {
  for (const h of handlers) {
    let nextCalled = false, nextErr: Any = null;
    const next: Next = (err) => { nextCalled = true; if (err) nextErr = err; };
    await h(req, res, next);
    if (nextErr) throw nextErr;
    if (res.finished) return true;
    if (!nextCalled) return true; // handler ended without responding (e.g. async fire-and-forget) — treat as done
  }
  return false;
}

// Multer look-alikes: files are parsed generically from multipart bodies, so
// these are no-op middlewares kept for source compatibility.
export const upload = {
  single: (_field: string): Handler => (_req, _res, next) => next(),
  array: (_field: string, _max?: number): Handler => (_req, _res, next) => next(),
  fields: (_f: Any): Handler => (_req, _res, next) => next(),
  none: (): Handler => (_req, _res, next) => next(),
};

export class App {
  private mounts: Array<{ prefix: string; router: RouterImpl }> = [];
  private globals: Handler[] = [];
  private prefixes: string[];
  private allowOrigin: string;
  constructor(opts: { prefixes?: string[]; allowOrigin?: string } = {}) {
    this.prefixes = opts.prefixes ?? ["/functions/v1/api", "/api"];
    this.allowOrigin = opts.allowOrigin ?? "*";
  }
  use(a: string | Handler, b?: RouterImpl) {
    if (typeof a === "string" && b) this.mounts.push({ prefix: a.replace(/\/$/, ""), router: b });
    else if (typeof a === "function") this.globals.push(a);
    this.mounts.sort((x, y) => y.prefix.length - x.prefix.length);
    return this;
  }
  private cors(h: Headers, req: Request) {
    const origin = req.headers.get("origin") || "*";
    h.set("access-control-allow-origin", this.allowOrigin === "*" ? origin : this.allowOrigin);
    h.set("access-control-allow-headers", "authorization, x-client-info, apikey, content-type, x-refresh-token, idempotency-key");
    h.set("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    h.set("access-control-expose-headers", "x-refresh-token, x-new-refresh-token, content-disposition");
    h.set("vary", "origin");
  }
  async handle(request: Request): Promise<Response> {
    const res = new Res();
    this.cors(res.headers, request);
    if (request.method === "OPTIONS") return new Response("ok", { status: 200, headers: res.headers });
    const u = new URL(request.url);
    let path = u.pathname;
    for (const p of this.prefixes) if (path.startsWith(p)) { path = path.slice(p.length) || "/"; break; }
    const req = await buildReq(request, path, u);
    try {
      if (this.globals.length && await runChain(this.globals, req, res)) return finish(res);
      for (const m of this.mounts) {
        if (path === m.prefix || path.startsWith(m.prefix + "/")) {
          const sub = path.slice(m.prefix.length) || "/";
          req.url = sub + u.search;
          if (await m.router.handle(req, res, sub)) return finish(res);
        }
      }
      res.status(404).json({ error: `Not found: ${request.method} ${path}` });
      return finish(res);
    } catch (e) {
      console.error("[api] unhandled:", (e as Error)?.stack || e);
      if (!res.finished) res.status(500).json({ error: (e as Error)?.message || "Internal error" });
      return finish(res);
    }
  }
}

function finish(res: Res): Response {
  if (!res.finished) res.end();
  res._emitFinish();
  return res.toResponse();
}

async function buildReq(request: Request, path: string, u: URL): Promise<Req> {
  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  const query: Record<string, Any> = {};
  for (const [k, v] of u.searchParams) {
    if (k in query) query[k] = Array.isArray(query[k]) ? [...query[k], v] : [query[k], v];
    else query[k] = v;
  }
  let body: Any = {};
  let file: UploadedFile | undefined;
  const files: UploadedFile[] = [];
  const ct = (headers["content-type"] || "").toLowerCase();
  if (request.method !== "GET" && request.method !== "HEAD") {
    try {
      if (ct.includes("application/json")) body = await request.json();
      else if (ct.includes("multipart/form-data")) {
        const fd = await request.formData();
        for (const [k, v] of fd.entries()) {
          if (v instanceof File) {
            const f: UploadedFile = { fieldname: k, originalname: v.name, mimetype: v.type || "application/octet-stream", size: v.size, buffer: new Uint8Array(await v.arrayBuffer()) };
            files.push(f); if (!file) file = f;
          } else body[k] = v;
        }
      } else if (ct.includes("application/x-www-form-urlencoded")) {
        const txt = await request.text();
        for (const [k, v] of new URLSearchParams(txt)) body[k] = v;
      } else {
        const txt = await request.text();
        if (txt) { try { body = JSON.parse(txt); } catch { body = { raw: txt }; } }
      }
    } catch (e) { console.warn("[api] body parse failed:", (e as Error).message); }
  }
  const ip = (headers["x-forwarded-for"] || headers["cf-connecting-ip"] || "").split(",")[0].trim() || "0.0.0.0";
  return {
    method: request.method, url: path + u.search, originalUrl: "/api" + path + u.search, path,
    params: {}, query, body, headers, ip, file, files: files.length ? files : undefined, raw: request,
    socket: { remoteAddress: ip },
    get: (h: string) => headers[h.toLowerCase()],
  } as Req;
}
