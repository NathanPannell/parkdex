import assert from "node:assert/strict";
import test from "node:test";
import type { AccountAuthStore } from "./accounts/auth-store.js";
import { archiveDeletesAt, containsPattern, feedbackRetentionCutoff } from "./feedbackArchive.js";
import { createFeedbackWorker, type WorkerEnvironment } from "./index.js";
import type { InteractionStore } from "./interactions.js";

const origin = "https://kip.example.test";
const SECRET = "retention-test-secret-".repeat(4);
const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const env: WorkerEnvironment = { PUBLIC_APP_URL: origin, DATABASE_URL: "postgresql://unused:unused@ep-test.us-west-2.aws.neon.tech/unused", KIP_RETENTION_SECRET: SECRET, EMAIL_MODE: "disabled" };

test("the daily retention run also deletes archived feedback and expired founding photos", async () => {
  const cutoffs: string[] = [];
  const founding: number[] = [];
  const worker = createFeedbackWorker({
    now: () => NOW,
    interactions: { now: () => NOW, createStore: () => ({ purgeExpired: async () => ({ deleted: 3, remainingExpired: 0 }) }) as unknown as InteractionStore },
    auth: { now: () => NOW, createStore: () => ({ purgeRetention: async () => ({ deleted: 1, remainingExpired: 0 }) }) as unknown as AccountAuthStore },
    purgeArchivedFeedback: async (_env, cutoff) => { cutoffs.push(cutoff); return { deleted: 2, remainingExpired: 0 }; },
    purgeFoundingPhotos: async (_env, now) => { founding.push(now); return { deleted: 4, remainingExpired: 1 }; },
  });
  const response = await worker.fetch(new Request(`${origin}/api/retention/interactions/purge`, { method: "POST", headers: { authorization: `Bearer ${SECRET}` } }), env);
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.deleted, 3);
  assert.equal(body.authDeleted, 1);
  assert.equal(body.feedbackDeleted, 2);
  assert.equal(body.feedbackRemainingExpired, 0);
  // The photo Worker's cron reads remainingExpired to decide whether to call again; feedback stays out of it.
  assert.equal(body.remainingExpired, 0);
  assert.deepEqual(cutoffs, ["2026-07-11T12:00:00.000Z"]);
  // Founding photos kept for a manual review ride on the same run and report their own backlog.
  assert.deepEqual([body.foundingPhotosDeleted, body.foundingPhotosRemainingExpired, founding], [4, 1, [NOW]]);
});

test("feedback is not purged without the retention secret", async () => {
  let called = false;
  const worker = createFeedbackWorker({ purgeArchivedFeedback: async () => { called = true; return { deleted: 0, remainingExpired: 0 }; } });
  const response = await worker.fetch(new Request(`${origin}/api/retention/interactions/purge`, { method: "POST", headers: { authorization: "Bearer wrong" } }), env);
  assert.equal(response.status, 401);
  assert.equal(called, false);
});

test("retention dates and archive search patterns", () => {
  assert.equal(feedbackRetentionCutoff(NOW), "2026-07-11T12:00:00.000Z");
  assert.equal(archiveDeletesAt("2026-07-11T12:00:00.000Z"), "2026-10-09T12:00:00.000Z");
  assert.equal(containsPattern("50%_off\\"), "%50\\%\\_off\\\\%");
});
