import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { APP_BUNDLE_POINTER_SCHEMA, bundleUrlFor } from "../../worker/appUpdates.ts";
import { edgeBuildOptions } from "../scripts/edge-bundle.mjs";
import { FakeBundleCloud, strictEdgeFetch } from "./app/fakeCloud.ts";
import { bundleVersion, CDN_ORIGIN, pointerKey } from "./app/ota.ts";

/**
 * Builds the deployed Edge Function bundle (the same esbuild options as scripts/build.mjs) and
 * drives its outbound fetches through a fetch that throws on the RequestInit fields the Vercel
 * Edge runtime rejects. A field like `cache: "no-store"` passes every unit test under Node but
 * makes every outbound call fail on Vercel.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const ORIGIN = "https://operator.example.test";
const SHA = "e".repeat(64);
const COMMIT = "3333333eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const env = { DASHBOARD_ENVIRONMENT: "production", CLOUDFLARE_API_TOKEN: "test-token", CLOUDFLARE_ACCOUNT_ID: "c".repeat(32), EMAIL_MODE: "disabled" };

let directory = "";
let createEdgeHandler: (env: Record<string, string>) => (request: Request) => Promise<Response>;
const realFetch = globalThis.fetch;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "operator-edge-"));
  const outfile = join(directory, "index.mjs");
  await build(edgeBuildOptions(root, outfile));
  ({ createEdgeHandler } = await import(pathToFileURL(outfile).href));
});

after(async () => {
  globalThis.fetch = realFetch;
  if (directory) await rm(directory, { recursive: true, force: true });
});

function call(handler: (request: Request) => Promise<Response>, path: string, init: RequestInit = {}) {
  const [subPath, query = ""] = path.split("?");
  const url = `${ORIGIN}/api?__path=${encodeURIComponent(subPath)}${query ? `&${query}` : ""}`;
  return handler(new Request(url, { ...init, headers: { origin: ORIGIN, ...(init.headers as Record<string, string>) } }));
}

test("the strict fetch refuses what the Edge runtime refuses", async () => {
  const strict = strictEdgeFetch(async () => new Response("ok"));
  await assert.rejects(strict("https://example.test/", { cache: "no-store" }), TypeError);
  await assert.rejects(strict("https://example.test/", { redirect: "error" }), TypeError);
  await assert.rejects(strict("https://example.test/", { keepalive: true }), TypeError);
  assert.equal((await strict("https://example.test/", { redirect: "manual" })).status, 200);
  assert.deepEqual(
    strict.violations.map((item) => item.field),
    ["cache", "redirect", "keepalive"],
  );
});

test("the built Edge Function reaches Cloudflare, the CDN and both update endpoints without refused fetch fields", async () => {
  const cloud = new FakeBundleCloud();
  cloud.put(`app-bundles/${SHA}.zip`, new Uint8Array(64));
  cloud.put(
    pointerKey("staging"),
    `${JSON.stringify(
      {
        schema: APP_BUNDLE_POINTER_SCHEMA,
        channel: "staging",
        generation: 1,
        version: bundleVersion(COMMIT, SHA),
        bundleUrl: bundleUrlFor(CDN_ORIGIN, SHA),
        sha256: SHA,
        byteSize: 64,
        minimumNativeBuild: 12,
        maximumNativeBuild: 12,
        sourceCommit: COMMIT,
        publishedAt: "2026-10-01T00:00:00.000Z",
      },
      null,
      2,
    )}\n`,
  );
  const strict = strictEdgeFetch(cloud.fetch);
  globalThis.fetch = strict as typeof fetch;
  const handler = createEdgeHandler(env);

  const setup = await call(handler, "app/updates/setup");
  assert.equal(setup.status, 200);
  const items = Object.fromEntries(((await setup.json()) as { items: { id: string; status: string; detail: string }[] }).items.map((item) => [item.id, item]));
  for (const id of ["cdn-worker", "pointer-staging", "endpoint", "cloudflare"]) assert.equal(items[id].status, "done", `${id}: ${items[id].detail}`);
  // No database on this deployment: the checklist says why instead of failing quietly.
  assert.match(items.history.detail, /not configured/);

  const overview = (await (await call(handler, "app/updates")).json()) as {
    channels: { state: string }[];
    bundles: unknown[];
    cloudflare: { error: string | null };
  };
  assert.deepEqual([overview.channels.map((view) => view.state), overview.bundles.length, overview.cloudflare.error], [["live", "none"], 1, null]);

  const check = (await (await call(handler, "app/updates/check?channel=staging&build=12")).json()) as { status: number; matches: boolean };
  assert.deepEqual([check.status, check.matches], [200, true]);

  const moved = await call(handler, "app/updates/move", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel: "production", sha256: SHA, expectedGeneration: 0, minimumNativeBuild: 12, maximumNativeBuild: 12 }),
  });
  assert.equal(moved.status, 200, await moved.clone().text());
  assert.equal(((await moved.json()) as { outcome: string }).outcome, "confirmed");

  assert.deepEqual(strict.violations, [], "no outbound call used a field the Edge runtime rejects");
  const hosts = new Set(cloud.requests.map((item) => new URL(item.url).host));
  for (const host of ["api.cloudflare.com", "kip-assets.parkdex.app", "staging.web.parkdex.app", "web.parkdex.app"]) assert.ok(hosts.has(host), host);
});

test("a failed outbound call explains itself in the checklist without leaking the token", async () => {
  globalThis.fetch = (async (input: string) => {
    throw new TypeError(`fetch failed for ${input}?token=secret with Bearer test-token`);
  }) as typeof fetch;
  const items = ((await (await call(createEdgeHandler(env), "app/updates/setup")).json()) as { items: { id: string; detail: string }[] }).items;
  const endpoint = items.find((item) => item.id === "endpoint")!;
  assert.match(endpoint.detail, /TypeError: fetch failed for web\.parkdex\.app/);
  const cloudflare = items.find((item) => item.id === "cloudflare")!;
  assert.match(cloudflare.detail, /TypeError/);
  for (const item of items) {
    assert.doesNotMatch(item.detail, /test-token|secret|https?:\/\//, item.id);
  }
});
