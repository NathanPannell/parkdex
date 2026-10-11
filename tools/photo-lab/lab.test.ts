import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { EXIF_GPS_JPEG } from "../../worker/fixtures/exif-gps-jpeg.ts";
import { DEFAULT_FLAG_THRESHOLDS, PHOTO_FLAGS, type PhotoFlag } from "../../worker/founderPhoto.ts";
import {
  CATEGORIES, decideLab, evaluatePhoto, exportSettings, productionSettings, summarize,
  type LabSettings, type Manifest, type ManifestPhoto, type RunFile,
} from "./evaluate.ts";
import { classify, labDir, listRuns, loadManifest, readRun, retryingFetch, validateManifest } from "./lab.ts";

type Answers = NonNullable<RunFile["results"][string]["answers"]>;

/** Each flag's yes, 0.01 unless given. */
function answers(flags: Partial<Record<PhotoFlag, number>> = {}): Answers {
  return Object.fromEntries(PHOTO_FLAGS.map((flag) => {
    const p = flags[flag] ?? 0.01;
    return [flag, { choice: p > 0.5 ? "yes" : "no", probabilities: { yes: p, no: 1 - p } }];
  }));
}

/** Answers from a run made before the verdict question was dropped. */
function olderAnswers(verdict: Record<string, number>, flags: Partial<Record<PhotoFlag, number>> = {}): Answers {
  const top = Object.entries(verdict).sort((a, b) => b[1] - a[1])[0][0];
  return { verdict: { choice: top, probabilities: verdict }, ...answers(flags) };
}

function photo(id: string, outcome: ManifestPhoto["expected"]["outcome"], flags: PhotoFlag[] = [], optionalFlags: PhotoFlag[] = []): ManifestPhoto {
  const category = outcome === "approve" ? "good" : outcome === "either" ? "borderline" : "people";
  return { id, category, description: id, expected: { outcome, flags, optionalFlags }, source: { type: "commons" } };
}

function result(value: Answers | null) {
  return { answers: value, model: "m", error: value ? null : "no answer", latencyMs: 1, attempts: 1, costUsd: 0.0002, queriedIn: "run-x" };
}

const manifest = loadManifest();

// The manifest ---------------------------------------------------------------------------------

test("the committed manifest is valid and has the agreed mix", () => {
  assert.deepEqual(validateManifest(manifest), []);
  assert.equal(manifest.photos.length, 100);
  const count = (category: string) => manifest.photos.filter((item) => item.category === category).length;
  assert.equal(count("good"), 40);
  assert.ok(count("people") >= 10 && count("people") <= 14);
  assert.ok(count("blurry") >= 6 && count("dark") >= 6);
  assert.ok(count("not_park") >= 10 && count("not_photo") >= 5 && count("personal_info") >= 4);
  assert.ok(count("borderline") >= 8 && count("borderline") <= 14);
  for (const category of CATEGORIES) assert.ok(count(category) > 0, category);
  assert.deepEqual(manifest.notCovered, ["inappropriate"]);
  assert.ok(manifest.photos.some((item) => item.source.type === "derived"), "some photos are generated from good ones");
  for (const item of manifest.photos) {
    if (item.source.type === "commons") assert.match(String(item.source.licence), /CC|Public domain|Attribution/, item.id);
  }
});

test("the manifest schema refuses broken entries", () => {
  const broken = (change: (copy: Manifest) => void) => {
    const copy = structuredClone(manifest);
    change(copy);
    return validateManifest(copy);
  };
  assert.deepEqual(validateManifest(null), ["manifest must be an object"]);
  assert.match(broken((m) => { m.photos[1].id = m.photos[0].id; }).join(), /duplicate id/);
  assert.match(broken((m) => { m.photos[0].id = "Good 1"; }).join(), /id must look like/);
  assert.match(broken((m) => { (m.photos[0] as { category: string }).category = "sunset"; }).join(), /unknown category/);
  assert.match(broken((m) => { m.photos[0].expected.flags = ["people"]; }).join(), /approved photo expects no flags/);
  assert.match(broken((m) => { (m.photos[0].expected as { outcome: string }).outcome = "maybe"; }).join(), /expected.outcome/);
  const people = manifest.photos.findIndex((item) => item.category === "people");
  assert.match(broken((m) => { m.photos[people].expected.flags = []; }).join(), /names the flag it expects/);
  assert.match(broken((m) => { m.photos[people].expected.flags = ["shoes" as PhotoFlag]; }).join(), /must be photo flags/);
  assert.match(broken((m) => { m.photos[people].expected.optionalFlags = ["people"]; }).join(), /both expected and optional/);
  assert.match(broken((m) => { m.photos[people].expected.optionalFlags = ["inappropriate"]; }).join(), /not covered/);
  assert.match(broken((m) => { m.photos[0].source.licence = ""; }).join(), /licence is required/);
  assert.match(broken((m) => { m.photos[0].source.sha1 = "abc"; }).join(), /sha1/);
  assert.match(broken((m) => { m.photos[0].source.page = "https://example.com/x"; }).join(), /Commons URL/);
  const derived = manifest.photos.findIndex((item) => item.source.type === "derived" && "from" in item.source);
  assert.match(broken((m) => { m.photos[derived].source.from = "good-99"; }).join(), /from must name a Commons photo/);
  assert.match(broken((m) => { (m.photos[derived].source.transform as { op: string }).op = "sepia"; }).join(), /unknown transform/);
});

test("the data folder is outside the repository unless PHOTO_LAB_DIR says otherwise", () => {
  assert.equal(labDir({ PHOTO_LAB_DIR: "C:/somewhere" }), path.resolve("C:/somewhere"));
  const workspace = mkdtempSync(path.join(tmpdir(), "photo-lab-"));
  try {
    mkdirSync(path.join(workspace, ".codex", "worktrees", "repo"), { recursive: true });
    assert.equal(labDir({}, path.join(workspace, ".codex", "worktrees", "repo")), path.join(workspace, ".codex", "photo-lab"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

// Decisions ------------------------------------------------------------------------------------

test("production settings decide exactly as decidePhoto does in production: flags only", () => {
  const settings = productionSettings();
  assert.deepEqual(settings, { flags: { ...DEFAULT_FLAG_THRESHOLDS } });
  assert.deepEqual(decideLab(answers(), settings), { outcome: "approve", flags: [] });
  assert.deepEqual(decideLab(answers({ people: 0.8, not_park: 0.95 }), settings), { outcome: "approve", flags: [] }, "at a threshold does not count");
  assert.deepEqual(decideLab(answers({ lighting: 0.81 }), settings), { outcome: "reject", flags: ["lighting"] });
  assert.deepEqual(decideLab(answers({ not_photo: 0.99, people: 0.85 }), settings), { outcome: "reject", flags: ["not_photo", "people"] });
});

test("older runs are scored with the flags only; their verdict is ignored", () => {
  const settings = productionSettings();
  assert.deepEqual(decideLab(olderAnswers({ approve: 0.1, reject: 0.9 }), settings), { outcome: "approve", flags: [] });
  assert.deepEqual(decideLab(olderAnswers({ approve: 0.99, reject: 0.01 }, { people: 0.9 }), settings), { outcome: "reject", flags: ["people"] });
  const good = evaluatePhoto(photo("good-01", "approve"), result(olderAnswers({ approve: 0.6, reject: 0.4 })), settings);
  assert.equal(good.agreement, "agree");
});

test("per-flag thresholds change the decision", () => {
  const settings: LabSettings = { flags: { ...productionSettings().flags, lighting: 0.6 } };
  assert.deepEqual(decideLab(answers({ lighting: 0.64 }), productionSettings()), { outcome: "approve", flags: [] });
  assert.deepEqual(decideLab(answers({ lighting: 0.64 }), settings), { outcome: "reject", flags: ["lighting"] });
});

test("agreement: approve or reject must match; borderline photos agree either way", () => {
  const settings = productionSettings();
  assert.equal(evaluatePhoto(photo("good-01", "approve"), result(answers()), settings).agreement, "agree");
  const rejectedGood = evaluatePhoto(photo("good-01", "approve"), result(answers({ people: 0.9 })), settings);
  assert.equal(rejectedGood.agreement, "disagree");
  assert.equal(rejectedGood.falseRejection, true);
  const approvedBad = evaluatePhoto(photo("people-01", "reject", ["people"]), result(answers({ people: 0.7 })), settings);
  assert.equal(approvedBad.agreement, "disagree");
  assert.equal(approvedBad.falseApproval, true);
  const wrongReason = evaluatePhoto(photo("people-01", "reject", ["people"]), result(answers({ lighting: 0.9 })), settings);
  assert.equal(wrongReason.agreement, "agree");
  assert.equal(wrongReason.rightReason, false);
  assert.equal(evaluatePhoto(photo("borderline-01", "either"), result(answers({ people: 0.9 })), settings).agreement, "agree");
  assert.equal(evaluatePhoto(photo("good-01", "approve"), result(null), settings).agreement, "error");
});

test("the summary counts accuracy, the confusion matrix and per-flag precision and recall", () => {
  const small: Manifest = {
    version: 1, notes: "test", notCovered: ["inappropriate"],
    photos: [
      photo("good-01", "approve"),
      photo("good-02", "approve"),
      photo("people-01", "reject", ["people"]),
      photo("people-02", "reject", ["people"], ["not_park"]),
      photo("borderline-01", "either", [], ["lighting"]),
      photo("good-03", "approve"),
    ],
  };
  const run = {
    results: {
      "good-01": result(answers()),
      "good-02": result(answers({ people: 0.85 })),
      "people-01": result(answers({ people: 0.99, lighting: 0.9 })),
      "people-02": result(answers({ not_park: 0.97 })),
      "borderline-01": result(answers({ lighting: 0.85 })),
      "good-03": result(null),
    },
  };
  const { summary } = summarize(small, run, productionSettings());
  assert.equal(summary.errors, 1);
  assert.equal(summary.scored, 4);
  assert.equal(summary.correct, 3);
  assert.equal(summary.accuracy, 0.75);
  assert.deepEqual(summary.confusion, {
    approve: { approve: 1, reject: 1 },
    reject: { approve: 0, reject: 2 },
    either: { approve: 0, reject: 1 },
  });
  assert.deepEqual([summary.badBlocked, summary.badTotal, summary.goodApproved, summary.goodTotal], [2, 2, 1, 2]);
  assert.deepEqual(summary.falseApprovals, []);
  assert.deepEqual(summary.falseRejections, ["good-02"]);
  assert.equal(summary.rightReason, 1, "people-02 was rejected for not_park, which is only optional");
  const people = summary.flags.find((score) => score.flag === "people")!;
  assert.deepEqual([people.truePositive, people.falsePositive, people.falseNegative, people.trueNegative], [1, 1, 1, 2]);
  assert.equal(people.precision, 0.5);
  assert.equal(people.recall, 0.5);
  const lighting = summary.flags.find((score) => score.flag === "lighting")!;
  assert.equal(lighting.falsePositive, 0, "optional flags, and other flags on bad photos, are not scored");
  assert.equal(lighting.trueNegative, 2, "the good photos with an answer");
  const inappropriate = summary.flags.find((score) => score.flag === "inappropriate")!;
  assert.equal(inappropriate.covered, false);
  assert.equal(inappropriate.recall, null);

  const tuned = summarize(small, run, { flags: { ...productionSettings().flags, people: 0.9 } }).summary;
  assert.deepEqual(tuned.falseRejections, []);
});

test("the export gives the flag thresholds as JSON and the constant for worker/founderPhoto.ts", () => {
  const production = exportSettings(productionSettings());
  assert.deepEqual(JSON.parse(production.json), { flags: { ...DEFAULT_FLAG_THRESHOLDS } });
  const source = readFileSync(new URL("../../worker/founderPhoto.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  // The production export is exactly the constant the worker defines.
  assert.ok(source.includes(production.code.split("\n").slice(1).join("\n")), production.code);
  assert.doesNotMatch(production.code, /APPROVE|unsure|verdict/i);
  const tuned = exportSettings({ flags: { ...productionSettings().flags, lighting: 0.7 } });
  assert.match(tuned.code, /  lighting: 0\.7,/);
  assert.match(tuned.code, /  people: 0\.8,/);
  assert.equal(JSON.parse(tuned.json).flags.lighting, 0.7);
});

// Runs -----------------------------------------------------------------------------------------

function decisionsReply(): Response {
  const reply = answers();
  return new Response(JSON.stringify({
    model: "openai/test-decisions",
    usage: { input_tokens: 10, output_tokens: 0, cost: 0.0002 },
    answers: Object.fromEntries(Object.entries(reply).map(([name, answer]) => [name, { type: "choice", ...answer }])),
  }));
}

test("a retrying fetch retries 429 and 5xx, then passes the response through with its cost", async () => {
  const statuses = [429, 503, 200];
  const record = { attempts: 0, costUsd: null as number | null, status: null as number | null };
  const fetcher = retryingFetch(async () => {
    const status = statuses.shift()!;
    return status === 200 ? decisionsReply() : new Response("busy", { status });
  }, record, { baseDelayMs: 1 });
  const response = await fetcher("https://example.invalid", {});
  assert.equal(response.status, 200);
  assert.equal(record.attempts, 3);
  assert.equal(record.costUsd, 0.0002);
  const failing = { attempts: 0, costUsd: null as number | null, status: null as number | null };
  const final = await retryingFetch(async () => new Response("no", { status: 500 }), failing, { retries: 2, baseDelayMs: 1 })("https://example.invalid", {});
  assert.equal(final.status, 500);
  assert.equal(failing.attempts, 3);
  const bad = { attempts: 0, costUsd: null as number | null, status: null as number | null };
  assert.equal((await retryingFetch(async () => new Response("no", { status: 400 }), bad, { baseDelayMs: 1 })("https://example.invalid", {})).status, 400);
  assert.equal(bad.attempts, 1, "a client error is not retried");
});

test("classify sends stripped photos through the production checker and versions each run", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "photo-lab-"));
  try {
    mkdirSync(path.join(root, "images"));
    const ids = ["good-01", "people-01", "dark-01"];
    for (const id of ids) writeFileSync(path.join(root, "images", `${id}.jpg`), EXIF_GPS_JPEG);
    const sent: string[] = [];
    let keyCalls = 0;
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/api/v1/key")) {
        keyCalls += 1;
        return new Response(JSON.stringify({ data: { usage: keyCalls === 1 ? 1 : 1.0006 } }));
      }
      const body = JSON.parse(String(init?.body)) as { model: string; state: [{ text: string }, { image_url: { url: string } }]; questions: Record<string, unknown> };
      assert.deepEqual(Object.keys(body.questions), [...PHOTO_FLAGS], "a run asks only the flags, as production does");
      assert.match(body.state[0].text, /Beacon Hill Park \(leisure=park\)/);
      sent.push(body.state[1].image_url.url);
      if (sent.length === 2) return new Response("rate limited", { status: 429 });
      return decisionsReply();
    };
    const first = await classify({ root, ids, env: { OPENROUTER_API_KEY: "test-key-not-real" }, fetchImpl, retryDelayMs: 1, concurrency: 2 });
    assert.equal(first.queried.length, 3);
    assert.equal(first.model, "openai/test-decisions");
    assert.equal(first.basedOn, null);
    assert.equal(Object.values(first.results).filter((item) => item.answers).length, 3, "the 429 was retried");
    assert.equal(first.results["people-01"].queriedIn, first.id);
    assert.ok(Math.abs(first.spend.reportedCostUsd - 0.0006) < 1e-12);
    assert.deepEqual([first.spend.keyUsageBeforeUsd, first.spend.keyUsageAfterUsd], [1, 1.0006]);
    for (const url of sent) {
      const jpeg = Buffer.from(url.replace("data:image/jpeg;base64,", ""), "base64").toString("latin1");
      assert.ok(!jpeg.includes("Exif") && !jpeg.includes("GPS"), "metadata is stripped before the photo is sent");
    }

    const second = await classify({ root, ids: ["dark-01"], basedOn: first.id, env: { OPENROUTER_API_KEY: "test-key-not-real" }, fetchImpl, label: "Dark only" });
    assert.equal(second.basedOn, first.id);
    assert.deepEqual(second.queried, ["dark-01"]);
    assert.equal(second.label, "Dark only");
    assert.equal(second.results["good-01"].queriedIn, first.id, "other photos are carried over");
    assert.equal(second.results["dark-01"].queriedIn, second.id);
    assert.deepEqual(listRuns(root).map((run) => run.id).sort(), [first.id, second.id].sort());
    assert.equal(readRun(second.id, root).results["people-01"].answers?.people.choice, "no");
    assert.equal(readRun(second.id, root).results["people-01"].answers?.verdict, undefined);
    assert.throws(() => readRun("../secrets", root), /Unknown run/);
    await assert.rejects(classify({ root, ids: ["nope-01"], env: { OPENROUTER_API_KEY: "k" }, fetchImpl }), /Unknown photo ids/);
    await assert.rejects(classify({ root, ids, env: {}, fetchImpl }), /OPENROUTER_API_KEY/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
