import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from '../../client/node_modules/esbuild/lib/main.js';
import { resolveConfig } from '../../client/node_modules/vite/dist/node/index.js';

const client = fileURLToPath(new URL('../../client/', import.meta.url));

test('development refuses remote API, proxy and Realtime endpoints', async () => {
  const config = await resolveConfig({ root: client }, 'serve');
  assert.equal(config.server.proxy['/api'].target, 'http://127.0.0.1:54321/functions/v1/api');
  for (const name of ['API_PROXY_TARGET', 'VITE_API_BASE', 'VITE_SUPABASE_URL']) {
    const previous = process.env[name];
    try {
      process.env[name] = 'https://production.example.test/api';
      await assert.rejects(resolveConfig({ root: client }, 'serve'), /Remote backends are blocked/);
    } finally {
      if (previous === undefined) delete process.env[name]; else process.env[name] = previous;
    }
  }
  await assert.rejects(resolveConfig({ root: client, mode: 'production' }, 'serve'), /Remote backends are blocked/);
  await resolveConfig({ root: client, mode: 'production' }, 'build');
});

test('local backend refuses remote auth and DB overrides; production stays supported', () => {
  const source = readFileSync(new URL('../../supabase/functions/_shared/environment.ts', import.meta.url), 'utf8');
  const { code } = transformSync(source, { loader: 'ts', format: 'cjs' });
  const check = (values) => runInNewContext(code, {
    Deno: { env: { get: (key) => values[key] } }, URL, module: { exports: {} },
  });
  const local = { LOCAL_DEVELOPMENT: '1', SUPABASE_URL: 'http://kong:8000', SUPABASE_DB_URL: 'postgresql://postgres:postgres@db:5432/postgres' };
  assert.doesNotThrow(() => check(local));
  for (const overrides of [
    { SUPABASE_URL: 'https://production.example.test' },
    { DB_POOL_URL: 'postgresql://postgres:password@production.example.test/postgres' },
  ]) {
    assert.throws(() => check({ ...local, ...overrides }), /remote services are blocked/);
  }
  assert.doesNotThrow(() => check({ SUPABASE_URL: 'https://production.example.test', DB_POOL_URL: 'postgresql://postgres:password@production.example.test/postgres' }));
});
