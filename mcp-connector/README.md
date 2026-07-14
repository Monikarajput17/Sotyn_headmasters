# SEPL ERP — Read-Only MCP Connector

Lets Claude (Claude Code **and** the Claude desktop/web app) query the **live ERP**
to answer questions like:

- "How many payment requests are stuck at L2 approval?"
- "What's this month's DPR labour cost for project X?"
- "List vendor POs awaiting Nitin Jain's approval."
- "Show me current receivables ageing."

## Safety — read-only by construction

- The connector **only ever issues HTTP GET** requests (`callApi()` hard-codes the
  method). No tool can create, edit, or delete ERP data.
- The generic `erp_get` tool is restricted to an **allow-list of read prefixes**
  (`endpoints.js` → `ALLOWED_GET_PREFIXES`) — auth/admin/backup paths are excluded.
- Use a **dedicated read-only service account** (e.g. `claude-readonly`), never the
  admin login. Even if the token leaks, nobody can change data.

## 1. Install

```bash
cd mcp-connector
npm install
cp .env.example .env     # then edit .env
```

Fill in `.env`:
- `ERP_BASE_URL` — the live ERP URL (e.g. `https://erp.securedengineers.com`)
- `ERP_USER` / `ERP_PASS` — the read-only service account (recommended), **or**
  `ERP_TOKEN` — a bearer token for that account

## 2a. Connect to Claude Code (stdio)

Add to `.mcp.json` in the repo root (or your user `~/.claude.json`):

```json
{
  "mcpServers": {
    "sepl-erp": {
      "command": "node",
      "args": ["mcp-connector/server.js"]
    }
  }
}
```

Restart Claude Code. Ask: *"List the ERP reports you can read."* (calls `list_erp_reports`).

## 2b. Connect to the Claude app (HTTP)

Run the connector as a small service on the VPS:

```bash
MCP_TRANSPORT=http MCP_BEARER=<a-long-random-secret> node mcp-connector/server.js
# serves POST /mcp on :8788  (set MCP_HTTP_PORT to change)
```

Put it behind HTTPS (your existing reverse proxy) and add it in the Claude app as a
**custom connector** pointing at `https://your-domain/mcp`, sending header
`Authorization: Bearer <the MCP_BEARER value>`.

To keep it always-on with pm2:

```bash
pm2 start mcp-connector/server.js --name erp-mcp --update-env \
  --env MCP_TRANSPORT=http
pm2 save
```

## 3. Add a new report

Add a row to `ENDPOINTS` in [`endpoints.js`](endpoints.js) — `name` becomes the
Claude tool name, `path` the GET endpoint. That's it.

## Files

| File | Purpose |
|------|---------|
| `server.js` | MCP server — auth, GET-only fetch, stdio + HTTP transports |
| `endpoints.js` | Catalogue of read endpoints + the generic allow-list |
| `.env.example` | Config template (copy to `.env`) |
