import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, it } from "node:test";

import {
  INTERNAL_STAGING_API_BASE_URL,
  PRODUCTION_API_BASE_URL,
  frontendReleaseEnvironment,
  gradleReleaseEnvironment,
  parseArgs,
  resolveReleaseConfig,
  windowsCommandLine,
} from "./android-release-prep.mjs";

const fixtures = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function fixtureEnvironment(overrides = {}) {
  const fixture = mkdtempSync(join(tmpdir(), "parkdex-release-prep-test-"));
  fixtures.push(fixture);
  const repositoryRoot = join(fixture, "repo");
  mkdirSync(repositoryRoot);
  const keystoreFile = join(fixture, "play-upload.p12");
  writeFileSync(keystoreFile, "test-only-keystore-placeholder");
  return {
    repositoryRoot,
    environment: {
      PARKDEX_RELEASE_API_BASE_URL: PRODUCTION_API_BASE_URL,
      PARKDEX_ANDROID_VERSION_CODE: "1",
      PARKDEX_ANDROID_VERSION_NAME: "1.0.0",
      PARKDEX_ANDROID_PREVIOUS_VERSION_CODE: "0",
      PARKDEX_RELEASE_KEYSTORE_FILE: keystoreFile,
      PARKDEX_RELEASE_KEYSTORE_PASSWORD: "store-secret",
      PARKDEX_RELEASE_KEY_ALIAS: "parkdex-upload",
      PARKDEX_RELEASE_KEY_PASSWORD: "key-secret",
      ...overrides,
    },
  };
}

describe("android release preparation", () => {
  it("requires a new versionCode greater than the exact previous code", () => {
    const first = fixtureEnvironment();
    assert.equal(resolveReleaseConfig({}, first).previousVersionCode, 0);

    const same = fixtureEnvironment({
      PARKDEX_ANDROID_VERSION_CODE: "1",
      PARKDEX_ANDROID_PREVIOUS_VERSION_CODE: "1",
    });
    assert.throws(() => resolveReleaseConfig({}, same), /greater than the previous Play versionCode \(1\)/);

    const lower = fixtureEnvironment({
      PARKDEX_ANDROID_VERSION_CODE: "1",
      PARKDEX_ANDROID_PREVIOUS_VERSION_CODE: "2",
    });
    assert.throws(() => resolveReleaseConfig({}, lower), /greater than the previous Play versionCode \(2\)/);

    const next = fixtureEnvironment({
      PARKDEX_ANDROID_VERSION_CODE: "2",
      PARKDEX_ANDROID_PREVIOUS_VERSION_CODE: "1",
    });
    assert.equal(resolveReleaseConfig({}, next).versionCode, 2);
  });

  it("requires the exact HTTPS production API and pins release content", () => {
    const staging = fixtureEnvironment({ PARKDEX_RELEASE_API_BASE_URL: "https://api-staging-882c.up.railway.app" });
    assert.throws(() => resolveReleaseConfig({}, staging), /exact HTTPS production origin/);

    const http = fixtureEnvironment({ PARKDEX_RELEASE_API_BASE_URL: "http://api-production-e72df.up.railway.app" });
    assert.throws(() => resolveReleaseConfig({}, http), /exact HTTPS production origin/);

    const badScope = fixtureEnvironment({ PARKDEX_CATALOGUE_SCOPE: "staging" });
    assert.throws(() => resolveReleaseConfig({}, badScope), /PARKDEX_CATALOGUE_SCOPE=canonical/);

    const badDiagnostics = fixtureEnvironment({ NEXT_PUBLIC_FIELD_DIAGNOSTICS: "1" });
    assert.throws(() => resolveReleaseConfig({}, badDiagnostics), /NEXT_PUBLIC_FIELD_DIAGNOSTICS=0/);
  });

  it("allows only an explicitly targeted internal-staging candidate with a visible label", () => {
    const staging = fixtureEnvironment({
      PARKDEX_RELEASE_API_BASE_URL: INTERNAL_STAGING_API_BASE_URL,
      PARKDEX_ANDROID_VERSION_NAME: "1.0.1-internal-staging",
    });
    const config = resolveReleaseConfig({ target: "internal-staging" }, staging);
    assert.equal(config.target, "internal-staging");
    assert.equal(config.apiBaseUrl, INTERNAL_STAGING_API_BASE_URL);
    assert.equal(config.versionName, "1.0.1-internal-staging");
    assert.equal(frontendReleaseEnvironment(config).PARKDEX_ANDROID_RELEASE_TARGET, "internal-staging");

    const missingLabel = fixtureEnvironment({
      PARKDEX_RELEASE_API_BASE_URL: INTERNAL_STAGING_API_BASE_URL,
    });
    assert.throws(
      () => resolveReleaseConfig({ target: "internal-staging" }, missingLabel),
      /literal internal-staging label/,
    );

    const productionApi = fixtureEnvironment({
      PARKDEX_ANDROID_VERSION_NAME: "1.0.1-internal-staging",
    });
    assert.throws(
      () => resolveReleaseConfig({ target: "internal-staging" }, productionApi),
      /exact HTTPS internal-staging origin https:\/\/api-staging-882c\.up\.railway\.app/,
    );

    const unknownTarget = fixtureEnvironment();
    assert.throws(() => resolveReleaseConfig({ target: "staging" }, unknownTarget), /--target must be one of/);
  });

  it("does not put signing secrets in the frontend build environment", () => {
    const fixture = fixtureEnvironment();
    const config = resolveReleaseConfig({}, fixture);
    const frontend = frontendReleaseEnvironment(config, { ...fixture.environment, inherited: "yes" });
    assert.equal(frontend.PARKDEX_RELEASE_KEY_PASSWORD, undefined);
    assert.equal(frontend.PARKDEX_RELEASE_KEYSTORE_PASSWORD, undefined);
    assert.equal(frontend.NEXT_PUBLIC_API_BASE_URL, PRODUCTION_API_BASE_URL);
    assert.equal(frontend.PARKDEX_CATALOGUE_SCOPE, "canonical");
    assert.equal(frontend.NEXT_PUBLIC_FIELD_DIAGNOSTICS, "0");
    const gradle = gradleReleaseEnvironment(config, frontend);
    assert.equal(gradle.PARKDEX_RELEASE_KEY_PASSWORD, "key-secret");
  });

  it("parses explicit preparation and build options", () => {
    assert.deepEqual(parseArgs([
      "--build",
      "--target", "production",
      "--api-base-url", PRODUCTION_API_BASE_URL,
      "--version-code", "2",
      "--version-name", "1.0.1",
      "--previous-version-code", "1",
      "--properties-file", "C:\\private\\release.properties",
    ]), {
      build: true,
      target: "production",
      api_base_url: PRODUCTION_API_BASE_URL,
      version_code: "2",
      version_name: "1.0.1",
      previous_version_code: "1",
      properties_file: "C:\\private\\release.properties",
    });
  });

  it("can invoke a Windows batch launcher from a path containing spaces", { skip: process.platform !== "win32" }, () => {
    const npmPath = join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "npm.cmd");
    if (!existsSync(npmPath)) return;
    const commandLine = windowsCommandLine(npmPath, ["--version"]);
    const result = spawnSync(process.env.ComSpec || process.env.COMSPEC || "cmd.exe", [
      "/d", "/s", "/c", `"${commandLine}"`,
    ], { encoding: "utf8", windowsVerbatimArguments: true });
    assert.equal(result.status, 0, `${result.stderr || result.stdout}`);
    assert.match(result.stdout, /\d+\.\d+/);
  });
});
