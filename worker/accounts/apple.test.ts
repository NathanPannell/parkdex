import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import {
  appleAppSiteAssociation,
  appleClientId,
  appleDisplayName,
  appleRevocationConfigured,
  decryptAppleRefreshToken,
  encryptAppleRefreshToken,
  exchangeAppleAuthorizationCode,
  resetAppleKeyCache,
  revokeAppleRefreshToken,
  verifyAppleIdentityToken,
} from "./apple.ts";

const NOW = Date.parse("2026-10-29T12:00:00.000Z");
const SECRET = "consumer-session-secret-long-enough-for-tests";
const RSA = generateKeyPairSync("rsa", { modulusLength: 2048 });
const OTHER_RSA = generateKeyPairSync("rsa", { modulusLength: 2048 });
const EC = generateKeyPairSync("ec", { namedCurve: "P-256" });
const KEY_ENV = {
  AUTH_SESSION_SECRET: SECRET,
  APPLE_TEAM_ID: "TEAM123456",
  APPLE_SIGN_IN_KEY_ID: "KEYID12345",
  APPLE_SIGN_IN_PRIVATE_KEY: EC.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
};

function jwks(kid = "apple-key-1", key = RSA.publicKey) {
  return { keys: [{ ...key.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" }] };
}

function identityToken(claims: Record<string, unknown>, options: { kid?: string; key?: typeof RSA.privateKey; alg?: string } = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: options.alg ?? "RS256", kid: options.kid ?? "apple-key-1" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: "https://appleid.apple.com",
      aud: "app.parkdex",
      sub: "001234.abcdef.0123",
      iat: Math.floor(NOW / 1000),
      exp: Math.floor(NOW / 1000) + 600,
      nonce: "server-nonce",
      email: "Abc123@PrivateRelay.AppleID.com",
      email_verified: "true",
      is_private_email: "true",
      ...claims,
    }),
  ).toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), options.key ?? RSA.privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function keyServer(...responses: unknown[]) {
  const requests: string[] = [];
  const fetch = async (input: RequestInfo | URL) => {
    requests.push(String(input));
    const next = responses.length > 1 ? responses.shift() : responses[0];
    return Response.json(next);
  };
  return { fetch, requests };
}

const verifyOptions = (fetch: (input: RequestInfo | URL) => Promise<Response>, nonce = "server-nonce") => ({ audience: "app.parkdex", nonce, now: NOW, fetch });

test("a signed Apple identity token yields its subject, a normalized email and the relay flag", async () => {
  resetAppleKeyCache();
  const server = keyServer(jwks());
  const claims = await verifyAppleIdentityToken(identityToken({}), verifyOptions(server.fetch));
  assert.deepEqual(claims, { sub: "001234.abcdef.0123", email: "abc123@privaterelay.appleid.com", isPrivateEmail: true, nonce: "server-nonce" });
  assert.deepEqual(server.requests, ["https://appleid.apple.com/auth/keys"]);

  // Later sign-ins may carry no email; the keys stay cached for an hour.
  const later = await verifyAppleIdentityToken(
    identityToken({ email: undefined, email_verified: undefined, is_private_email: undefined }),
    verifyOptions(server.fetch),
  );
  assert.equal(later.email, null);
  assert.equal(later.isPrivateEmail, false);
  assert.equal(server.requests.length, 1);
});

test("Apple identity tokens with the wrong issuer, audience, nonce, lifetime or signature are rejected", async () => {
  resetAppleKeyCache();
  const server = keyServer(jwks());
  const rejected = [
    identityToken({ iss: "https://accounts.google.com" }),
    identityToken({ aud: "app.parkdex.debug" }),
    identityToken({ nonce: "another-nonce" }),
    identityToken({ nonce: undefined }),
    identityToken({ exp: Math.floor(NOW / 1000) - 1 }),
    identityToken({ iat: Math.floor(NOW / 1000) + 3_600 }),
    identityToken({ sub: "" }),
    identityToken({}, { key: OTHER_RSA.privateKey }),
    identityToken({}, { alg: "HS256" }),
    identityToken({}, { kid: "unknown-key" }),
    "not.a.token",
    "only-one-part",
  ];
  for (const token of rejected) {
    await assert.rejects(verifyAppleIdentityToken(token, verifyOptions(server.fetch)), /could not be verified/u, token.slice(0, 40));
  }
  // An unverified email is dropped rather than trusted.
  assert.equal((await verifyAppleIdentityToken(identityToken({ email_verified: false }), verifyOptions(server.fetch))).email, null);
  // A list audience must contain the bundle ID.
  assert.equal((await verifyAppleIdentityToken(identityToken({ aud: ["other", "app.parkdex"] }), verifyOptions(server.fetch))).sub, "001234.abcdef.0123");
});

test("an unknown key ID refreshes Apple's keys once, so a rotation does not break sign-in", async () => {
  resetAppleKeyCache();
  const server = keyServer(jwks("old-key", OTHER_RSA.publicKey), jwks("apple-key-1"));
  const claims = await verifyAppleIdentityToken(identityToken({}), verifyOptions(server.fetch));
  assert.equal(claims.sub, "001234.abcdef.0123");
  assert.equal(server.requests.length, 2);
});

test("Apple's keys being unreachable rejects the token without throwing anything else", async () => {
  resetAppleKeyCache();
  const fetch = async () => new Response("down", { status: 503 });
  await assert.rejects(verifyAppleIdentityToken(identityToken({}), verifyOptions(fetch)), /could not be verified/u);
});

test("revocation needs the team, the key ID, the .p8 key and the account secret", () => {
  assert.equal(appleRevocationConfigured(KEY_ENV), true);
  assert.equal(appleRevocationConfigured({ ...KEY_ENV, APPLE_SIGN_IN_PRIVATE_KEY: KEY_ENV.APPLE_SIGN_IN_PRIVATE_KEY.replaceAll("\n", "\\n") }), true);
  assert.equal(appleRevocationConfigured({ ...KEY_ENV, APPLE_TEAM_ID: undefined }), false);
  assert.equal(appleRevocationConfigured({ ...KEY_ENV, APPLE_SIGN_IN_KEY_ID: "short" }), false);
  assert.equal(appleRevocationConfigured({ ...KEY_ENV, APPLE_SIGN_IN_PRIVATE_KEY: "not a key" }), false);
  assert.equal(appleRevocationConfigured({ ...KEY_ENV, AUTH_SESSION_SECRET: "short" }), false);
});

test("without the key nothing is sent to Apple", async () => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    return new Response(null, { status: 200 });
  };
  assert.equal(await exchangeAppleAuthorizationCode("code", { AUTH_SESSION_SECRET: SECRET }, NOW, fetch), null);
  assert.equal(await revokeAppleRefreshToken("token", { AUTH_SESSION_SECRET: SECRET }, NOW, fetch), false);
  assert.equal(calls, 0);
});

test("a refused code exchange or revocation reports failure instead of throwing", async () => {
  const refuse = async () => Response.json({ error: "invalid_grant" }, { status: 400 });
  assert.equal(await exchangeAppleAuthorizationCode("code", KEY_ENV, NOW, refuse), null);
  assert.equal(await revokeAppleRefreshToken("token", KEY_ENV, NOW, refuse), false);
  const noToken = async () => Response.json({ access_token: "only" });
  assert.equal(await exchangeAppleAuthorizationCode("code", KEY_ENV, NOW, noToken), null);
});

test("refresh tokens round-trip through AES-GCM and tampering is detected", () => {
  const sealed = encryptAppleRefreshToken("r.refresh-token", KEY_ENV);
  assert.match(sealed, /^v1\./u);
  assert.notEqual(encryptAppleRefreshToken("r.refresh-token", KEY_ENV), sealed, "every seal uses a new IV");
  assert.equal(decryptAppleRefreshToken(sealed, KEY_ENV), "r.refresh-token");
  const [version, iv, ciphertext, tag] = sealed.split(".");
  const flipped = Buffer.from(ciphertext, "base64url");
  flipped[0] ^= 1;
  assert.equal(decryptAppleRefreshToken([version, iv, flipped.toString("base64url"), tag].join("."), KEY_ENV), null);
  assert.equal(decryptAppleRefreshToken(sealed, { ...KEY_ENV, AUTH_SESSION_SECRET: "a-different-secret-that-is-long-enough" }), null);
  assert.equal(decryptAppleRefreshToken("v2.a.b.c", KEY_ENV), null);
});

test("the first-sign-in name becomes a display name only when it is printable and short", () => {
  assert.equal(appleDisplayName(" Robin ", "Park"), "Robin Park");
  assert.equal(appleDisplayName("Robin", undefined), "Robin");
  assert.equal(appleDisplayName(undefined, undefined), null);
  assert.equal(appleDisplayName("bad\u0000name", ""), null);
  assert.equal(appleDisplayName("x".repeat(81), ""), null);
});

test("apple-app-site-association names the team's app only once the team ID is configured", () => {
  assert.equal(appleAppSiteAssociation({}), null);
  assert.equal(appleAppSiteAssociation({ APPLE_TEAM_ID: "lowercase1" }), null);
  const file = appleAppSiteAssociation({ APPLE_TEAM_ID: "TEAM123456" }) as {
    applinks: { details: Array<{ appIDs: string[]; components: Array<Record<string, string>> }> };
  };
  assert.deepEqual(file.applinks.details[0].appIDs, ["TEAM123456.app.parkdex"]);
  assert.deepEqual(
    file.applinks.details[0].components.map((component) => component["/"]),
    ["/friend/*", "/account", "/account/"],
  );
  assert.equal(appleClientId({ APPLE_CLIENT_ID: "bad id!" }), "app.parkdex");
});
