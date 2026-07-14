#!/usr/bin/env node
// ---------------------------------------------------------------------------
// SEPL ERP — read-only MCP connector
//
// Exposes the live ERP's reporting endpoints to Claude (Claude Code via stdio,
// or the Claude app via HTTP). It is READ-ONLY BY CONSTRUCTION: callApi() only
// ever issues HTTP GET, so no tool — named or generic — can create, edit or
// delete ERP data.
//
// Auth: prefers a static ERP_TOKEN; otherwise logs in once with
// ERP_USER / ERP_PASS (use a dedicated read-only service account, never admin)
// and caches + auto-refreshes the token.
//
// Run:
//   Claude Code (stdio):  node server.js
//   Claude app (HTTP):    MCP_TRANSPORT=http node server.js   # serves /mcp
// ---------------------------------------------------------------------------

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import dotenv from 'dotenv';
// Load .env from THIS file's folder, regardless of the caller's cwd (Claude
// Code launches us from the repo root, not from mcp-connector/).
dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '.env') });
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ENDPOINTS, ALLOWED_GET_PREFIXES } from './endpoints.js';

const BASE_URL = (process.env.ERP_BASE_URL || '').replace(/\/+$/, '');
const ERP_TOKEN = process.env.ERP_TOKEN || '';
const ERP_USER = process.env.ERP_USER || '';
const ERP_PASS = process.env.ERP_PASS || '';
const HTTP_PORT = Number(process.env.MCP_HTTP_PORT || 8788);

if (!BASE_URL) {
  console.error('[sepl-erp-mcp] ERP_BASE_URL is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}
if (!ERP_TOKEN && !(ERP_USER && ERP_PASS)) {
  console.error('[sepl-erp-mcp] Provide either ERP_TOKEN, or ERP_USER + ERP_PASS, in .env.');
  process.exit(1);
}

// --- Auth: cache a bearer token, log in on demand, refresh on 401 ----------
let cachedToken = ERP_TOKEN || null;

async function login() {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ERP_USER, password: ERP_PASS }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`ERP login failed (${res.status}): ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data?.token) throw new Error('ERP login returned no token');
  cachedToken = data.token;
  return cachedToken;
}

async function ensureToken() {
  if (cachedToken) return cachedToken;
  return login();
}

// --- The ONLY way this connector talks to the ERP. GET only. ---------------
async function callApi(path, params, { retried = false } = {}) {
  if (!path.startsWith('/api/')) throw new Error(`Refused: path must start with /api/ (got "${path}")`);
  const url = new URL(BASE_URL + path);
  if (params && typeof params === 'object') {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }
  const token = await ensureToken();
  const res = await fetch(url, {
    method: 'GET', // hard-coded — never anything else
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });

  // Token went stale (secret rotated / session aged) → re-login once.
  if (res.status === 401 && !ERP_TOKEN && !retried) {
    cachedToken = null;
    await login();
    return callApi(path, params, { retried: true });
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`ERP ${res.status} on GET ${path}: ${txt.slice(0, 300)}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

function asToolResult(data) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  // Guard against dumping enormous payloads into the model context.
  const clipped = text.length > 60000 ? text.slice(0, 60000) + '\n…[truncated]' : text;
  return { content: [{ type: 'text', text: clipped }] };
}

// --- Build the MCP server --------------------------------------------------
function buildServer() {
  const server = new McpServer({ name: 'sepl-erp', version: '1.0.0' });

  // One named tool per catalogued report endpoint.
  for (const ep of ENDPOINTS) {
    const shape = {};
    if (ep.params) {
      for (const key of Object.keys(ep.params)) {
        shape[key] = z.string().optional().describe(ep.params[key]);
      }
    }
    server.tool(
      ep.name,
      `${ep.desc} (read-only GET ${ep.path})`,
      shape,
      async (args) => {
        try {
          return asToolResult(await callApi(ep.path, args));
        } catch (e) {
          return { isError: true, content: [{ type: 'text', text: String(e.message || e) }] };
        }
      }
    );
  }

  // Generic escape hatch: any GET under an allow-listed prefix.
  server.tool(
    'erp_get',
    'Read-only GET against any allow-listed ERP path (use when no specific tool fits). ' +
      'Path must start with /api/ and fall under an allowed prefix. Cannot write data.',
    {
      path: z.string().describe('ERP API path, e.g. /api/collections/target-summary'),
      params: z.record(z.string()).optional().describe('Query params as a flat object of strings'),
    },
    async ({ path, params }) => {
      const ok = ALLOWED_GET_PREFIXES.some((p) => path === p || path.startsWith(p + '/') || path.startsWith(p + '?'));
      if (!ok) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Refused: "${path}" is not under an allowed read prefix.` }],
        };
      }
      try {
        return asToolResult(await callApi(path, params));
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: String(e.message || e) }] };
      }
    }
  );

  // Discoverability helper.
  server.tool('list_erp_reports', 'List every read-only ERP report this connector exposes.', {}, async () => {
    const lines = ENDPOINTS.map((e) => `- ${e.name}: ${e.desc} [GET ${e.path}]`);
    return asToolResult(`SEPL ERP read-only reports:\n${lines.join('\n')}`);
  });

  return server;
}

// --- Transports ------------------------------------------------------------
async function runStdio() {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[sepl-erp-mcp] stdio transport ready');
}

async function runHttp() {
  const express = (await import('express')).default;
  const { StreamableHTTPServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/streamableHttp.js'
  );
  const app = express();
  app.use(express.json());

  // Optional shared-secret gate for the public HTTP endpoint. Set MCP_BEARER
  // and require clients to send it — keeps the connector private on the VPS.
  const GATE = process.env.MCP_BEARER || '';

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'sepl-erp-mcp' }));

  app.post('/mcp', async (req, res) => {
    if (GATE) {
      const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (got !== GATE) return res.status(401).json({ error: 'unauthorized' });
    }
    // Stateless request/response transport — fresh server per request.
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ error: String(e.message || e) });
    }
  });

  app.listen(HTTP_PORT, () => {
    console.error(`[sepl-erp-mcp] HTTP transport ready on :${HTTP_PORT}  (POST /mcp)`);
  });
}

const mode = (process.env.MCP_TRANSPORT || 'stdio').toLowerCase();
(mode === 'http' ? runHttp() : runStdio()).catch((e) => {
  console.error('[sepl-erp-mcp] fatal:', e);
  process.exit(1);
});
