import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPhotoChecker, decidePhoto, FLAG_MESSAGES, PHOTO_FLAGS, PHOTO_MODERATION_TIMEOUT_MS, PHOTO_QUESTIONS, photoApproveThreshold, photoState,
  type PhotoAnswers,
} from "./founderPhoto.ts";

const no = { choice: "no", probabilities: { yes: 0.02, no: 0.98 } };
const yes = (p: number) => ({ choice: p > 0.5 ? "yes" : "no", probabilities: { yes: p, no: 1 - p } });

function answers(verdict: Record<string, number>, flags: Partial<Record<(typeof PHOTO_FLAGS)[number], number>> = {}): PhotoAnswers {
  const top = Object.entries(verdict).sort((a, b) => b[1] - a[1])[0][0];
  return {
    model: "openai/gpt-6-luna-decisions",
    answers: {
      verdict: { choice: top, probabilities: verdict },
      ...Object.fromEntries(PHOTO_FLAGS.map((flag) => [flag, flags[flag] === undefined ? no : yes(flags[flag]!)])),
    },
  };
}

test("approve only with a confident verdict and no flags", () => {
  assert.deepEqual(decidePhoto(answers({ approve: 0.94, reject: 0.04, unsure: 0.02 }), 0.8), { outcome: "approve", flags: [] });
  assert.deepEqual(decidePhoto(answers({ approve: 0.8, reject: 0.1, unsure: 0.1 }), 0.8), { outcome: "approve", flags: [] });
  assert.deepEqual(decidePhoto(answers({ approve: 0.79, reject: 0.11, unsure: 0.1 }), 0.8), { outcome: "unsure", flags: [] });
  assert.deepEqual(decidePhoto(answers({ approve: 0.86, reject: 0.1, unsure: 0.04 }), 0.9), { outcome: "unsure", flags: [] }, "the threshold can be raised");
});

test("each flag rejects the photo and names itself, most likely first", () => {
  for (const flag of PHOTO_FLAGS) {
    assert.deepEqual(decidePhoto(answers({ approve: 0.95, reject: 0.03, unsure: 0.02 }, { [flag]: 0.7 }), 0.8), { outcome: "reject", flags: [flag] }, flag);
  }
  assert.deepEqual(decidePhoto(answers({ approve: 0.01, reject: 0.99 }, { lighting: 0.63, not_park: 0.99, personal_info: 0.98 }), 0.8),
    { outcome: "reject", flags: ["not_park", "personal_info", "lighting"] });
  // A flag at exactly one half does not count.
  assert.equal(decidePhoto(answers({ approve: 0.95, reject: 0.05 }, { people: 0.5 }), 0.8).outcome, "approve");
});

test("a rejecting verdict with no flag, or an unsure one, asks for another photo", () => {
  assert.deepEqual(decidePhoto(answers({ approve: 0.25, reject: 0.7, unsure: 0.05 }), 0.8), { outcome: "unsure", flags: [] });
  assert.deepEqual(decidePhoto(answers({ approve: 0.3, reject: 0.2, unsure: 0.5 }), 0.8), { outcome: "unsure", flags: [] });
});

test("every flag has a plain message for the player", () => {
  assert.equal(FLAG_MESSAGES.people, "We spotted people. Take one without anyone in it.");
  for (const flag of PHOTO_FLAGS) {
    assert.ok(FLAG_MESSAGES[flag].length > 10 && FLAG_MESSAGES[flag].length < 120, flag);
    assert.deepEqual(Object.keys(PHOTO_QUESTIONS[flag].type === "choice" ? PHOTO_QUESTIONS[flag].criteria : {}), ["yes", "no"]);
  }
  assert.match(String((PHOTO_QUESTIONS.lighting as { instructions: string }).instructions), /at night or in deep shade/);
});

test("the approve threshold comes from the environment within sane bounds", () => {
  assert.equal(photoApproveThreshold(undefined), 0.8);
  assert.equal(photoApproveThreshold("0.9"), 0.9);
  assert.equal(photoApproveThreshold("0.2"), 0.8);
  assert.equal(photoApproveThreshold("two"), 0.8);
});

test("the checker sends one Decisions call with the image as a base64 data URL and a short context line", async () => {
  const calls: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  const fetcher = async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown>, headers: new Headers(init?.headers) });
    const reply = answers({ approve: 0.94, reject: 0.04, unsure: 0.02 });
    return new Response(JSON.stringify({ model: reply.model, answers: Object.fromEntries(Object.entries(reply.answers).map(([name, answer]) => [name, { type: "choice", ...answer }])) }));
  };
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const checker = createPhotoChecker({ OPENROUTER_API_KEY: "test-key-not-real" }, fetcher);
  const result = await checker({ jpeg, parkName: "Paterson Park", parkKind: "leisure=park" });
  assert.equal(decidePhoto(result!, 0.8).outcome, "approve");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://openrouter.ai/api/alpha/decisions");
  const state = calls[0].body.state as Array<Record<string, unknown>>;
  assert.deepEqual(state[1], { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/2Q==" } });
  assert.equal(state[0].type, "text");
  assert.match(String(state[0].text), /Paterson Park \(leisure=park\)/);
  assert.deepEqual(Object.keys(calls[0].body.questions as object), ["verdict", ...PHOTO_FLAGS]);
  assert.ok(!JSON.stringify(calls[0].body).includes("test-key-not-real"));
  assert.deepEqual(photoState({ jpeg, parkName: "X", parkKind: "y" })[1], state[1]);
});

test("no key, an error, a malformed answer or a slow model gives no answer", async () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const input = { jpeg, parkName: "Paterson Park", parkKind: "leisure=park" };
  assert.equal(await createPhotoChecker({}, async () => { throw new Error("must not be called"); })(input), null);
  assert.equal(await createPhotoChecker({ OPENROUTER_API_KEY: "k" }, async () => new Response("busy", { status: 503 }))(input), null);
  assert.equal(await createPhotoChecker({ OPENROUTER_API_KEY: "k" }, async () => new Response(JSON.stringify({ answers: { verdict: { type: "choice", choice: "approve" } } })))(input), null);
  const slow = createPhotoChecker({ OPENROUTER_API_KEY: "k" }, (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  }), 20);
  assert.equal(await slow(input), null);
  assert.equal(PHOTO_MODERATION_TIMEOUT_MS, 8_000);
});
