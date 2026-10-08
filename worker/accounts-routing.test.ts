import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createFeedbackWorker, type WorkerEnvironment } from './index.js';
import type { AccountAuthStore, StoredSession } from './accounts/auth-store.js';

const origin = 'https://kip.example.test';
const env: WorkerEnvironment = {
  PUBLIC_APP_URL: origin,
  DATABASE_URL: 'postgresql://unused:unused@ep-test.us-west-2.aws.neon.tech/unused',
  AUTH_SESSION_SECRET: 'auth-test-secret-'.repeat(4),
  KIP_RETENTION_SECRET: 'retention-test-secret-'.repeat(4),
  EMAIL_MODE: 'disabled',
};
const sessionToken = 's'.repeat(43);
const csrfToken = 'c'.repeat(43);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const session: StoredSession = {
  id: '11111111-1111-4111-8111-111111111111', email: 'owned@example.test', emailVerified: true,
  displayName: 'Owned test', providers: ['email'], sessionId: '22222222-2222-4222-8222-222222222222',
  tokenHash: hash(sessionToken), csrfHash: hash(csrfToken), transport: 'web',
  expiresAt: '2099-01-01T00:00:00Z', absoluteExpiresAt: '2099-02-01T00:00:00Z', reauthenticatedAt: null,
};

test('account routes fail closed before touching progress when credentials are absent', async () => {
  const worker = createFeedbackWorker({ progress: { createStore() { assert.fail('unauthenticated progress access'); } } });
  for (const [method, path] of [['GET', '/api/claims'], ['PUT', '/api/claims/33333333-3333-4333-8333-333333333333/photo']]) {
    const response = await worker.fetch(new Request(origin + path, { method, headers: { origin } }), env);
    assert.equal(response.status, 401);
  }
});

test('cookie photo writes require the session-scoped CSRF token before progress dispatch', async () => {
  const store = { findSession: async () => session } as unknown as AccountAuthStore;
  const worker = createFeedbackWorker({ auth: { createStore: () => store }, progress: { createStore() { assert.fail('unverified cookie write'); } } });
  const headerCases: HeadersInit[] = [
    { origin, cookie: `kip_account_session=${sessionToken}` },
    { origin, cookie: `kip_account_session=${sessionToken}; kip_account_csrf=${csrfToken}`, 'x-csrf-token': 'x'.repeat(43) },
    { origin: 'https://untrusted.example.test', cookie: `kip_account_session=${sessionToken}; kip_account_csrf=${csrfToken}`, 'x-csrf-token': csrfToken },
  ];
  for (const headers of headerCases) {
    const response = await worker.fetch(new Request(origin + '/api/claims/33333333-3333-4333-8333-333333333333/photo', { method: 'PUT', headers }), env);
    assert.equal(response.status, 403);
  }
});

test('native CORS advertises only the necessary auth and upload headers for allowed origins', async () => {
  const worker = createFeedbackWorker();
  const response = await worker.fetch(new Request(origin + '/api/claims', { method: 'OPTIONS', headers: { origin: 'https://localhost' } }), env);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://localhost');
  assert.match(response.headers.get('access-control-allow-methods')!, /PUT/);
  assert.match(response.headers.get('access-control-allow-headers')!, /Authorization/);
  assert.match(response.headers.get('access-control-allow-headers')!, /X-Kip-Account-ID/);
  const rejected = await worker.fetch(new Request(origin + '/api/claims', { method: 'OPTIONS', headers: { origin: 'https://untrusted.example.test' } }), env);
  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers.get('access-control-allow-origin'), null);
});

test('a stale tab cannot read or upload one account partition through another account cookie', async () => {
  const store = { findSession: async () => session } as unknown as AccountAuthStore;
  const worker = createFeedbackWorker({ auth: { createStore: () => store }, progress: { createStore() { assert.fail('stale account reached progress storage'); } } });
  for (const method of ['GET', 'PUT']) {
    for (const expectedId of [null, '99999999-9999-4999-8999-999999999999']) {
      const headers = new Headers({ origin, cookie: `kip_account_session=${sessionToken}; kip_account_csrf=${csrfToken}`, 'X-CSRF-Token': csrfToken });
      if (expectedId) headers.set('X-Kip-Account-ID', expectedId);
      const response = await worker.fetch(new Request(origin + '/api/claims', { method, headers }), env);
      assert.equal(response.status, 409);
      assert.equal((await response.json() as { code: string }).code, 'account_changed');
    }
  }
});

test('purge and manual deletion recovery remain protected independently of account login', async () => {
  const worker = createFeedbackWorker();
  for (const path of ['/api/retention/interactions/purge', '/api/recovery/account-deletions/33333333-3333-4333-8333-333333333333/resume']) {
    const response = await worker.fetch(new Request(origin + path, { method: 'POST', headers: { origin } }), env);
    assert.equal(response.status, 401);
  }
});

test('manual deletion recovery accepts the retention secret', async () => {
  const store = { findDeletionReceipt: async () => ({ accountId: 'a', status: 'complete' }) } as unknown as AccountAuthStore;
  const worker = createFeedbackWorker({ auth: { createStore: () => store } });
  const path = '/api/recovery/account-deletions/33333333-3333-4333-8333-333333333333/resume';
  const response = await worker.fetch(new Request(origin + path, { method: 'POST', headers: { authorization: `Bearer ${env.KIP_RETENTION_SECRET}` } }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { receiptId: '33333333-3333-4333-8333-333333333333', status: 'complete', complete: true });
});
