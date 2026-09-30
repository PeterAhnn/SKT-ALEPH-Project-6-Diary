import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import api, { config } from '../api/index.mjs';

test('Vercel raw IncomingMessage retains JSON, rewritten paths and the 64KB limit', async (t) => {
  assert.equal(config.helpers, false, 'generic @vercel/node must not preconsume the request stream');
  const originalFetch = globalThis.fetch;
  const originalURL = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_synthetic_test';
  const rpcCalls = [];
  globalThis.fetch = async (url, options) => {
    rpcCalls.push({ url, payload: JSON.parse(options.body) });
    return new Response(JSON.stringify({ changed: true, entity: { id: 'synthetic-stub-only' } }), { status: 200 });
  };
  const server = createServer(api);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    globalThis.fetch = originalFetch;
    if (originalURL === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = originalURL;
    if (originalKey === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY; else process.env.SUPABASE_PUBLISHABLE_KEY = originalKey;
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const taskID = randomUUID();
  const requestID = randomUUID();
  const path = `/api/index?route=tasks/${taskID}/complete`;
  const request = raw => originalFetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw,
  });
  const saved = await request(JSON.stringify({ request_id: requestID }));
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).ok, true);
  assert.deepEqual(rpcCalls, [{
    url: 'https://example.supabase.co/rest/v1/rpc/pds_mutate',
    payload: { p_action: 'task.complete', p_payload: { id: taskID, request_id: requestID, record_origin: 'user' } },
  }], 'raw JSON reaches the adapter exactly once; no real database is used');
  const malformed = await request('{');
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, 'VALIDATION');
  const oversized = await request(JSON.stringify({ request_id: requestID, padding: 'x'.repeat(65536) }));
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(rpcCalls.length, 1, 'rejected bodies never reach a mutation RPC');
});
