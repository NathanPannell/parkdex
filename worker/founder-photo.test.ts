import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPhotoChecker,
  decidePhoto,
  DEFAULT_FLAG_THRESHOLDS,
  FLAG_MESSAGES,
  PHOTO_FLAGS,
  PHOTO_MODERATION_TIMEOUT_MS,
  PHOTO_QUESTIONS,
  photoState,
  type PhotoAnswers,
  type PhotoFlag,
} from "./founderPhoto.ts";

const no = { choice: "no", probabilities: { yes: 0.02, no: 0.98 } };
const yes = (p: number) => ({ choice: p > 0.5 ? "yes" : "no", probabilities: { yes: p, no: 1 - p } });

function answers(flags: Partial<Record<PhotoFlag, number>> = {}): PhotoAnswers {
  return {
    model: "openai/gpt-6-luna-decisions",
    answers: Object.fromEntries(PHOTO_FLAGS.map((flag) => [flag, flags[flag] === undefined ? no : yes(flags[flag]!)])),
  };
}

test("the production flag thresholds are the ones chosen in the photo lab", () => {
  assert.deepEqual(DEFAULT_FLAG_THRESHOLDS, { people: 0.8, lighting: 0.8, not_park: 0.95, inappropriate: 0.9, not_photo: 0.95, personal_info: 0.9 });
  assert.deepEqual(Object.keys(DEFAULT_FLAG_THRESHOLDS), [...PHOTO_FLAGS]);
  assert.ok(Object.isFrozen(DEFAULT_FLAG_THRESHOLDS));
});

test("a photo with no flag above its threshold is approved; there is no unsure", () => {
  assert.deepEqual(decidePhoto(answers()), { outcome: "approve", flags: [] });
  // Fairly likely flags that stay at or below their thresholds still approve.
  assert.deepEqual(decidePhoto(answers({ people: 0.8, lighting: 0.79, not_park: 0.95, inappropriate: 0.9, not_photo: 0.6, personal_info: 0.5 })), {
    outcome: "approve",
    flags: [],
  });
});

test("each flag above its threshold rejects the photo and names itself, most likely first", () => {
  for (const flag of PHOTO_FLAGS) {
    const limit = DEFAULT_FLAG_THRESHOLDS[flag];
    assert.deepEqual(decidePhoto(answers({ [flag]: limit + 0.01 })), { outcome: "reject", flags: [flag] }, flag);
    assert.deepEqual(decidePhoto(answers({ [flag]: limit })), { outcome: "approve", flags: [] }, `${flag} exactly at its threshold does not count`);
  }
  assert.deepEqual(decidePhoto(answers({ lighting: 0.85, not_park: 0.99, personal_info: 0.98 })), {
    outcome: "reject",
    flags: ["not_park", "personal_info", "lighting"],
  });
});

test("decisions over a grid of probabilities follow the rule exactly", () => {
  const levels = [0, 0.3, 0.5, 0.79, 0.8, 0.81, 0.89, 0.9, 0.91, 0.94, 0.95, 0.96, 1];
  for (const flag of PHOTO_FLAGS) {
    for (const p of levels) {
      const decision = decidePhoto(answers({ [flag]: p }));
      assert.equal(decision.outcome === "reject", p > DEFAULT_FLAG_THRESHOLDS[flag], `${flag} at ${p}`);
      assert.deepEqual(decidePhoto(answers({ [flag]: p }), DEFAULT_FLAG_THRESHOLDS), decision);
      assert.deepEqual(decidePhoto(answers({ [flag]: p }), {}), decision, "a missing threshold uses the default");
    }
  }
});

test("each flag can have its own threshold", () => {
  const result = answers({ people: 0.62, lighting: 0.55 });
  assert.deepEqual(decidePhoto(result), { outcome: "approve", flags: [] });
  assert.deepEqual(decidePhoto(result, { people: 0.5, lighting: 0.5 }), { outcome: "reject", flags: ["people", "lighting"] });
  assert.deepEqual(decidePhoto(result, { people: 0.6 }), { outcome: "reject", flags: ["people"] });
  assert.deepEqual(decidePhoto(result, { people: 0.62, lighting: 0.55 }), { outcome: "approve", flags: [] });
});

test("a verdict in older stored answers is ignored", () => {
  const older = answers({ people: 0.5 });
  older.answers.verdict = { choice: "reject", probabilities: { approve: 0.05, reject: 0.9, unsure: 0.05 } };
  assert.deepEqual(decidePhoto(older), { outcome: "approve", flags: [] });
});

test("every flag has a plain message for the player", () => {
  assert.equal(FLAG_MESSAGES.people, "We spotted people. Take one without anyone in it.");
  for (const flag of PHOTO_FLAGS) {
    assert.ok(FLAG_MESSAGES[flag].length > 10 && FLAG_MESSAGES[flag].length < 120, flag);
    assert.deepEqual(Object.keys(PHOTO_QUESTIONS[flag].type === "choice" ? PHOTO_QUESTIONS[flag].criteria : {}), ["yes", "no"]);
  }
  assert.match(String((PHOTO_QUESTIONS.lighting as { instructions: string }).instructions), /at night or in deep shade/);
});

test("the checker sends one Decisions call with the image as a base64 data URL and a short context line", async () => {
  const calls: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  const fetcher = async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown>, headers: new Headers(init?.headers) });
    const reply = answers();
    return new Response(
      JSON.stringify({
        model: reply.model,
        answers: Object.fromEntries(Object.entries(reply.answers).map(([name, answer]) => [name, { type: "choice", ...answer }])),
      }),
    );
  };
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const checker = createPhotoChecker({ OPENROUTER_API_KEY: "test-key-not-real" }, fetcher);
  const result = await checker({ jpeg, parkName: "Paterson Park", parkKind: "leisure=park" });
  assert.equal(decidePhoto(result!).outcome, "approve");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://openrouter.ai/api/alpha/decisions");
  const state = calls[0].body.state as Array<Record<string, unknown>>;
  assert.deepEqual(state[1], { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/2Q==" } });
  assert.equal(state[0].type, "text");
  assert.match(String(state[0].text), /Paterson Park \(leisure=park\)/);
  assert.deepEqual(Object.keys(calls[0].body.questions as object), [...PHOTO_FLAGS], "only the six flags, no overall verdict");
  assert.ok(!JSON.stringify(calls[0].body).includes("test-key-not-real"));
  assert.deepEqual(photoState({ jpeg, parkName: "X", parkKind: "y" })[1], state[1]);
});

test("no key, an error, a malformed answer or a slow model gives no answer", async () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const input = { jpeg, parkName: "Paterson Park", parkKind: "leisure=park" };
  assert.equal(
    await createPhotoChecker({}, async () => {
      throw new Error("must not be called");
    })(input),
    null,
  );
  assert.equal(await createPhotoChecker({ OPENROUTER_API_KEY: "k" }, async () => new Response("busy", { status: 503 }))(input), null);
  assert.equal(
    await createPhotoChecker(
      { OPENROUTER_API_KEY: "k" },
      async () => new Response(JSON.stringify({ answers: { verdict: { type: "choice", choice: "approve" } } })),
    )(input),
    null,
  );
  // Five flags answered and one missing is no answer, never an approval.
  const partial = Object.fromEntries(PHOTO_FLAGS.slice(1).map((flag) => [flag, { type: "choice", ...no }]));
  assert.equal(await createPhotoChecker({ OPENROUTER_API_KEY: "k" }, async () => new Response(JSON.stringify({ model: "m", answers: partial })))(input), null);
  const slow = createPhotoChecker(
    { OPENROUTER_API_KEY: "k" },
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    20,
  );
  assert.equal(await slow(input), null);
  assert.equal(PHOTO_MODERATION_TIMEOUT_MS, 8_000);
});
