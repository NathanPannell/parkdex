import assert from "node:assert/strict";
import { test } from "node:test";
import { redirectFor, resolveRoute, SECTIONS } from "./routes.ts";

test("retired and bare paths redirect to where their pages live now", () => {
  const cases: Array<[string, string | null]> = [
    ["/", "/feedback"],
    ["/proposals", "/parks"],
    ["/proposals/", "/parks"],
    ["/proposals/import", "/parks"],
    ["/proposals/drafts/regional-thetis-lake", "/parks"],
    ["/proposals/live/beacon-hill-park", "/parks"],
    ["/builds", "/app/builds"],
    ["/builds/android", "/app/builds"],
    ["/analytics", "/analytics/overview"],
    ["/analytics/nope", "/analytics/overview"],
    ["/app", "/app/builds"],
    ["/app/", "/app/builds"],
    ["/parks/", "/parks"],
  ];
  for (const [from, to] of cases) assert.equal(redirectFor(from), to, from);
});

test("current paths, including the feedback link in operator emails, stay put", () => {
  for (const path of ["/feedback", "/feedback/review", "/parks", "/parks/beacon-hill-park", "/analytics/overview", "/analytics/accounts", "/analytics/events", "/app/builds", "/app/updates"]) {
    assert.equal(redirectFor(path), null, path);
  }
  // Paths that only share letters with a retired page are not redirected.
  assert.equal(redirectFor("/proposalsx"), null);
  assert.equal(redirectFor("/buildsx"), null);
});

test("every path resolves to its section, and Build config is pinned to production", () => {
  assert.deepEqual(SECTIONS.map((section) => section.path), ["/feedback", "/parks", "/analytics", "/app"]);
  assert.equal(resolveRoute("/feedback/review")?.section.id, "feedback");
  assert.equal(resolveRoute("/parks/beacon-hill-park")?.section.id, "parks");
  assert.equal(resolveRoute("/analytics/events")?.child?.label, "Events");
  const builds = resolveRoute("/app/builds");
  assert.deepEqual([builds?.section.id, builds?.child?.label, builds?.database], ["app", "Build config", "production"]);
  assert.equal(resolveRoute("/app/updates")?.database, "production");
  for (const path of ["/feedback", "/parks", "/analytics/overview", "/analytics/accounts"]) {
    assert.equal(resolveRoute(path)?.database, "toggle", path);
  }
  assert.equal(resolveRoute("/applications"), null);
  assert.equal(resolveRoute("/nowhere"), null);
  // Every redirect target is a page some section owns.
  for (const path of ["/", "/proposals", "/builds", "/analytics", "/app"]) assert.ok(resolveRoute(redirectFor(path)!), path);
});
