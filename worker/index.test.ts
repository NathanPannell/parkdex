import assert from "node:assert/strict";
import { test } from "node:test";
import { createFeedbackWorker } from "./index.ts";
import { sendEmail, type DeliveryDependencies } from "./feedbackDelivery.ts";
import type {
  AttachmentRecord,
  ClaimedEmail,
  EmailDeliveryView,
  FeedbackCursor,
  FeedbackStore,
  MailIntent,
  OperatorFeedbackRecord,
  SaveFeedbackArgs,
  SaveFeedbackResult,
} from "./store.ts";
import type { EmailAudience, FeedbackStatus } from "./validation.ts";

const API_ORIGIN = "https://api.example.test";
const SECRET = "test-session-secret-which-is-long-enough";
const SUBMISSION_ID = "2d34f95a-9806-4cb7-8a80-85205d06373f";
const REPORT_ID = "38a41a12-ec77-4ac1-9d68-c14165d397ac";

type StoredDelivery = EmailDeliveryView & {
  recipient: string;
  payload: MailIntent["payload"];
  idempotencyKey: string;
  leaseToken: string | null;
  leaseUntil: number | null;
};

class MemoryStore implements FeedbackStore {
  private readonly reports = new Map<string, OperatorFeedbackRecord>();
  private readonly payloadHashes = new Map<string, string>();
  private readonly submissionIds = new Map<string, string>();
  private readonly attachments = new Map<string, AttachmentRecord>();
  private readonly deliveries = new Map<string, Map<EmailAudience, StoredDelivery>>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly ipCounts = new Map<string, number>();
  private readonly recipientCounts = new Map<string, number>();
  private loginCount = 0;
  private readonly now: () => number;
  failNextFinishAudience: EmailAudience | null = null;

  constructor(now: () => number) {
    this.now = now;
  }

  private async withSubmissionLock<T>(submissionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(submissionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(
      submissionId,
      previous.then(() => gate),
    );
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  async findBySubmissionId(submissionId: string) {
    const id = this.submissionIds.get(submissionId);
    if (!id) return null;
    return { id, payloadHash: this.payloadHashes.get(id)! };
  }

  async saveFeedback(args: SaveFeedbackArgs): Promise<SaveFeedbackResult> {
    return this.withSubmissionLock(args.feedback.submissionId, async () => {
      const existing = await this.findBySubmissionId(args.feedback.submissionId);
      if (existing) {
        if (existing.payloadHash !== args.payloadHash) return { status: "conflict" };
        const report = await this.getReport(existing.id);
        return report ? { status: "duplicate", report } : { status: "conflict" };
      }
      const ipCount = (this.ipCounts.get(args.ipHash) ?? 0) + 1;
      const recipientCount = args.recipientHash ? (this.recipientCounts.get(args.recipientHash) ?? 0) + 1 : 0;
      this.ipCounts.set(args.ipHash, ipCount);
      if (args.recipientHash) this.recipientCounts.set(args.recipientHash, recipientCount);
      if (ipCount > 20 || recipientCount > 5) return { status: "rate_limited" };
      const feedback = args.feedback;
      const record: OperatorFeedbackRecord = {
        id: args.id,
        submissionId: feedback.submissionId,
        kind: feedback.kind,
        message: feedback.message,
        email: feedback.email,
        contact: feedback.contact,
        context: structuredClone(feedback.context),
        createdAt: args.createdAt,
        hasScreenshot: feedback.screenshot !== null,
        status: "new",
        emails: args.mails.map((mail) => ({
          audience: mail.audience,
          status: mail.initialStatus,
          attempts: 0,
          lastAttemptAt: null,
          sentAt: null,
          providerMessageId: null,
          lastError: mail.initialError,
          canRetry: mail.initialStatus === "pending" || mail.initialStatus === "failed",
          requiresConfirmation: false,
        })),
        screenshot: feedback.screenshot ? { contentType: feedback.screenshot.contentType, size: feedback.screenshot.bytes.byteLength } : null,
      };
      this.reports.set(record.id, record);
      this.payloadHashes.set(record.id, args.payloadHash);
      this.submissionIds.set(feedback.submissionId, record.id);
      if (feedback.screenshot)
        this.attachments.set(record.id, {
          contentType: feedback.screenshot.contentType,
          size: feedback.screenshot.bytes.byteLength,
          base64: feedback.screenshot.base64,
        });
      this.deliveries.set(
        record.id,
        new Map(
          args.mails.map(
            (mail) =>
              [
                mail.audience,
                {
                  audience: mail.audience,
                  status: mail.initialStatus,
                  attempts: 0,
                  lastAttemptAt: null,
                  sentAt: null,
                  providerMessageId: null,
                  lastError: mail.initialError,
                  canRetry: mail.initialStatus === "pending" || mail.initialStatus === "failed",
                  requiresConfirmation: false,
                  recipient: mail.recipient,
                  payload: structuredClone(mail.payload),
                  idempotencyKey: mail.idempotencyKey,
                  leaseToken: null,
                  leaseUntil: null,
                },
              ] as const,
          ),
        ),
      );
      return { status: "saved", report: structuredClone(record) };
    });
  }

  async getReport(id: string): Promise<OperatorFeedbackRecord | null> {
    const report = this.reports.get(id);
    if (!report) return null;
    const copy = structuredClone(report);
    copy.emails = await Promise.all(Array.from(this.deliveries.get(id)?.values() ?? []).map((delivery) => this.emailView(delivery)));
    return copy;
  }

  private async emailView(delivery: StoredDelivery): Promise<EmailDeliveryView> {
    const age = delivery.lastAttemptAt ? this.now() - Date.parse(delivery.lastAttemptAt) : 0;
    const leaseExpired = delivery.leaseUntil !== null && delivery.leaseUntil <= this.now();
    return {
      audience: delivery.audience,
      status: delivery.status,
      attempts: delivery.attempts,
      lastAttemptAt: delivery.lastAttemptAt,
      sentAt: delivery.sentAt,
      providerMessageId: delivery.providerMessageId,
      lastError: delivery.lastError,
      canRetry:
        delivery.status === "pending" ||
        delivery.status === "failed" ||
        ((delivery.status === "ambiguous" || delivery.status === "sending") && leaseExpiredOrRecent(leaseExpired, age)),
      requiresConfirmation: (delivery.status === "ambiguous" || delivery.status === "sending") && leaseExpired && age >= 24 * 60 * 60 * 1000,
    };
  }

  async listReports(limit: number, status: FeedbackStatus | null, cursor: FeedbackCursor | null): Promise<OperatorFeedbackRecord[]> {
    const all = [...this.reports.values()]
      .filter((report) => status === null || report.status === status)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
      .filter((report) => !cursor || report.createdAt < cursor.createdAt || (report.createdAt === cursor.createdAt && report.id < cursor.id));
    const reports = await Promise.all(all.slice(0, limit).map((report) => this.getReport(report.id)));
    return reports.filter((report): report is OperatorFeedbackRecord => report !== null);
  }

  async getAttachment(id: string): Promise<AttachmentRecord | null> {
    const attachment = this.attachments.get(id);
    return attachment ? structuredClone(attachment) : null;
  }

  async updateStatus(id: string, status: FeedbackStatus): Promise<OperatorFeedbackRecord | null> {
    const report = this.reports.get(id);
    if (!report) return null;
    report.status = status;
    return this.getReport(id);
  }

  async getEmailDelivery(id: string, audience: EmailAudience): Promise<EmailDeliveryView | null> {
    const delivery = this.deliveries.get(id)?.get(audience);
    return delivery ? this.emailView(delivery) : null;
  }

  async claimEmail(id: string, audience: EmailAudience, leaseToken: string, confirmAmbiguousAfter24h: boolean) {
    const delivery = this.deliveries.get(id)?.get(audience);
    if (!delivery) return { status: "missing" as const };
    const age = delivery.lastAttemptAt ? this.now() - Date.parse(delivery.lastAttemptAt) : 0;
    if (delivery.status === "sending" && delivery.leaseUntil !== null && delivery.leaseUntil <= this.now()) {
      if (age >= 24 * 60 * 60 * 1000) {
        delivery.status = "ambiguous";
        delivery.leaseToken = null;
        delivery.leaseUntil = null;
        delivery.lastError = "Email outcome is unknown after the provider idempotency window.";
      }
    }
    if (delivery.status === "sent" || delivery.status === "disabled") return { status: delivery.status };
    if (delivery.status === "sending") return { status: "sending" as const };
    if (delivery.status === "ambiguous" && age >= 24 * 60 * 60 * 1000 && !confirmAmbiguousAfter24h) return { status: "ambiguous" as const };
    if (delivery.status !== "pending" && delivery.status !== "failed" && delivery.status !== "ambiguous") return { status: delivery.status };
    if (age >= 24 * 60 * 60 * 1000 && (delivery.status === "failed" || delivery.status === "ambiguous")) {
      delivery.idempotencyKey = `feedback-${id}-${audience}-attempt-${delivery.attempts + 1}`;
    }
    delivery.status = "sending";
    delivery.leaseToken = leaseToken;
    delivery.leaseUntil = this.now() + 90_000;
    delivery.attempts += 1;
    delivery.lastAttemptAt = new Date(this.now()).toISOString();
    delivery.lastError = null;
    const email: ClaimedEmail = {
      audience,
      recipient: delivery.recipient,
      payload: structuredClone(delivery.payload),
      idempotencyKey: delivery.idempotencyKey,
      initialStatus: "pending",
      initialError: null,
      attempts: delivery.attempts,
    };
    return { status: "claimed" as const, email };
  }

  async markEmailDisabled(id: string, audience: EmailAudience): Promise<void> {
    const delivery = this.deliveries.get(id)?.get(audience);
    if (delivery && (delivery.status === "pending" || delivery.status === "failed")) {
      delivery.status = "disabled";
      delivery.lastError = null;
    }
  }

  async finishEmail(
    id: string,
    audience: EmailAudience,
    leaseToken: string,
    state: "sent" | "failed" | "ambiguous",
    error: string | null,
    providerMessageId: string | null = null,
  ): Promise<void> {
    const delivery = this.deliveries.get(id)?.get(audience);
    if (this.failNextFinishAudience === audience) {
      this.failNextFinishAudience = null;
      throw new Error("simulated database status-write failure");
    }
    if (!delivery || delivery.status !== "sending" || delivery.leaseToken !== leaseToken) return;
    delivery.status = state;
    delivery.lastError = error;
    delivery.sentAt = state === "sent" ? new Date(this.now()).toISOString() : delivery.sentAt;
    delivery.providerMessageId = state === "sent" ? providerMessageId : delivery.providerMessageId;
    delivery.leaseToken = null;
    delivery.leaseUntil = null;
  }

  async consumeLoginRateLimit(): Promise<boolean> {
    this.loginCount += 1;
    return this.loginCount <= 8;
  }

  seed(record: OperatorFeedbackRecord) {
    this.reports.set(record.id, structuredClone(record));
    this.submissionIds.set(record.submissionId, record.id);
    this.deliveries.set(record.id, new Map());
  }

  getDelivery(id: string, audience: EmailAudience): StoredDelivery | undefined {
    return this.deliveries.get(id)?.get(audience);
  }
}

function leaseExpiredOrRecent(leaseExpired: boolean, age: number): boolean {
  return leaseExpired && age < 24 * 60 * 60 * 1000;
}

function responseBody(response: Response): Promise<Record<string, any>> {
  return response.json() as Promise<Record<string, any>>;
}

function newUuidFactory() {
  let count = 100;
  return () => `00000000-0000-4000-8000-${String(count++).padStart(12, "0")}`;
}

function requestBody(overrides: Record<string, unknown> = {}) {
  return {
    submissionId: SUBMISSION_ID,
    kind: "bug",
    message: "The claim button stays open after it saves.",
    email: null,
    contact: false,
    screenshot: null,
    context: { version: "0.1.0", build: "test", platform: "web", screen: "Map", parkId: null, parkName: null },
    ...overrides,
  };
}

function makeRequest(
  path = "/api/feedback",
  body?: unknown,
  options: { method?: string; origin?: string | null; cookie?: string; ip?: string; raw?: string } = {},
) {
  const headers = new Headers({ "cf-connecting-ip": options.ip ?? "203.0.113.7" });
  if (options.origin !== null) headers.set("origin", options.origin ?? API_ORIGIN);
  if (options.cookie) headers.set("cookie", options.cookie);
  if (body !== undefined || options.raw !== undefined) headers.set("content-type", "application/json");
  return new Request(new URL(path, API_ORIGIN), {
    method: options.method ?? (body === undefined && options.raw === undefined ? "GET" : "POST"),
    headers,
    body: options.raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
}

function testEnvironment(overrides: Record<string, unknown> = {}) {
  return {
    SESSION_SECRET: SECRET,
    OPERATOR_EMAIL: "ops@example.test",
    EMAIL_FROM: "Parkdex Feedback <feedback@example.test>",
    EMAIL_REPLY_TO: "parkdex@example.test",
    RESEND_API_KEY: "re_test_key",
    EMAIL_MODE: "resend" as const,
    PUBLIC_APP_URL: API_ORIGIN,
    RELEASE_SHA: "abc123",
    ALLOWED_ORIGINS: "https://evil.example.test",
    ...overrides,
  };
}

async function requestFeedback(worker: ReturnType<typeof createFeedbackWorker>, env: ReturnType<typeof testEnvironment>, body = requestBody()) {
  return worker.fetch(makeRequest("/api/feedback", body), env as never);
}

test("valid feedback commits a screenshot and sends independent operator and receipt mail snapshots", async () => {
  const now = Date.now();
  const store = new MemoryStore(() => now);
  const calls: Array<{ payload: any; key: string; redirect: string | undefined }> = [];
  const worker = createFeedbackWorker({
    createStore: () => store,
    now: () => now,
    uuid: newUuidFactory(),
    fetch: async (_input, init) => {
      calls.push({
        payload: JSON.parse(String(init?.body)),
        key: new Headers(init?.headers).get("idempotency-key")!,
        redirect: init?.redirect,
      });
      return new Response('{"id":"email-1"}', { status: 200 });
    },
  });
  const env = testEnvironment();
  const response = await requestFeedback(
    worker,
    env,
    requestBody({
      email: "person@example.test",
      contact: false,
      screenshot: "data:image/png;base64,iVBORw0KGgo=",
    }),
  );
  const body = await responseBody(response);
  assert.equal(response.status, 201);
  assert.equal(body.id, REPORT_ID.replace("38a41a12-ec77-4ac1-9d68-c14165d397ac", "00000000-0000-4000-8000-000000000100"));
  assert.equal(body.notification.operator, "sent");
  assert.equal(body.notification.receipt, "sent");
  assert.equal(store.getDelivery(body.id, "operator")?.providerMessageId, "email-1");
  assert.equal(store.getDelivery(body.id, "receipt")?.providerMessageId, "email-1");
  assert.equal(calls.length, 2, "a supplied email gets a receipt even without follow-up consent");
  const operator = calls.find((call) => call.payload.to[0] === "ops@example.test")!;
  const receipt = calls.find((call) => call.payload.to[0] === "person@example.test")!;
  assert.equal(operator.payload.reply_to, "parkdex@example.test");
  assert.equal(receipt.payload.reply_to, "parkdex@example.test");
  assert.equal(operator.redirect, "manual");
  assert.equal(receipt.redirect, "manual");
  assert.equal(store.getDelivery(body.id, "operator")?.status, "sent");
  const record = await store.getReport(body.id);
  assert.equal(record?.hasScreenshot, true);
  assert.equal((await store.getAttachment(body.id))?.contentType, "image/png");
  assert.equal(record?.emails.find((email: EmailDeliveryView) => email.audience === "operator")?.providerMessageId, "email-1");
});

test("invalid feedback and image magic are rejected before creating a store", async () => {
  let storeCreations = 0;
  const worker = createFeedbackWorker({
    createStore: () => {
      storeCreations += 1;
      return new MemoryStore(Date.now);
    },
  });
  const env = testEnvironment();
  const invalidEmail = await requestFeedback(worker, env, requestBody({ email: "bad", contact: true }));
  assert.equal(invalidEmail.status, 400);
  assert.equal((await responseBody(invalidEmail)).message, "Enter a valid email address.");
  const invalidImage = await requestFeedback(worker, env, requestBody({ screenshot: "data:image/png;base64,AAAA" }));
  assert.equal(invalidImage.status, 400);
  const oversized = await requestFeedback(worker, env, requestBody({ screenshot: `data:image/png;base64,${"A".repeat(2_800_000)}` }));
  assert.equal(oversized.status, 400);
  assert.equal(storeCreations, 0);
});

test("a persistence failure returns a sanitized error and never calls the email provider", async () => {
  const store = new MemoryStore(Date.now);
  store.saveFeedback = async () => {
    throw new Error("private database connection detail");
  };
  let providerCalls = 0;
  const worker = createFeedbackWorker({
    createStore: () => store,
    fetch: async () => {
      providerCalls += 1;
      return new Response(null, { status: 200 });
    },
  });
  const response = await requestFeedback(worker, testEnvironment(), requestBody());
  const body = await responseBody(response);
  assert.equal(response.status, 503);
  assert.equal(body.message, "Service temporarily unavailable.");
  assert.doesNotMatch(JSON.stringify(body), /private database connection detail/);
  assert.equal(providerCalls, 0, "mail is sent only after the report and mail intents are committed");
});

test("same submission ID is idempotent under concurrency and mismatched reuse returns 409", async () => {
  const now = Date.now();
  const store = new MemoryStore(() => now);
  let sends = 0;
  const worker = createFeedbackWorker({
    createStore: () => store,
    now: () => now,
    uuid: newUuidFactory(),
    fetch: async () => {
      sends += 1;
      return new Response(null, { status: 200 });
    },
  });
  const env = testEnvironment();
  const body = requestBody({ email: "person@example.test" });
  const [first, second] = await Promise.all([
    worker.fetch(makeRequest("/api/feedback", body, { ip: "203.0.113.10" }), env as never),
    worker.fetch(makeRequest("/api/feedback", body, { ip: "203.0.113.10" }), env as never),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [200, 201]);
  const firstBody = await responseBody(first);
  const secondBody = await responseBody(second);
  assert.equal(firstBody.id, secondBody.id);
  assert.equal(sends, 2, "duplicate request did not duplicate either email audience");
  const changed = await requestFeedback(worker, env, requestBody({ message: "Different content with the same key." }));
  assert.equal(changed.status, 409);
});

test("email failure for either audience does not undo the report and known sent mail is not resent", async () => {
  const now = Date.now();
  const store = new MemoryStore(() => now);
  const calls: Array<{ to: string; key: string }> = [];
  const worker = createFeedbackWorker({
    createStore: () => store,
    now: () => now,
    uuid: newUuidFactory(),
    fetch: async (_input, init) => {
      const payload = JSON.parse(String(init?.body));
      const to = payload.to[0];
      calls.push({ to, key: new Headers(init?.headers).get("idempotency-key")! });
      return new Response("provider failure", { status: to === "ops@example.test" ? 400 : 500 });
    },
  });
  const env = testEnvironment();
  const response = await requestFeedback(worker, env, requestBody({ email: "person@example.test", contact: true }));
  const body = await responseBody(response);
  assert.equal(response.status, 201);
  assert.equal(body.notification.operator, "failed");
  assert.equal(body.notification.receipt, "ambiguous");
  assert.equal(calls.length, 2, "the second audience is attempted after the first fails");
  assert.equal((await store.getReport(body.id))?.message, "The claim button stays open after it saves.");
  const savedKey = store.getDelivery(body.id, "receipt")?.idempotencyKey;
  const duplicate = await requestFeedback(worker, env, requestBody({ email: "person@example.test", contact: true }));
  assert.equal(duplicate.status, 200);
  assert.equal(calls.length, 2, "duplicate POST does not automatically retry failed or ambiguous mail");
  assert.equal(store.getDelivery(body.id, "receipt")?.idempotencyKey, savedKey);
});

test("disabled preview stores per-audience states and does not call the email provider", async () => {
  const store = new MemoryStore(Date.now);
  let sends = 0;
  const worker = createFeedbackWorker({
    createStore: () => store,
    uuid: newUuidFactory(),
    fetch: async () => {
      sends += 1;
      return new Response();
    },
  });
  const env = testEnvironment({ EMAIL_MODE: "disabled", RESEND_API_KEY: undefined, EMAIL_FROM: undefined, OPERATOR_EMAIL: undefined });
  const response = await requestFeedback(worker, env, requestBody({ email: "person@example.test" }));
  const body = await responseBody(response);
  assert.equal(response.status, 201);
  assert.equal(body.notification.operator, "disabled");
  assert.equal(body.notification.receipt, "disabled");
  assert.equal(sends, 0);
});

test("the app no longer serves operator sign-in or report review routes", async () => {
  const now = Date.now();
  const store = new MemoryStore(() => now);
  const worker = createFeedbackWorker({ createStore: () => store, now: () => now, uuid: newUuidFactory() });
  const env = testEnvironment();
  const id = "00000000-0000-4000-8000-000000000100";
  for (const [path, method] of [
    ["/api/operator/login", "POST"],
    ["/api/operator/session", "GET"],
    ["/api/operator/feedback", "GET"],
    [`/api/operator/feedback/${id}`, "PATCH"],
    [`/api/operator/feedback/${id}/attachment`, "GET"],
    [`/api/operator/feedback/${id}/retry-emails`, "POST"],
  ] as const) {
    const response = await worker.fetch(makeRequest(path, method === "GET" ? undefined : {}, { method }), env as never);
    assert.equal(response.status, 404, `${method} ${path}`);
  }
  const capOrigin = await worker.fetch(makeRequest("/api/health", undefined, { origin: "capacitor://localhost" }), env as never);
  assert.equal(capOrigin.status, 200);
  assert.equal((await responseBody(capOrigin)).releaseSha, "abc123");
});

test("simultaneous manual email retries claim each recipient once", async () => {
  const now = Date.now();
  const store = new MemoryStore(() => now);
  let phase: "first" | "retry" = "first";
  let retryStarted!: () => void;
  const retryStartedPromise = new Promise<void>((resolve) => {
    retryStarted = resolve;
  });
  let releaseRetry!: () => void;
  const retryGate = new Promise<void>((resolve) => {
    releaseRetry = resolve;
  });
  let retries = 0;
  let firstFetch = 0;
  const keys: string[] = [];
  const delivery: DeliveryDependencies = {
    now: () => now,
    uuid: newUuidFactory(),
    fetch: async (_input, init) => {
      const key = new Headers(init?.headers).get("idempotency-key")!;
      keys.push(key);
      if (phase === "first") {
        firstFetch += 1;
        return new Response(null, { status: firstFetch === 1 ? 500 : 400 });
      }
      retries += 1;
      if (retries === 2) retryStarted();
      await retryGate;
      return new Response(null, { status: 200 });
    },
  };
  const worker = createFeedbackWorker({ createStore: () => store, ...delivery });
  const env = testEnvironment();
  const saved = await requestFeedback(worker, env, requestBody({ email: "person@example.test", contact: true }));
  const { id } = await responseBody(saved);
  phase = "retry";
  // The operator dashboard retries both audiences with this shared delivery function.
  const retryRequest = () => Promise.all((["operator", "receipt"] as const).map((audience) => sendEmail(store, env, delivery, id, audience, false)));
  const firstRetry = retryRequest();
  await retryStartedPromise;
  const secondRetry = retryRequest();
  releaseRetry();
  const [first, second] = await Promise.all([firstRetry, secondRetry]);
  assert.deepEqual(
    first.map((result) => result.status),
    ["sent", "sent"],
  );
  assert.deepEqual(
    second.map((result) => result.status),
    ["skipped", "skipped"],
  );
  assert.equal(retries, 2, "only the first request claimed operator and receipt delivery");
  assert.equal(store.getDelivery(id, "operator")?.status, "sent");
  assert.equal(store.getDelivery(id, "receipt")?.status, "sent");
  assert.equal(new Set(keys.slice(0, 2)).size, 2);
});

test("an accepted send with failed status persistence is not resent after 24 hours without explicit confirmation", async () => {
  let now = Date.now();
  const store = new MemoryStore(() => now);
  store.failNextFinishAudience = "operator";
  const keys: string[] = [];
  let providerCalls = 0;
  const delivery: DeliveryDependencies = {
    now: () => now,
    uuid: newUuidFactory(),
    fetch: async (_input, init) => {
      providerCalls += 1;
      keys.push(new Headers(init?.headers).get("idempotency-key")!);
      return new Response(null, { status: 200 });
    },
  };
  const worker = createFeedbackWorker({ createStore: () => store, ...delivery });
  const env = testEnvironment();
  const saved = await requestFeedback(worker, env, requestBody({ email: "person@example.test" }));
  const { id } = await responseBody(saved);
  assert.equal(saved.status, 201);
  assert.equal(providerCalls, 2);
  assert.equal(store.getDelivery(id, "operator")?.status, "sending");
  now += 25 * 60 * 60 * 1000;
  const retry = (confirm: boolean) => sendEmail(store, env, delivery, id, "operator", confirm);
  const guarded = await retry(false);
  assert.equal(guarded.status, "requires_confirmation");
  assert.equal(providerCalls, 2, "old ambiguous delivery was not blindly sent again");
  const confirmed = await retry(true);
  assert.equal(confirmed.status, "sent");
  assert.equal(providerCalls, 3);
  assert.notEqual(keys[0], keys[2], "confirmed retry gets a new deterministic idempotency key");
  assert.equal(store.getDelivery(id, "operator")?.status, "sent");
});
