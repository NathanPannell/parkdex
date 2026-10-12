import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { neon } from '@neondatabase/serverless';
import { createNeonAccountAuthStore } from '../worker/accounts/auth-store.ts';
import { applyMigration, dbUrl, pool } from './qa-postgres-adapter.mjs';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const now = () => new Date().toISOString();
const hash = (value) => createHash('sha256').update(value).digest('hex');
const session = (transport = 'web') => {
  const t = Date.now();
  return { id: randomUUID(), tokenHash: hash(randomBytes(32)), csrfHash: transport === 'web' ? hash(randomBytes(32)) : null, transport, expiresAt: new Date(t + 30 * 86400e3).toISOString(), absoluteExpiresAt: new Date(t + 90 * 86400e3).toISOString() };
};
const store = createNeonAccountAuthStore(dbUrl);
const log = (name, result) => process.stdout.write(`${name}: ${result}\n`);

try {
  const sql = neon(dbUrl);
  const batch = await sql.transaction([sql`SELECT 1::integer AS first`, sql`SELECT 2::integer AS second`], { isolationLevel: 'ReadCommitted' });
  assert.equal(batch[0][0].first, 1);
  assert.equal(batch[1][0].second, 2);
  log('Neon transaction batch adapter', 'PASS');
  await applyMigration(fileURLToPath(new URL('../database/migrations/accounts_001_init.sql', import.meta.url)));
  // This runner is restricted by qa-postgres-adapter to a dedicated loopback QA
  // database. Clear prior runs before asserting exact retention backlog counts.
  // CASCADE also clears progress claims when that optional migration was applied.
  await pool.query(`TRUNCATE TABLE
    kip_account.accounts,
    kip_account.google_identities,
    kip_account.sessions,
    kip_account.action_tokens,
    kip_account.google_challenges,
    kip_account.rate_limits,
    kip_account.security_events,
    kip_account.account_deletion_receipts
    CASCADE`);
  if ((await pool.query("SELECT to_regclass('kip_account.account_deletion_photo_objects') AS relation")).rows[0].relation) {
    await pool.query('TRUNCATE TABLE kip_account.account_deletion_photo_objects');
  }
  const accountId = randomUUID();
  const email = `qa-${suffix}@example.test`;
  const initialSession = session();
  const verificationTokenHash = hash(randomBytes(32));
  const registered = await store.createAccount({ accountId, email, passwordHash: 'qa-hash', displayName: 'QA user', session: initialSession, verificationTokenHash, verificationExpiresAt: new Date(Date.now() + 3600e3).toISOString() });
  assert.ok(registered, 'fresh registration must return account and session');
  assert.equal(registered.account.id, accountId);
  assert.equal(registered.account.email, email);
  assert.equal(registered.sessionId, initialSession.id);
  assert.equal((await store.findSession(initialSession.tokenHash))?.sessionId, initialSession.id);
  log('fresh registration', 'PASS');

  assert.equal(await store.consumeVerificationToken(verificationTokenHash, now()), true);
  assert.equal(await store.consumeVerificationToken(verificationTokenHash, now()), false);
  assert.equal((await store.findAccountByEmail(email))?.emailVerified, true);
  log('verification one use', 'PASS');

  await pool.query('UPDATE kip_account.sessions SET expires_at = now() + interval \'1 day\' WHERE id = $1', [initialSession.id]);
  const renewed = session();
  const renewal = await Promise.all([store.rotateSession(initialSession.id, initialSession.tokenHash, renewed, now()), store.rotateSession(initialSession.id, initialSession.tokenHash, session(), now())]);
  assert.equal(renewal.filter(Boolean).length, 1);
  assert.equal(await store.findSession(initialSession.tokenHash), null);
  log('concurrent session rotation', 'PASS');

  const resetTokenHash = hash(randomBytes(32));
  assert.equal(await store.issueActionToken(accountId, 'password_reset', resetTokenHash, new Date(Date.now() + 3600e3).toISOString()), true);
  const reset = await Promise.all([store.consumePasswordResetToken(resetTokenHash, 'new-hash-1', now()), store.consumePasswordResetToken(resetTokenHash, 'new-hash-2', now())]);
  assert.deepEqual(reset.sort(), [false, true]);
  assert.equal(await store.findSession(renewed.tokenHash), null);
  log('concurrent password reset, session revoke', 'PASS');

  const googleEmail = `google-${suffix}@example.test`;
  const googleAccountId = randomUUID();
  const googleSession = session('native');
  const googleInput = { subject: `google-${suffix}`, email: googleEmail, displayName: 'Google QA', accountId: googleAccountId, session: googleSession, now: now() };
  const freshGoogle = await store.completeGoogleSignIn(googleInput);
  assert.equal(freshGoogle.status, 'ok', 'first Google sign-in must return account and session');
  assert.equal(freshGoogle.account.id, googleAccountId);
  assert.equal((await store.findSession(googleSession.tokenHash))?.sessionId, googleSession.id);
  log('first Google sign-in', 'PASS');

  const repeatGoogle = await store.completeGoogleSignIn({ ...googleInput, accountId: randomUUID(), session: session('native') });
  assert.equal(repeatGoogle.status, 'ok');
  assert.equal(repeatGoogle.account.id, googleAccountId);
  const noAutoLink = await store.completeGoogleSignIn({ subject: `other-${suffix}`, email, displayName: null, accountId: randomUUID(), session: session('native'), now: now() });
  assert.equal(noAutoLink.status, 'email_conflict');
  log('Google subject reuse, no email auto-link', 'PASS');

  const googleOnlyResetHash = hash(randomBytes(32));
  assert.equal(await store.issueActionToken(googleAccountId, 'password_reset', googleOnlyResetHash, new Date(Date.now() + 3600e3).toISOString()), false);
  assert.equal(await store.consumePasswordResetToken(googleOnlyResetHash, 'illicit-password-hash', now()), false);
  assert.equal((await store.findAccountById(googleAccountId))?.passwordHash, null);
  log('Google-only account cannot gain password via reset', 'PASS');

  // The reset route sends Google sign-in directions on exactly this shape of lookup.
  const googleLookup = await store.findAccountByEmail(googleEmail);
  assert.equal(googleLookup?.id, googleAccountId);
  assert.equal(googleLookup?.passwordHash, null);
  assert.equal(googleLookup?.deletionState, 'active');
  assert.deepEqual(googleLookup?.providers, ['google']);
  assert.deepEqual((await store.findAccountByEmail(email))?.providers, ['email']);
  log('reset lookup reports a Google-only account by its providers', 'PASS');

  const raceSubject = `race-${suffix}`;
  const raceEmail = `race-${suffix}@example.test`;
  const concurrentGoogle = await Promise.all(Array.from({ length: 8 }, () => store.completeGoogleSignIn({ subject: raceSubject, email: raceEmail, displayName: null, accountId: randomUUID(), session: session('native'), now: now() })));
  assert.ok(concurrentGoogle.every((result) => result.status === 'ok'), `concurrent Google statuses: ${concurrentGoogle.map((result) => result.status).join(',')}`);
  assert.equal(new Set(concurrentGoogle.map((result) => result.account.id)).size, 1);
  const duplicateCount = await pool.query('SELECT count(*)::int AS count FROM kip_account.accounts WHERE normalized_email = $1', [raceEmail]);
  assert.equal(duplicateCount.rows[0].count, 1);
  log('concurrent same-subject Google sign-in', 'PASS');

  const changedSubject = `changed-${suffix}`;
  const competingEmails = [`changed-a-${suffix}@example.test`, `changed-b-${suffix}@example.test`];
  const changed = await Promise.all(competingEmails.map((googleEmail) => store.completeGoogleSignIn({ subject: changedSubject, email: googleEmail, displayName: null, accountId: randomUUID(), session: session('native'), now: now() })));
  assert.ok(changed.every((result) => result.status === 'ok'));
  assert.equal(new Set(changed.map((result) => result.account.id)).size, 1);
  const orphanCount = await pool.query(`SELECT count(*)::int AS count FROM kip_account.accounts a
    WHERE a.normalized_email = ANY($1::text[]) AND NOT EXISTS (SELECT 1 FROM kip_account.google_identities g WHERE g.account_id = a.id)`, [competingEmails]);
  assert.equal(orphanCount.rows[0].count, 0);
  log('concurrent changed-email Google sign-in, no orphan', 'PASS');

  const googleReauth = await store.completeGoogleReauthentication({ subject: googleInput.subject, accountId: googleAccountId, sessionId: googleSession.id, tokenHash: googleSession.tokenHash, now: now() });
  assert.equal(googleReauth, true);
  const linkOwn = await store.completeGoogleLink({ subject: `linked-${suffix}`, email: googleEmail, accountId: googleAccountId, sessionId: googleSession.id, tokenHash: googleSession.tokenHash, now: now() });
  assert.equal(linkOwn, 'ok');
  const linkOther = await store.completeGoogleLink({ subject: googleInput.subject, email: googleEmail, accountId: accountId, sessionId: initialSession.id, tokenHash: initialSession.tokenHash, now: now() });
  assert.notEqual(linkOther, 'ok');
  log('Google reauthentication and explicit link', 'PASS');

  const deletingSession = session();
  const createdForDeletion = await store.createSession(googleAccountId, deletingSession);
  assert.ok(createdForDeletion);
  assert.equal(await store.confirmPasswordReauthentication(googleAccountId, deletingSession.id, deletingSession.tokenHash, now()), true);
  const receiptId = randomUUID();
  assert.equal(await store.beginDeletion(googleAccountId, deletingSession.id, deletingSession.tokenHash, receiptId, now()), receiptId);
  assert.equal((await store.findDeletionReceipt(receiptId))?.status, 'pending');
  assert.equal(await store.findSession(deletingSession.tokenHash), null);
  assert.equal(await store.completeDeletion(receiptId, now()), true);
  assert.equal((await store.findDeletionReceipt(receiptId))?.status, 'complete');
  assert.equal(await store.findAccountById(googleAccountId), null);
  log('deletion transition and receipt', 'PASS');

  const old = new Date(Date.now() - 120 * 86400e3).toISOString();
  const cutoff = new Date(Date.now() - 90 * 86400e3).toISOString();
  const limitCutoff = new Date(Date.now() - 86400e3).toISOString();
  await pool.query('DELETE FROM kip_account.security_events WHERE event_type = $1', ['qa_retention']);
  const oldEventIds = [randomUUID(), randomUUID()];
  for (const id of oldEventIds) {
    await pool.query('INSERT INTO kip_account.security_events (id,event_type,outcome,created_at) VALUES ($1,$2,$3,$4)', [id, 'qa_retention', 'old', old]);
  }
  await pool.query(`INSERT INTO kip_account.sessions (id,account_id,token_hash,csrf_hash,transport,expires_at,absolute_expires_at)
    VALUES ($1,$2,$3,$4,'web',$5,$5)`, [randomUUID(), accountId, hash(randomBytes(32)), hash(randomBytes(32)), old]);
  await pool.query('INSERT INTO kip_account.action_tokens (token_hash,account_id,purpose,expires_at) VALUES ($1,$2,$3,$4)', [hash(randomBytes(32)), accountId, 'verification', old]);
  await pool.query('INSERT INTO kip_account.google_challenges (nonce_hash,purpose,transport,expires_at) VALUES ($1,$2,$3,$4)', [hash(randomBytes(32)), 'sign_in', 'web', old]);
  await pool.query('INSERT INTO kip_account.rate_limits (action,scope_hash,window_started_at,updated_at,attempt_count) VALUES ($1,$2,$3,$3,$4)', ['qa_retention', hash(randomBytes(32)), old, 1]);
  const purged = await store.purgeRetention(now(), cutoff, limitCutoff, 1);
  assert.equal(purged.deleted, 5, 'batch limit applies independently to each retained table');
  assert.equal(purged.remainingExpired, 1, 'second old audit event must be reported as backlog');
  assert.equal((await store.findDeletionReceipt(receiptId))?.status, 'complete', 'retention must preserve deletion receipts');
  const remainingOldEvents = await pool.query('SELECT count(*)::int AS count FROM kip_account.security_events WHERE id = ANY($1::uuid[])', [oldEventIds]);
  assert.equal(remainingOldEvents.rows[0].count, 1);
  log('bounded auth retention, backlog and receipt preservation', 'PASS');
} finally {
  await pool.end();
}
