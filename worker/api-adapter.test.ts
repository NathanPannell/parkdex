import assert from 'node:assert/strict';
import test from 'node:test';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../api/feedback-api.js';
import worker from './index.js';

function responseCapture() {
  const headers = new Map<string, unknown>();
  const state = { status: 0, body: undefined as unknown };
  const response = {
    status(value: number) { state.status = value; return response; },
    setHeader(key: string, value: unknown) { headers.set(key.toLowerCase(), value); return response; },
    json(value: unknown) { state.body = value; return response; },
    send(value: unknown) { state.body = value; return response; },
  } as unknown as VercelResponse;
  return { response, headers, state };
}

async function withAdapter(
  request: Partial<VercelRequest>,
  fetchHandler: typeof worker.fetch,
) {
  const originalFetch = worker.fetch;
  const originalUrl = process.env.PUBLIC_APP_URL;
  const capture = responseCapture();
  process.env.PUBLIC_APP_URL = 'https://kip.example.test';
  worker.fetch = fetchHandler;
  try {
    await handler({ method: 'POST', query: {}, headers: {}, body: '', ...request } as VercelRequest, capture.response);
    return capture;
  } finally {
    worker.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.PUBLIC_APP_URL;
    else process.env.PUBLIC_APP_URL = originalUrl;
  }
}

test('adapter keeps session and CSRF cookies as separate response headers', async () => {
  const capture = await withAdapter({ query: { path: 'auth/login' } }, async () => {
    const headers = new Headers();
    headers.append('set-cookie', '__Host-kip_session=opaque; Path=/; HttpOnly; Secure; SameSite=Lax');
    headers.append('set-cookie', '__Host-kip_csrf=nonce; Path=/; Secure; SameSite=Lax');
    return new Response('{}', { status: 200, headers });
  });
  assert.equal(capture.state.status, 200);
  assert.deepEqual(capture.headers.get('set-cookie'), [
    '__Host-kip_session=opaque; Path=/; HttpOnly; Secure; SameSite=Lax',
    '__Host-kip_csrf=nonce; Path=/; Secure; SameSite=Lax',
  ]);
});

test('empty retention POST has no body and client cannot forge trusted IP', async () => {
  const capture = await withAdapter({
    query: { path: 'retention/interactions/purge' },
    headers: { 'cf-connecting-ip': 'client-supplied', 'x-vercel-forwarded-for': '192.0.2.1, 192.0.2.2' },
  }, async (request) => {
    assert.equal(request.body, null);
    assert.equal(request.headers.get('cf-connecting-ip'), '192.0.2.1');
    assert.equal(new URL(request.url).pathname, '/api/retention/interactions/purge');
    return new Response('{}');
  });
  assert.equal(capture.state.status, 200);
});

test('raw photo bytes survive the Node adapter unchanged', async () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
  const capture = await withAdapter({ method: 'PUT', query: { path: 'claims/owned/photo' }, body: bytes }, async (request) => {
    assert.deepEqual(Buffer.from(await request.arrayBuffer()), bytes);
    assert.equal(request.headers.get('cf-connecting-ip'), 'unknown');
    return new Response(null, { status: 204 });
  });
  assert.equal(capture.state.status, 204);
});

test('oversize raw upload is rejected before the application handler', async () => {
  const capture = await withAdapter({ body: Buffer.alloc(3 * 1024 * 1024 + 1) }, async () => {
    assert.fail('oversize request reached the handler');
  });
  assert.equal(capture.state.status, 413);
});
