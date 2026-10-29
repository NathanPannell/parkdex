import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";
import { createNeonAccountAuthStore } from "../worker/accounts/auth-store.ts";
import { applyMigration, dbUrl, pool } from "./qa-postgres-adapter.mjs";

const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const now = () => new Date().toISOString();
const hash = (value) => createHash("sha256").update(value).digest("hex");
const session = (transport = "web") => {
  const t = Date.now();
  return {
    id: randomUUID(),
    tokenHash: hash(randomBytes(32)),
    csrfHash: transport === "web" ? hash(randomBytes(32)) : null,
    transport,
    expiresAt: new Date(t + 30 * 86400e3).toISOString(),
    absoluteExpiresAt: new Date(t + 90 * 86400e3).toISOString(),
  };
};
const store = createNeonAccountAuthStore(dbUrl);
const log = (name, result) => process.stdout.write(`${name}: ${result}\n`);

try {
  const sql = neon(dbUrl);
  const batch = await sql.transaction([sql`SELECT 1::integer AS first`, sql`SELECT 2::integer AS second`], { isolationLevel: "ReadCommitted" });
  assert.equal(batch[0][0].first, 1);
  assert.equal(batch[1][0].second, 2);
  log("Neon transaction batch adapter", "PASS");
  await applyMigration(fileURLToPath(new URL("../database/migrations/accounts_001_init.sql", import.meta.url)));
  await applyMigration(fileURLToPath(new URL("../database/migrations/accounts_002_guests.sql", import.meta.url)));
  await applyMigration(fileURLToPath(new URL("../database/migrations/accounts_003_apple.sql", import.meta.url)));
  // This runner is restricted by qa-postgres-adapter to a dedicated loopback QA
  // database. Clear prior runs before asserting exact retention backlog counts.
  // CASCADE also clears progress claims when that optional migration was applied.
  await pool.query(`TRUNCATE TABLE
    kip_account.accounts,
    kip_account.google_identities,
    kip_account.apple_identities,
    kip_account.sessions,
    kip_account.action_tokens,
    kip_account.google_challenges,
    kip_account.rate_limits,
    kip_account.security_events,
    kip_account.account_deletion_receipts
    CASCADE`);
  if ((await pool.query("SELECT to_regclass('kip_account.account_deletion_photo_objects') AS relation")).rows[0].relation) {
    await pool.query("TRUNCATE TABLE kip_account.account_deletion_photo_objects");
  }
  const accountId = randomUUID();
  const email = `qa-${suffix}@example.test`;
  const initialSession = session();
  const verificationTokenHash = hash(randomBytes(32));
  const registered = await store.createAccount({
    accountId,
    email,
    passwordHash: "qa-hash",
    displayName: "QA user",
    session: initialSession,
    verificationTokenHash,
    verificationExpiresAt: new Date(Date.now() + 3600e3).toISOString(),
  });
  assert.ok(registered, "fresh registration must return account and session");
  assert.equal(registered.account.id, accountId);
  assert.equal(registered.account.email, email);
  assert.equal(registered.sessionId, initialSession.id);
  assert.equal((await store.findSession(initialSession.tokenHash))?.sessionId, initialSession.id);
  log("fresh registration", "PASS");

  assert.equal(await store.consumeVerificationToken(verificationTokenHash, now()), true);
  assert.equal(await store.consumeVerificationToken(verificationTokenHash, now()), false);
  assert.equal((await store.findAccountByEmail(email))?.emailVerified, true);
  log("verification one use", "PASS");

  await pool.query("UPDATE kip_account.sessions SET expires_at = now() + interval '1 day' WHERE id = $1", [initialSession.id]);
  const renewed = session();
  const renewal = await Promise.all([
    store.rotateSession(initialSession.id, initialSession.tokenHash, renewed, now()),
    store.rotateSession(initialSession.id, initialSession.tokenHash, session(), now()),
  ]);
  assert.equal(renewal.filter(Boolean).length, 1);
  assert.equal(await store.findSession(initialSession.tokenHash), null);
  log("concurrent session rotation", "PASS");

  const resetTokenHash = hash(randomBytes(32));
  assert.equal(await store.issueActionToken(accountId, "password_reset", resetTokenHash, new Date(Date.now() + 3600e3).toISOString()), true);
  const reset = await Promise.all([
    store.consumePasswordResetToken(resetTokenHash, "new-hash-1", now()),
    store.consumePasswordResetToken(resetTokenHash, "new-hash-2", now()),
  ]);
  assert.deepEqual(reset.sort(), [false, true]);
  assert.equal(await store.findSession(renewed.tokenHash), null);
  log("concurrent password reset, session revoke", "PASS");

  const googleEmail = `google-${suffix}@example.test`;
  const googleAccountId = randomUUID();
  const googleSession = session("native");
  const googleInput = {
    subject: `google-${suffix}`,
    email: googleEmail,
    displayName: "Google QA",
    accountId: googleAccountId,
    session: googleSession,
    now: now(),
  };
  const freshGoogle = await store.completeGoogleSignIn(googleInput);
  assert.equal(freshGoogle.status, "ok", "first Google sign-in must return account and session");
  assert.equal(freshGoogle.account.id, googleAccountId);
  assert.equal((await store.findSession(googleSession.tokenHash))?.sessionId, googleSession.id);
  log("first Google sign-in", "PASS");

  const repeatGoogle = await store.completeGoogleSignIn({ ...googleInput, accountId: randomUUID(), session: session("native") });
  assert.equal(repeatGoogle.status, "ok");
  assert.equal(repeatGoogle.account.id, googleAccountId);
  const noAutoLink = await store.completeGoogleSignIn({
    subject: `other-${suffix}`,
    email,
    displayName: null,
    accountId: randomUUID(),
    session: session("native"),
    now: now(),
  });
  assert.equal(noAutoLink.status, "email_conflict");
  log("Google subject reuse, no email auto-link", "PASS");

  // Sign in with Apple: same shape as Google, its own identity table, an optional email.
  const appleEmail = `apple-${suffix}@privaterelay.appleid.com`;
  const appleAccountId = randomUUID();
  const appleInput = {
    subject: `apple-${suffix}`,
    email: appleEmail,
    displayName: "Apple QA",
    accountId: appleAccountId,
    session: session("native"),
    now: now(),
  };
  const freshApple = await store.completeAppleSignIn(appleInput);
  assert.equal(freshApple.status, "ok");
  assert.equal(freshApple.account.id, appleAccountId);
  assert.deepEqual(freshApple.account.providers, ["apple"]);
  assert.equal(freshApple.account.guest, false);
  const repeatApple = await store.completeAppleSignIn({ ...appleInput, email: null, accountId: randomUUID(), session: session("native") });
  assert.equal(repeatApple.status, "ok", "a later sign-in without an email finds the account by subject");
  assert.equal(repeatApple.account.id, appleAccountId);
  const noEmail = await store.completeAppleSignIn({
    ...appleInput,
    subject: `apple-none-${suffix}`,
    email: null,
    accountId: randomUUID(),
    session: session("native"),
  });
  assert.equal(noEmail.status, "email_required");
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM kip_account.accounts WHERE normalized_email IS NULL AND display_name = 'Apple QA'")).rows[0].n,
    0,
  );
  const appleCollision = await store.completeAppleSignIn({
    ...appleInput,
    subject: `apple-collide-${suffix}`,
    email,
    accountId: randomUUID(),
    session: session("native"),
  });
  assert.equal(appleCollision.status, "email_conflict");
  // A Google subject equal to an Apple subject is a different identity.
  const sameSubjectGoogle = await store.completeGoogleSignIn({
    ...appleInput,
    email: `apple-google-${suffix}@example.test`,
    accountId: randomUUID(),
    session: session("native"),
  });
  assert.equal(sameSubjectGoogle.status, "ok");
  assert.notEqual(sameSubjectGoogle.account.id, appleAccountId);
  log("first Apple sign-in, subject reuse, email required, no auto-link", "PASS");

  const appleSession = appleInput.session;
  assert.equal(
    await store.completeAppleReauthentication({
      subject: appleInput.subject,
      accountId: appleAccountId,
      sessionId: appleSession.id,
      tokenHash: appleSession.tokenHash,
      now: now(),
    }),
    true,
  );
  assert.equal(
    await store.completeAppleReauthentication({
      subject: `apple-other-${suffix}`,
      accountId: appleAccountId,
      sessionId: appleSession.id,
      tokenHash: appleSession.tokenHash,
      now: now(),
    }),
    false,
  );
  assert.equal(
    await store.completeGoogleReauthentication({
      subject: appleInput.subject,
      accountId: appleAccountId,
      sessionId: appleSession.id,
      tokenHash: appleSession.tokenHash,
      now: now(),
    }),
    false,
    "an Apple subject never reauthenticates through Google",
  );
  const appleLinksGoogle = await store.completeGoogleLink({
    subject: `apple-then-google-${suffix}`,
    email: `apple-then-google-${suffix}@example.test`,
    accountId: appleAccountId,
    sessionId: appleSession.id,
    tokenHash: appleSession.tokenHash,
    now: now(),
  });
  assert.equal(appleLinksGoogle, "ok");
  assert.deepEqual((await store.findAccountById(appleAccountId))?.providers, ["apple", "google"]);
  assert.equal((await store.findAccountById(appleAccountId))?.email, appleEmail, "linking Google keeps the account email");
  log("Apple reauthentication and Apple account linking Google", "PASS");

  assert.equal(await store.saveAppleRefreshToken({ subject: appleInput.subject, accountId: appleAccountId, ciphertext: "v1.iv.ct.tag", now: now() }), true);
  assert.equal(await store.saveAppleRefreshToken({ subject: appleInput.subject, accountId: randomUUID(), ciphertext: "v1.x.y.z", now: now() }), false);
  assert.deepEqual(await store.appleRefreshTokens(appleAccountId), [{ subject: appleInput.subject, ciphertext: "v1.iv.ct.tag" }]);
  const appleReceipt = randomUUID();
  assert.equal(await store.beginDeletion(appleAccountId, appleSession.id, appleSession.tokenHash, appleReceipt, now()), appleReceipt);
  assert.deepEqual(
    await store.appleRefreshTokens(appleAccountId),
    [{ subject: appleInput.subject, ciphertext: "v1.iv.ct.tag" }],
    "tokens stay readable while the deletion is pending",
  );
  assert.equal(await store.completeDeletion(appleReceipt, now()), true);
  assert.deepEqual(await store.appleRefreshTokens(appleAccountId), []);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM kip_account.apple_identities WHERE subject = $1", [appleInput.subject])).rows[0].n, 0);
  log("Apple refresh token kept until the account is deleted", "PASS");

  const appleChallenge = hash(randomBytes(32));
  await store.createGoogleChallenge({
    provider: "apple",
    nonceHash: appleChallenge,
    purpose: "sign_in",
    transport: "native",
    accountId: null,
    sessionId: null,
    expiresAt: new Date(Date.now() + 300e3).toISOString(),
  });
  assert.equal((await store.consumeGoogleChallenge(appleChallenge, now()))?.provider, "apple");
  log("Apple challenge records its provider", "PASS");

  const googleOnlyResetHash = hash(randomBytes(32));
  assert.equal(await store.issueActionToken(googleAccountId, "password_reset", googleOnlyResetHash, new Date(Date.now() + 3600e3).toISOString()), false);
  assert.equal(await store.consumePasswordResetToken(googleOnlyResetHash, "illicit-password-hash", now()), false);
  assert.equal((await store.findAccountById(googleAccountId))?.passwordHash, null);
  log("Google-only account cannot gain password via reset", "PASS");

  // The reset route sends Google sign-in directions on exactly this shape of lookup.
  const googleLookup = await store.findAccountByEmail(googleEmail);
  assert.equal(googleLookup?.id, googleAccountId);
  assert.equal(googleLookup?.passwordHash, null);
  assert.equal(googleLookup?.deletionState, "active");
  assert.deepEqual(googleLookup?.providers, ["google"]);
  assert.deepEqual((await store.findAccountByEmail(email))?.providers, ["email"]);
  log("reset lookup reports a Google-only account by its providers", "PASS");

  const raceSubject = `race-${suffix}`;
  const raceEmail = `race-${suffix}@example.test`;
  const concurrentGoogle = await Promise.all(
    Array.from({ length: 8 }, () =>
      store.completeGoogleSignIn({
        subject: raceSubject,
        email: raceEmail,
        displayName: null,
        accountId: randomUUID(),
        session: session("native"),
        now: now(),
      }),
    ),
  );
  assert.ok(
    concurrentGoogle.every((result) => result.status === "ok"),
    `concurrent Google statuses: ${concurrentGoogle.map((result) => result.status).join(",")}`,
  );
  assert.equal(new Set(concurrentGoogle.map((result) => result.account.id)).size, 1);
  const duplicateCount = await pool.query("SELECT count(*)::int AS count FROM kip_account.accounts WHERE normalized_email = $1", [raceEmail]);
  assert.equal(duplicateCount.rows[0].count, 1);
  log("concurrent same-subject Google sign-in", "PASS");

  const changedSubject = `changed-${suffix}`;
  const competingEmails = [`changed-a-${suffix}@example.test`, `changed-b-${suffix}@example.test`];
  const changed = await Promise.all(
    competingEmails.map((googleEmail) =>
      store.completeGoogleSignIn({
        subject: changedSubject,
        email: googleEmail,
        displayName: null,
        accountId: randomUUID(),
        session: session("native"),
        now: now(),
      }),
    ),
  );
  assert.ok(changed.every((result) => result.status === "ok"));
  assert.equal(new Set(changed.map((result) => result.account.id)).size, 1);
  const orphanCount = await pool.query(
    `SELECT count(*)::int AS count FROM kip_account.accounts a
    WHERE a.normalized_email = ANY($1::text[]) AND NOT EXISTS (SELECT 1 FROM kip_account.google_identities g WHERE g.account_id = a.id)`,
    [competingEmails],
  );
  assert.equal(orphanCount.rows[0].count, 0);
  log("concurrent changed-email Google sign-in, no orphan", "PASS");

  const googleReauth = await store.completeGoogleReauthentication({
    subject: googleInput.subject,
    accountId: googleAccountId,
    sessionId: googleSession.id,
    tokenHash: googleSession.tokenHash,
    now: now(),
  });
  assert.equal(googleReauth, true);
  const linkOwn = await store.completeGoogleLink({
    subject: `linked-${suffix}`,
    email: googleEmail,
    accountId: googleAccountId,
    sessionId: googleSession.id,
    tokenHash: googleSession.tokenHash,
    now: now(),
  });
  assert.equal(linkOwn, "ok");
  const linkOther = await store.completeGoogleLink({
    subject: googleInput.subject,
    email: googleEmail,
    accountId: accountId,
    sessionId: initialSession.id,
    tokenHash: initialSession.tokenHash,
    now: now(),
  });
  assert.notEqual(linkOther, "ok");
  log("Google reauthentication and explicit link", "PASS");

  const deletingSession = session();
  const createdForDeletion = await store.createSession(googleAccountId, deletingSession);
  assert.ok(createdForDeletion);
  assert.equal(await store.confirmPasswordReauthentication(googleAccountId, deletingSession.id, deletingSession.tokenHash, now()), true);
  const receiptId = randomUUID();
  assert.equal(await store.beginDeletion(googleAccountId, deletingSession.id, deletingSession.tokenHash, receiptId, now()), receiptId);
  assert.equal((await store.findDeletionReceipt(receiptId))?.status, "pending");
  assert.equal(await store.findSession(deletingSession.tokenHash), null);
  assert.equal(await store.completeDeletion(receiptId, now()), true);
  assert.equal((await store.findDeletionReceipt(receiptId))?.status, "complete");
  assert.equal(await store.findAccountById(googleAccountId), null);
  log("deletion transition and receipt", "PASS");

  const old = new Date(Date.now() - 120 * 86400e3).toISOString();
  const cutoff = new Date(Date.now() - 90 * 86400e3).toISOString();
  const limitCutoff = new Date(Date.now() - 86400e3).toISOString();
  await pool.query("DELETE FROM kip_account.security_events WHERE event_type = $1", ["qa_retention"]);
  const oldEventIds = [randomUUID(), randomUUID()];
  for (const id of oldEventIds) {
    await pool.query("INSERT INTO kip_account.security_events (id,event_type,outcome,created_at) VALUES ($1,$2,$3,$4)", [id, "qa_retention", "old", old]);
  }
  await pool.query(
    `INSERT INTO kip_account.sessions (id,account_id,token_hash,csrf_hash,transport,expires_at,absolute_expires_at)
    VALUES ($1,$2,$3,$4,'web',$5,$5)`,
    [randomUUID(), accountId, hash(randomBytes(32)), hash(randomBytes(32)), old],
  );
  await pool.query("INSERT INTO kip_account.action_tokens (token_hash,account_id,purpose,expires_at) VALUES ($1,$2,$3,$4)", [
    hash(randomBytes(32)),
    accountId,
    "verification",
    old,
  ]);
  await pool.query("INSERT INTO kip_account.google_challenges (nonce_hash,purpose,transport,expires_at) VALUES ($1,$2,$3,$4)", [
    hash(randomBytes(32)),
    "sign_in",
    "web",
    old,
  ]);
  await pool.query("INSERT INTO kip_account.rate_limits (action,scope_hash,window_started_at,updated_at,attempt_count) VALUES ($1,$2,$3,$3,$4)", [
    "qa_retention",
    hash(randomBytes(32)),
    old,
    1,
  ]);
  const purged = await store.purgeRetention(now(), cutoff, limitCutoff, 1);
  assert.equal(purged.deleted, 5, "batch limit applies independently to each retained table");
  assert.equal(purged.remainingExpired, 1, "second old audit event must be reported as backlog");
  assert.equal((await store.findDeletionReceipt(receiptId))?.status, "complete", "retention must preserve deletion receipts");
  const remainingOldEvents = await pool.query("SELECT count(*)::int AS count FROM kip_account.security_events WHERE id = ANY($1::uuid[])", [oldEventIds]);
  assert.equal(remainingOldEvents.rows[0].count, 1);
  log("bounded auth retention, backlog and receipt preservation", "PASS");

  // Guest accounts: no email until Google upgrades them in place.
  const guestId = randomUUID();
  // 65 days into a 365-day guest session.
  const guestSession = {
    ...session("native"),
    expiresAt: new Date(Date.now() + 300 * 86400e3).toISOString(),
    absoluteExpiresAt: new Date(Date.now() + 3650 * 86400e3).toISOString(),
  };
  const guest = await store.createGuestAccount(guestId, guestSession);
  assert.equal(guest?.account.guest, true);
  assert.equal(guest?.account.email, "");
  assert.deepEqual(guest?.account.providers, []);
  const secondGuest = await store.createGuestAccount(randomUUID(), session("native"));
  assert.equal(secondGuest?.account.guest, true, "several guests share the absent email");
  assert.equal((await store.findSession(guestSession.tokenHash))?.guest, true);
  const tooEarly = { ...session("native"), expiresAt: new Date(Date.now() + 365 * 86400e3).toISOString() };
  assert.equal(await store.rotateSession(guestSession.id, guestSession.tokenHash, tooEarly, now()), null, "the default window waits for the last week");
  const guestRenewal = { ...session("native"), expiresAt: new Date(Date.now() + 365 * 86400e3).toISOString() };
  assert.ok(await store.rotateSession(guestSession.id, guestSession.tokenHash, guestRenewal, now(), 335 * 86400e3));
  log("guest account and session renewal", "PASS");

  const takenEmail = await store.completeGoogleLink({
    subject: `qa-guest-taken-${suffix}`,
    email,
    accountId: guestId,
    sessionId: guestSession.id,
    tokenHash: guestRenewal.tokenHash,
    now: now(),
  });
  assert.equal(takenEmail, "email_conflict");
  const guestEmail = `qa-guest-${suffix}@example.test`;
  const upgraded = await store.completeGoogleLink({
    subject: `qa-guest-${suffix}`,
    email: guestEmail,
    accountId: guestId,
    sessionId: guestSession.id,
    tokenHash: guestRenewal.tokenHash,
    now: now(),
  });
  assert.equal(upgraded, "ok", "a guest links Google without reauthenticating");
  const upgradedAccount = await store.findAccountById(guestId);
  assert.equal(upgradedAccount?.guest, false);
  assert.equal(upgradedAccount?.email, guestEmail);
  assert.equal(upgradedAccount?.emailVerified, true);
  assert.deepEqual(upgradedAccount?.providers, ["google"]);
  const shortened = await pool.query("SELECT expires_at, absolute_expires_at FROM kip_account.sessions WHERE id = $1", [guestSession.id]);
  assert.ok(shortened.rows[0].absolute_expires_at.getTime() <= Date.now() + 91 * 86400e3, "an upgraded guest's session is capped like an account's");
  assert.ok(shortened.rows[0].expires_at.getTime() <= Date.now() + 31 * 86400e3);
  log("guest upgraded in place by Google", "PASS");

  const appleGuestId = randomUUID();
  const appleGuestSession = session("native");
  await store.createGuestAccount(appleGuestId, appleGuestSession);
  const appleGuestLink = {
    subject: `apple-guest-${suffix}`,
    accountId: appleGuestId,
    sessionId: appleGuestSession.id,
    tokenHash: appleGuestSession.tokenHash,
    now: now(),
  };
  assert.equal(await store.completeAppleLink({ ...appleGuestLink, email: null }), "email_required", "a guest needs an email to become an account");
  assert.equal((await store.findAccountById(appleGuestId))?.guest, true);
  assert.equal(await store.completeAppleLink({ ...appleGuestLink, email: `apple-guest-${suffix}@privaterelay.appleid.com` }), "ok");
  const appleGuest = await store.findAccountById(appleGuestId);
  assert.equal(appleGuest?.guest, false);
  assert.deepEqual(appleGuest?.providers, ["apple"]);
  log("guest upgraded in place by Apple, never without an email", "PASS");

  const doomedGuestId = randomUUID();
  const doomedSession = session("native");
  await store.createGuestAccount(doomedGuestId, doomedSession);
  const guestReceipt = randomUUID();
  assert.equal(await store.beginDeletion(doomedGuestId, doomedSession.id, doomedSession.tokenHash, guestReceipt, now()), guestReceipt);
  log("guest deletion without reauthentication", "PASS");

  // Abandoned guests: no live session and nothing recent for 30 days.
  const day = 86400e3;
  const ago = (days) => new Date(Date.now() - days * day).toISOString();
  const makeGuest = async (sessionExpiresDaysAgo) => {
    const id = randomUUID();
    const s = {
      ...session("native"),
      expiresAt: new Date(Date.now() + 365 * day).toISOString(),
      absoluteExpiresAt: new Date(Date.now() + 3650 * day).toISOString(),
    };
    await store.createGuestAccount(id, s);
    await pool.query("UPDATE kip_account.accounts SET created_at = $2 WHERE id = $1", [id, ago(60)]);
    if (sessionExpiresDaysAgo !== null) await pool.query("UPDATE kip_account.sessions SET expires_at = $2 WHERE id = $1", [s.id, ago(sessionExpiresDaysAgo)]);
    return id;
  };
  const abandonedGuest = await makeGuest(40);
  const liveGuest = await makeGuest(null);
  const recentGuest = await makeGuest(10);
  // Left (signed out) 10 days ago: its session was revoked recently even though it would have expired long ago.
  const leftRecently = await makeGuest(40);
  await pool.query("UPDATE kip_account.sessions SET revoked_at = $2 WHERE account_id = $1", [leftRecently, ago(10)]);
  const sessionlessGuest = randomUUID();
  await store.createGuestAccount(sessionlessGuest, session("native"));
  await pool.query("DELETE FROM kip_account.sessions WHERE account_id = $1", [sessionlessGuest]);
  await pool.query("UPDATE kip_account.accounts SET created_at = $2 WHERE id = $1", [sessionlessGuest, ago(60)]);
  const newSessionless = randomUUID();
  await store.createGuestAccount(newSessionless, session("native"));
  await pool.query("DELETE FROM kip_account.sessions WHERE account_id = $1", [newSessionless]);
  await pool.query("UPDATE kip_account.accounts SET created_at = $2 WHERE id = $1", [accountId, ago(60)]);

  const abandonedReceipts = await store.markAbandonedGuestsForDeletion(ago(30), now(), 50);
  assert.equal(abandonedReceipts.length, 2, "the expired guest and the sessionless old guest");
  const markedIds = (
    await pool.query("SELECT account_id::text AS id FROM kip_account.account_deletion_receipts WHERE receipt_id = ANY($1::uuid[])", [abandonedReceipts])
  ).rows
    .map((row) => row.id)
    .sort();
  assert.deepEqual(markedIds, [abandonedGuest, sessionlessGuest].sort());
  for (const kept of [liveGuest, recentGuest, leftRecently, newSessionless, accountId]) {
    assert.equal((await store.findAccountById(kept))?.deletionState, "active", "live, recent, new and emailed accounts stay");
  }
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM kip_account.sessions WHERE account_id = $1 AND revoked_at IS NULL", [abandonedGuest])).rows[0].n,
    0,
  );
  // An earlier guest deletion above is still pending too; both are picked up for resuming.
  const pendingBefore = await store.pendingGuestDeletionReceipts(50);
  for (const receipt of abandonedReceipts) assert.ok(pendingBefore.includes(receipt));
  assert.deepEqual(await store.markAbandonedGuestsForDeletion(ago(30), now(), 50), [], "a guest already being deleted isn't marked twice");
  for (const receipt of abandonedReceipts) assert.equal(await store.completeDeletion(receipt, now()), true);
  assert.equal(await store.findAccountById(abandonedGuest), null);
  const pendingAfter = await store.pendingGuestDeletionReceipts(50);
  for (const receipt of abandonedReceipts) assert.ok(!pendingAfter.includes(receipt));
  log("abandoned guests marked, kept and deleted", "PASS");
} finally {
  await pool.end();
}
