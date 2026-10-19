import assert from "node:assert/strict";
import test from "node:test";
import { choiceFlags, DEFAULT_MODERATION_MODEL, moderate, MODERATION_ENDPOINT, type ModerationAnswer } from "./moderation.js";
import { blocklisted, checkHandle, HANDLE_QUESTION } from "./handles.js";

const KEY = "test-openrouter-key";

function choice(probabilities: Record<string, number>, picked?: string): ModerationAnswer {
  const top = Object.entries(probabilities).sort((left, right) => right[1] - left[1])[0]?.[0];
  return { type: "choice", choice: picked ?? top ?? "unsure", confidence: 0.9, probabilities };
}

function decisionsResponse(answers: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify({ id: "dec_1", model: DEFAULT_MODERATION_MODEL, provider: "test", answers, usage: {} }), { status });
}

test("moderate posts the Decisions API shape with the bearer key and default model", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const result = await moderate(
    { kind: "handle", state: { handle: "trail_runner" }, questions: { handle: HANDLE_QUESTION } },
    { OPENROUTER_API_KEY: KEY },
    async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return decisionsResponse({ handle: { type: "choice", choice: "allow", confidence: 0.97, probabilities: { allow: 0.97, reject: 0.02, unsure: 0.01 } } });
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, MODERATION_ENDPOINT);
  assert.equal(calls[0].init.method, "POST");
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("authorization"), `Bearer ${KEY}`);
  assert.equal(headers.get("content-type"), "application/json");
  const body = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(Object.keys(body).sort(), ["model", "questions", "state"]);
  assert.equal(body.model, "openai/gpt-6-luna-decisions");
  assert.deepEqual(body.state, { handle: "trail_runner" });
  assert.equal(body.questions.handle.type, "choice");
  assert.deepEqual(Object.keys(body.questions.handle.criteria), ["allow", "reject", "unsure"]);
  assert.equal(result?.kind, "handle");
  assert.equal(result?.answers.handle.type, "choice");
});

test("moderate honours the model override and an optional user", async () => {
  let body: Record<string, unknown> = {};
  await moderate(
    { kind: "park_proposal", state: "x", questions: { ok: { type: "noul", instructions: "i", criteria: { true: "yes", false: "no" } } }, user: "opaque-1" },
    { OPENROUTER_API_KEY: KEY, OPENROUTER_MODERATION_MODEL: "vendor/other-model" },
    async (_url, init) => {
      body = JSON.parse(String(init!.body));
      return decisionsResponse({ ok: { type: "noul", noul: 0.2 } });
    },
  );
  assert.equal(body.model, "vendor/other-model");
  assert.equal(body.user, "opaque-1");
});

test("moderate returns null without a key, on errors, malformed answers and timeouts", async () => {
  const request = { kind: "handle", state: { handle: "a" }, questions: { handle: HANDLE_QUESTION } };
  let called = false;
  assert.equal(
    await moderate(request, {}, async () => {
      called = true;
      return decisionsResponse({});
    }),
    null,
  );
  assert.equal(called, false, "no key means no network call");
  assert.equal(
    await moderate(request, { OPENROUTER_API_KEY: KEY }, async () => {
      throw new Error("offline");
    }),
    null,
  );
  assert.equal(
    await moderate(
      request,
      { OPENROUTER_API_KEY: KEY },
      async () => new Response(JSON.stringify({ error: { code: 429, message: "slow down" } }), { status: 429 }),
    ),
    null,
  );
  assert.equal(
    await moderate(request, { OPENROUTER_API_KEY: KEY }, async () => new Response(JSON.stringify({ error: { code: 400, message: "bad" } }), { status: 200 })),
    null,
  );
  assert.equal(await moderate(request, { OPENROUTER_API_KEY: KEY }, async () => decisionsResponse({})), null, "missing answer");
  assert.equal(
    await moderate(request, { OPENROUTER_API_KEY: KEY }, async () =>
      decisionsResponse({ handle: { type: "choice", choice: "allow", probabilities: { allow: 7 } } }),
    ),
    null,
  );
  assert.equal(await moderate(request, { OPENROUTER_API_KEY: KEY }, async () => new Response("not json")), null);
  const started = Date.now();
  const hanging = await moderate(request, { OPENROUTER_API_KEY: KEY }, () => new Promise<Response>(() => undefined), 30);
  assert.equal(hanging, null);
  assert.ok(Date.now() - started < 2_000);
});

test("choice threshold rejects the top label or any probability above the threshold", () => {
  assert.equal(choiceFlags(choice({ allow: 0.3, reject: 0.45, unsure: 0.25 }), "reject"), true, "highest probability");
  assert.equal(choiceFlags(choice({ allow: 0.1, reject: 0.51, unsure: 0.39 }), "reject"), true);
  assert.equal(choiceFlags(choice({ allow: 0.6, reject: 0.3, unsure: 0.1 }), "reject"), false);
  assert.equal(choiceFlags(choice({ allow: 0.45, reject: 0.1, unsure: 0.45 }), "reject"), false);
  assert.equal(choiceFlags(choice({}, "reject"), "reject"), true, "falls back to the reported choice");
  assert.equal(choiceFlags({ type: "noul", noul: 1 }, "reject"), false);
  assert.equal(choiceFlags(undefined, "reject"), false);
});

test("handle blocklist catches slurs, leetspeak and impersonation without flagging ordinary words", () => {
  for (const handle of [
    "fuck_yeah",
    "sh1tlord",
    "f_u_c_k",
    "admin",
    "the_admin",
    "parkdex_team",
    "kip",
    "kip_2",
    "ass",
    "big_ass",
    "n4zi_fan",
    "staff",
    "fuuuck",
  ]) {
    assert.equal(blocklisted(handle), true, handle);
  }
  for (const handle of [
    "classic_sam",
    "skipper",
    "assassin",
    "document99",
    "peacock",
    "spicy_sam",
    "canal_walker",
    "badminton",
    "therapist",
    "trail_runner",
    "kipling",
    "sexton_fan",
    "grape_ape",
  ]) {
    assert.equal(blocklisted(handle), false, handle);
  }
});

test("checkHandle uses the model after the blocklist and falls back when it is unavailable", async () => {
  let calls = 0;
  const reject = async () => {
    calls += 1;
    return decisionsResponse({ handle: { type: "choice", choice: "reject", confidence: 0.9, probabilities: { allow: 0.1, reject: 0.85, unsure: 0.05 } } });
  };
  const allow = async () => {
    calls += 1;
    return decisionsResponse({ handle: { type: "choice", choice: "allow", confidence: 0.9, probabilities: { allow: 0.9, reject: 0.05, unsure: 0.05 } } });
  };
  assert.deepEqual(await checkHandle("fuck_yeah", { OPENROUTER_API_KEY: KEY }, allow), { allowed: false, source: "blocklist" });
  assert.equal(calls, 0, "blocklisted handles never reach the model");
  assert.deepEqual(await checkHandle("jane_doe_555", { OPENROUTER_API_KEY: KEY }, reject), { allowed: false, source: "model" });
  assert.deepEqual(await checkHandle("trail_runner", { OPENROUTER_API_KEY: KEY }, allow), { allowed: true, source: "model" });
  assert.deepEqual(await checkHandle("trail_runner", {}, reject), { allowed: true, source: "blocklist_only" });
  assert.deepEqual(
    await checkHandle("trail_runner", { OPENROUTER_API_KEY: KEY }, async () => {
      throw new Error("down");
    }),
    { allowed: true, source: "blocklist_only" },
  );
});
