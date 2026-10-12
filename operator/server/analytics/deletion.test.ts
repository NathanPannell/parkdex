import assert from "node:assert/strict";
import { test } from "node:test";
import { strictEdgeFetch } from "../app/fakeCloud.ts";
import { edgeSafeFetch } from "./deletion.ts";

const PHOTO_URL = "https://photos.example.test/v1/accounts/7d0f3a52-9a8e-4d1c-a5c6-0f9d5f2a1b11";

function recorder(respond: () => Response) {
  const seen: RequestInit[] = [];
  const inner = strictEdgeFetch(async (_input: string, init: RequestInit = {}) => {
    seen.push(init);
    return respond();
  });
  return { seen, inner, fetch: edgeSafeFetch(inner as unknown as typeof fetch) };
}

test("the photo client's redirect: error reaches the Edge runtime as manual", async () => {
  const { seen, inner, fetch } = recorder(() => Response.json({ status: "complete" }));
  const response = await fetch(PHOTO_URL, { method: "DELETE", headers: { authorization: "Bearer t" }, redirect: "error" });
  assert.equal(response.status, 200);
  assert.deepEqual(inner.violations, []);
  assert.equal(seen[0].redirect, "manual");
  assert.equal(seen[0].method, "DELETE");
});

test("a redirect from the photo service counts as a failed attempt and is not followed", async () => {
  const { fetch } = recorder(() => new Response(null, { status: 302, headers: { location: "https://elsewhere.example.test/" } }));
  const response = await fetch(PHOTO_URL, { method: "DELETE", redirect: "error" });
  assert.equal(response.status, 502);
  assert.equal(response.ok, false);
});

test("requests that do not ask for redirect: error pass through unchanged", async () => {
  const { seen, fetch } = recorder(() => new Response(null, { status: 302 }));
  const response = await fetch(PHOTO_URL, { method: "GET" });
  assert.equal(response.status, 302);
  assert.equal(seen[0].redirect, undefined);
});
