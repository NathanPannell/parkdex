import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { applyMigration, dbUrl, pool } from './qa-postgres-adapter.mjs';
import { createNeonAccountAuthStore } from '../worker/accounts/auth-store.ts';
import { createNeonProgressStore } from '../worker/accounts/progress-store.ts';
import { deleteAccountData } from '../worker/accounts/photos.ts';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const accountA = randomUUID();
const accountB = randomUUID();
const store = createNeonProgressStore(dbUrl);
const auth = createNeonAccountAuthStore(dbUrl);
const snapshot = (parkId, name = 'QA Park') => ({ id: parkId, name, short: 'QA', category: 'national', region: 'QA', lat: 49, lng: -123, biome: 'coast', shape: 'seal', rarity: 'common', seed: 1, blurb: 'Synthetic test park.', scene: null });
const claim = (claimId, name = 'QA Park') => ({ claimId, parkId: 'national-qa-park', claimedAt: '2026-09-20T18:12:41.000Z', parkSnapshot: snapshot('national-qa-park', name), contentReleaseId: null });
const log = (name) => process.stdout.write(`${name}: PASS\n`);

try {
  await applyMigration(fileURLToPath(new URL('../database/migrations/accounts_001_init.sql', import.meta.url)));
  await applyMigration(fileURLToPath(new URL('../database/migrations/progress_001_init.sql', import.meta.url)));
  await pool.query('INSERT INTO kip_account.accounts (id,normalized_email,password_hash) VALUES ($1,$2,$3),($4,$5,$6)', [accountA, `progress-a-${suffix}@example.test`, 'qa-hash', accountB, `progress-b-${suffix}@example.test`, 'qa-hash']);

  const sameClaimId = randomUUID();
  const payload = claim(sameClaimId);
  const payloadHash = digest(JSON.stringify(payload));
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => store.putClaim(accountA, payload, payloadHash)));
  assert.equal(concurrent.filter((result) => result.status === 'created').length, 1);
  assert.equal(concurrent.filter((result) => result.status === 'identical').length, 7);
  assert.equal((await store.putClaim(accountA, claim(sameClaimId, 'Mutated'), digest('mutated'))).status, 'conflict');
  assert.equal((await store.putClaim(accountB, payload, payloadHash)).status, 'created');
  assert.equal((await store.getClaim(accountA, sameClaimId))?.parkSnapshot.name, 'QA Park');
  assert.equal((await store.getClaim(accountB, sameClaimId))?.parkSnapshot.name, 'QA Park');
  log('concurrent immutable claim replay and account scope');

  const basePage = await store.listClaims(accountA, null, 100);
  assert.equal(basePage.rows.length, 1);
  assert.equal(basePage.rows[0].photo.status, 'missing');
  const initialRevision = basePage.rows[0].syncRevision;
  const photoHash = digest('jpeg-photo-qa');
  const photo = { objectKey: `accounts/${accountA}/claims/${sameClaimId}`, contentType: 'image/jpeg', sha256: photoHash, sizeBytes: 12 };
  const reserved = await store.reservePhoto(accountA, sameClaimId, photo);
  assert.equal(reserved.status, 'reserved');
  const pendingPage = await store.listClaims(accountA, initialRevision, 100);
  assert.equal(pendingPage.rows.length, 1);
  assert.equal(pendingPage.rows[0].claimId, sameClaimId);
  assert.equal(pendingPage.rows[0].photo.status, 'pending');
  const pendingRevision = pendingPage.rows[0].syncRevision;
  assert.ok(BigInt(pendingRevision) > BigInt(initialRevision));
  assert.equal(await store.markPhotoReady(accountA, sameClaimId, photoHash), true);
  const readyPage = await store.listClaims(accountA, pendingRevision, 100);
  assert.equal(readyPage.rows.length, 1);
  assert.equal(readyPage.rows[0].claimId, sameClaimId);
  assert.equal(readyPage.rows[0].photo.status, 'ready');
  assert.ok(BigInt(readyPage.rows[0].syncRevision) > BigInt(pendingRevision));
  assert.equal(await store.markPhotoReady(accountA, sameClaimId, photoHash), true);
  assert.equal((await store.listClaims(accountA, readyPage.rows[0].syncRevision, 100)).rows.length, 0);
  const otherAccountPhoto = { ...photo, objectKey: `accounts/${accountB}/claims/${sameClaimId}` };
  assert.equal((await store.reservePhoto(accountB, sameClaimId, otherAccountPhoto)).status, 'reserved');
  assert.equal((await store.getPhoto(accountA, sameClaimId))?.status, 'ready');
  assert.equal((await store.getPhoto(accountB, sameClaimId))?.status, 'pending');
  log('photo missing to pending to ready revision feed');

  const extraIds = Array.from({ length: 12 }, () => randomUUID());
  await Promise.all(extraIds.map((id) => { const row = claim(id); return store.putClaim(accountA, row, digest(JSON.stringify(row))); }));
  const seen = new Set();
  let cursor = null;
  for (;;) {
    const page = await store.listClaims(accountA, cursor, 3);
    for (const row of page.rows) {
      assert.ok(!seen.has(row.claimId));
      seen.add(row.claimId);
    }
    if (page.rows.length === 0) break;
    cursor = page.rows.at(-1).syncRevision;
  }
  assert.equal(seen.size, 13);
  assert.equal((await store.listClaims(accountB, null, 100)).rows.length, 1);
  log('revision pagination and cross-account isolation');

  const receiptId = randomUUID();
  const accountC = randomUUID();
  await pool.query('INSERT INTO kip_account.accounts (id,normalized_email,password_hash,deletion_state) VALUES ($1,$2,$3,$4)', [accountC, `progress-c-${suffix}@example.test`, 'qa-hash', 'deleting']);
  await pool.query('INSERT INTO kip_account.account_deletion_receipts (receipt_id,account_id) VALUES ($1,$2)', [receiptId, accountC]);
  const calls = [];
  const env = { DATABASE_URL: dbUrl, KIP_PHOTO_SERVICE_URL: 'https://photos.example.test', KIP_PHOTO_SERVICE_TOKEN: 'qa-token' };
  const completed = await deleteAccountData({ accountId: accountC, receiptId }, env, { createStore: () => store, fetch: async (url, init) => {
    calls.push({ url: String(url), method: init.method });
    return new Response(JSON.stringify({ complete: true, deleted: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  assert.equal(completed.complete, true);
  assert.equal(calls.length, 1, 'must call private prefix delete even with zero SQL photos');
  assert.equal(calls[0].method, 'DELETE');
  assert.equal(await auth.completeDeletion(receiptId, new Date().toISOString()), true);
  assert.equal(await auth.findAccountById(accountC), null);
  log('deletion clears orphan private prefix with zero DB metadata');

  const receiptA = randomUUID();
  await pool.query("UPDATE kip_account.accounts SET deletion_state = 'deleting' WHERE id = $1", [accountA]);
  await pool.query('INSERT INTO kip_account.account_deletion_receipts (receipt_id,account_id) VALUES ($1,$2)', [receiptA, accountA]);
  let providerPage = 0;
  const pagedDeletion = await deleteAccountData({ accountId: accountA, receiptId: receiptA }, env, { createStore: () => store, fetch: async () => {
    providerPage += 1;
    return new Response(JSON.stringify(providerPage < 3 ? { complete: false, deleted: 100 } : { complete: true, deleted: 5 }), { status: 200 });
  } });
  assert.equal(pagedDeletion.complete, true);
  assert.equal(providerPage, 3);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM kip_account.claims WHERE account_id = $1', [accountA])).rows[0].count, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM kip_account.account_deletion_photo_objects WHERE receipt_id = $1', [receiptA])).rows[0].count, 0);
  assert.equal(await auth.completeDeletion(receiptA, new Date().toISOString()), true);
  log('205-object private deletion pages and SQL inventory clearance');

  const receiptB = randomUUID();
  await pool.query("UPDATE kip_account.accounts SET deletion_state = 'deleting' WHERE id = $1", [accountB]);
  await pool.query('INSERT INTO kip_account.account_deletion_receipts (receipt_id,account_id) VALUES ($1,$2)', [receiptB, accountB]);
  const failedDeletion = await deleteAccountData({ accountId: accountB, receiptId: receiptB }, env, { createStore: () => store, fetch: async () => new Response('unavailable', { status: 503 }) });
  assert.equal(failedDeletion.complete, false);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM kip_account.account_deletion_photo_objects WHERE receipt_id = $1', [receiptB])).rows[0].count, 1);
  assert.equal((await auth.findDeletionReceipt(receiptB))?.status, 'pending');
  const recoveredDeletion = await deleteAccountData({ accountId: accountB, receiptId: receiptB }, env, { createStore: () => store, fetch: async () => new Response(JSON.stringify({ complete: true, deleted: 0 }), { status: 200 }) });
  assert.equal(recoveredDeletion.complete, true);
  assert.equal(await auth.completeDeletion(receiptB, new Date().toISOString()), true);
  log('private cleanup failure leaves durable manual receipt and inventory');
} finally {
  await pool.end();
}
