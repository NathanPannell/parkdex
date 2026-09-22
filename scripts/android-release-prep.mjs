#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PRODUCTION_API_BASE_URL = "https://api-production-e72df.up.railway.app";
export const PRODUCTION_CATALOGUE_SCOPE = "canonical";
export const PRODUCTION_FIELD_DIAGNOSTICS = "0";
export const RELEASE_PROPERTY_NAMES = Object.freeze([
  "PARKDEX_RELEASE_KEYSTORE_FILE",
  "PARKDEX_RELEASE_KEYSTORE_PASSWORD",
  "PARKDEX_RELEASE_KEY_ALIAS",
  "PARKDEX_RELEASE_KEY_PASSWORD",
]);

const VERSION_CODE_MAX = 2_100_000_000;
const REPOSITORY_FILE = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(REPOSITORY_FILE), "..");
function nonEmpty(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || undefined;
}

function valueFrom(options, environment, properties, name) {
  return nonEmpty(options[name]) || nonEmpty(environment[name]) || nonEmpty(properties[name]);
}

function usage() {
  return `Usage: npm run android:release-prep -- [options]

Preparation validates a production Android release without building. Add --build
to sync the static bundle and assemble the signed release AAB.

Required inputs may be supplied as options or PARKDEX_RELEASE_* environment
variables. Signing passwords must come from the environment or an external
Gradle properties file; they are never accepted as command-line arguments.

Options:
  --api-base-url <url>             Exact production API origin
  --version-code <integer>         New Play versionCode
  --version-name <name>            New Play versionName
  --previous-version-code <int>    Last uploaded Play versionCode
  --properties-file <path>         External properties file, outside this repo
  --provenance <path>              External JSON provenance output path
  --build                          Sync and assemble the release AAB
  --help                           Show this help
`;
}

export function parseArgs(argv) {
  const options = { build: false };
  const valueOptions = new Set([
    "--api-base-url",
    "--version-code",
    "--version-name",
    "--previous-version-code",
    "--properties-file",
    "--provenance",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--build") {
      options.build = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (valueOptions.has(argument)) {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${argument} requires a value.`);
      options[argument.slice(2).replaceAll("-", "_")] = next;
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) throw new Error(`Unknown option: ${argument}`);
    throw new Error(`Unexpected argument: ${argument}`);
  }
  return options;
}

function unescapePropertyValue(value) {
  return value
    .replaceAll("\\\\", "\\")
    .replaceAll("\\:", ":")
    .replaceAll("\\=", "=")
    .replaceAll("\\ ", " ");
}

export function readPropertiesFile(propertiesPath) {
  const result = {};
  for (const rawLine of readFileSync(propertiesPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const match = rawLine.match(/^\s*([^:=\s]+)\s*[:=]\s*(.*)$/);
    if (!match) continue;
    result[match[1]] = unescapePropertyValue(match[2].trim());
  }
  return result;
}

function canonicalPath(path) {
  const resolved = resolve(path);
  if (existsSync(resolved)) return realpathSync(resolved);
  const suffix = [];
  let cursor = resolved;
  while (!existsSync(cursor)) {
    const next = dirname(cursor);
    if (next === cursor) return resolved;
    suffix.unshift(relative(next, cursor));
    cursor = next;
  }
  return resolve(realpathSync(cursor), ...suffix);
}

function pathInside(child, parent) {
  const childPath = canonicalPath(child);
  const parentPath = canonicalPath(parent);
  const normalizedChild = process.platform === "win32" ? childPath.toLowerCase() : childPath;
  const normalizedParent = process.platform === "win32" ? parentPath.toLowerCase() : parentPath;
  const relativePath = relative(normalizedParent, normalizedChild);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function defaultPropertiesPath(environment) {
  const gradleUserHome = nonEmpty(environment.GRADLE_USER_HOME);
  if (gradleUserHome) return join(resolve(gradleUserHome), "gradle.properties");
  const userProfile = nonEmpty(environment.USERPROFILE) || nonEmpty(environment.HOME);
  return userProfile ? join(resolve(userProfile), ".gradle", "gradle.properties") : undefined;
}

function loadPrivateProperties(options, environment, repositoryRoot) {
  const requestedPath = options.properties_file || environment.PARKDEX_RELEASE_PROPERTIES_FILE;
  const propertiesPath = requestedPath ? resolve(requestedPath) : defaultPropertiesPath(environment);
  if (!propertiesPath || !existsSync(propertiesPath)) {
    if (requestedPath) throw new Error(`Release properties file does not exist: ${propertiesPath}`);
    return { values: {}, path: undefined };
  }
  if (pathInside(propertiesPath, repositoryRoot)) {
    throw new Error("Release properties must be stored outside the repository.");
  }
  if (!statSync(propertiesPath).isFile()) throw new Error("Release properties path must be a file.");
  return { values: readPropertiesFile(propertiesPath), path: propertiesPath };
}

function requireText(value, label) {
  const normalized = nonEmpty(value);
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function parsePositiveInteger(value, label, { maximum = VERSION_CODE_MAX } = {}) {
  const normalized = requireText(String(value ?? ""), label);
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} must be a positive integer.`);
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${label} must be between 1 and ${maximum}.`);
  }
  return parsed;
}

function parseNonNegativeInteger(value, label, { maximum = VERSION_CODE_MAX } = {}) {
  const normalized = requireText(String(value ?? ""), label);
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} must be a non-negative integer.`);
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new Error(`${label} must be between 0 and ${maximum}.`);
  }
  return parsed;
}

export function assertProductionApiBaseUrl(value) {
  const normalized = requireText(value, "The production API origin");
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("The production API origin must be a valid URL.");
  }
  if (parsed.origin !== PRODUCTION_API_BASE_URL || parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`The release API must be the exact HTTPS production origin ${PRODUCTION_API_BASE_URL}.`);
  }
  return parsed.origin;
}

function assertPinnedBuildEnvironment(environment) {
  const scope = nonEmpty(environment.PARKDEX_CATALOGUE_SCOPE);
  if (scope && scope !== PRODUCTION_CATALOGUE_SCOPE) {
    throw new Error(`Release builds require PARKDEX_CATALOGUE_SCOPE=${PRODUCTION_CATALOGUE_SCOPE}.`);
  }
  const diagnostics = nonEmpty(environment.NEXT_PUBLIC_FIELD_DIAGNOSTICS);
  if (diagnostics && diagnostics !== PRODUCTION_FIELD_DIAGNOSTICS) {
    throw new Error(`Release builds require NEXT_PUBLIC_FIELD_DIAGNOSTICS=${PRODUCTION_FIELD_DIAGNOSTICS}.`);
  }
}

function assertKeystorePath(value, repositoryRoot) {
  const normalized = requireText(value, "PARKDEX_RELEASE_KEYSTORE_FILE");
  const path = resolve(normalized);
  if (!isAbsolute(normalized)) throw new Error("PARKDEX_RELEASE_KEYSTORE_FILE must be an absolute path.");
  if (pathInside(path, repositoryRoot)) throw new Error("The release keystore must be stored outside the repository.");
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error("PARKDEX_RELEASE_KEYSTORE_FILE must point to an existing file.");
  return path;
}

function assertVersionName(value) {
  const versionName = requireText(value, "PARKDEX_ANDROID_VERSION_NAME");
  if (versionName.length > 100 || /[\u0000-\u001f\u007f]/.test(versionName)) {
    throw new Error("PARKDEX_ANDROID_VERSION_NAME must be a short printable release label.");
  }
  return versionName;
}

export function resolveReleaseConfig(options = {}, { environment = process.env, repositoryRoot = REPOSITORY_ROOT } = {}) {
  const privateProperties = loadPrivateProperties(options, environment, repositoryRoot);
  const properties = privateProperties.values;
  assertPinnedBuildEnvironment(environment);

  const apiBaseUrl = assertProductionApiBaseUrl(
    options.api_base_url || environment.PARKDEX_RELEASE_API_BASE_URL,
  );
  const versionCode = parsePositiveInteger(
    valueFrom(options, environment, properties, "version_code")
      || valueFrom({}, environment, properties, "PARKDEX_ANDROID_VERSION_CODE"),
    "PARKDEX_ANDROID_VERSION_CODE",
  );
  const previousVersionCode = parseNonNegativeInteger(
    valueFrom(options, environment, properties, "previous_version_code")
      || valueFrom({}, environment, properties, "PARKDEX_ANDROID_PREVIOUS_VERSION_CODE"),
    "PARKDEX_ANDROID_PREVIOUS_VERSION_CODE",
  );
  if (versionCode <= previousVersionCode) {
    throw new Error(`PARKDEX_ANDROID_VERSION_CODE must be greater than the previous Play versionCode (${previousVersionCode}).`);
  }
  const versionName = assertVersionName(
    valueFrom(options, environment, properties, "version_name")
      || valueFrom({}, environment, properties, "PARKDEX_ANDROID_VERSION_NAME"),
  );

  const keystoreFile = assertKeystorePath(
    valueFrom({}, environment, properties, "PARKDEX_RELEASE_KEYSTORE_FILE"),
    repositoryRoot,
  );
  const keyAlias = requireText(
    valueFrom({}, environment, properties, "PARKDEX_RELEASE_KEY_ALIAS"),
    "PARKDEX_RELEASE_KEY_ALIAS",
  );
  const keystorePassword = requireText(
    valueFrom({}, environment, properties, "PARKDEX_RELEASE_KEYSTORE_PASSWORD"),
    "PARKDEX_RELEASE_KEYSTORE_PASSWORD",
  );
  const keyPassword = requireText(
    valueFrom({}, environment, properties, "PARKDEX_RELEASE_KEY_PASSWORD"),
    "PARKDEX_RELEASE_KEY_PASSWORD",
  );

  return Object.freeze({
    apiBaseUrl,
    catalogueScope: PRODUCTION_CATALOGUE_SCOPE,
    fieldDiagnostics: PRODUCTION_FIELD_DIAGNOSTICS,
    versionCode,
    versionName,
    previousVersionCode,
    signing: Object.freeze({ keystoreFile, keyAlias, keystorePassword, keyPassword }),
    propertiesPath: privateProperties.path,
  });
}

function git(repositoryRoot, args) {
  const result = spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(`git ${args[0]} failed.`);
  return result.stdout.trim();
}

export function sourceIdentity(repositoryRoot = REPOSITORY_ROOT) {
  const status = git(repositoryRoot, ["status", "--porcelain"]);
  if (status) throw new Error("The release worktree must be clean before preparation or build.");
  return {
    commitSha: git(repositoryRoot, ["rev-parse", "HEAD"]),
    treeSha: git(repositoryRoot, ["rev-parse", "HEAD^{tree}"]),
  };
}

function assertSourceIdentity(repositoryRoot, identity) {
  const current = sourceIdentity(repositoryRoot);
  if (current.commitSha !== identity.commitSha || current.treeSha !== identity.treeSha) {
    throw new Error("The source tree changed during Android release preparation/build.");
  }
  return current;
}

function sanitizeOutput(value, config) {
  let output = String(value || "");
  for (const secret of [config?.signing?.keystorePassword, config?.signing?.keyPassword]) {
    if (secret) output = output.split(secret).join("<redacted>");
  }
  return output;
}

function quoteWindowsArgument(value) {
  const argument = String(value);
  if (!/[\s"&|<>^()]/.test(argument)) return argument;
  return `"${argument.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1")}"`;
}

export function windowsCommandLine(command, args) {
  return [quoteWindowsArgument(command), ...args.map(quoteWindowsArgument)].join(" ");
}

function runCommand(command, args, { cwd, environment, config, label }) {
  const windowsBatch = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
  const executable = windowsBatch ? (environment.ComSpec || environment.COMSPEC || "cmd.exe") : command;
  const commandArgs = windowsBatch
    ? ["/d", "/s", "/c", `"${windowsCommandLine(command, args)}"`]
    : args;
  const result = spawnSync(executable, commandArgs, {
    cwd,
    env: environment,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...(windowsBatch ? { windowsVerbatimArguments: true } : {}),
  });
  const stdout = sanitizeOutput(result.stdout, config);
  const stderr = sanitizeOutput(result.stderr, config);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  if (result.error || result.status !== 0) {
    throw new Error(`${label} failed with exit ${result.status ?? "spawn"}.`);
  }
}

function assertExternalOutputPath(outputPath, repositoryRoot) {
  const path = resolve(outputPath);
  if (pathInside(path, repositoryRoot)) throw new Error("Provenance output must be stored outside the repository.");
  return path;
}

function writeJsonAtomically(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function provenanceBase(config, identity, mode) {
  return {
    schema: "parkdex.android-release-prep/v1",
    status: mode === "build" ? "artifact-built" : "prepared",
    productionVerified: false,
    verificationStatus: "pending",
    commitSha: identity.commitSha,
    treeSha: identity.treeSha,
    apiBaseUrl: config.apiBaseUrl,
    catalogueScope: config.catalogueScope,
    fieldDiagnostics: config.fieldDiagnostics,
    versionCode: config.versionCode,
    versionName: config.versionName,
    signing: {
      configured: true,
      keyAlias: config.signing.keyAlias,
    },
    createdAt: new Date().toISOString(),
  };
}

function buildEnvironment(config, environment, { includeSigning = true } = {}) {
  const result = {
    ...environment,
    NEXT_PUBLIC_API_BASE_URL: config.apiBaseUrl,
    NEXT_PUBLIC_FIELD_DIAGNOSTICS: config.fieldDiagnostics,
    PARKDEX_ANDROID_BUILD: "1",
    PARKDEX_ANDROID_RELEASE: "1",
    PARKDEX_ANDROID_VERSION_CODE: String(config.versionCode),
    PARKDEX_ANDROID_VERSION_NAME: config.versionName,
    PARKDEX_CATALOGUE_SCOPE: config.catalogueScope,
  };
  for (const name of RELEASE_PROPERTY_NAMES) delete result[name];
  if (includeSigning) {
    result.PARKDEX_RELEASE_KEYSTORE_FILE = config.signing.keystoreFile;
    result.PARKDEX_RELEASE_KEYSTORE_PASSWORD = config.signing.keystorePassword;
    result.PARKDEX_RELEASE_KEY_ALIAS = config.signing.keyAlias;
    result.PARKDEX_RELEASE_KEY_PASSWORD = config.signing.keyPassword;
  }
  return result;
}

export function gradleReleaseEnvironment(config, environment = process.env) {
  return buildEnvironment(config, environment, { includeSigning: true });
}

export function frontendReleaseEnvironment(config, environment = process.env) {
  return buildEnvironment(config, environment, { includeSigning: false });
}

function buildRelease(repositoryRoot, config, identity) {
  const frontendRoot = join(repositoryRoot, "frontend");
  const frontendEnvironment = frontendReleaseEnvironment(config, process.env);
  const gradleEnvironment = gradleReleaseEnvironment(config, frontendEnvironment);
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  runCommand(npmCommand, ["run", "android:sync"], {
    cwd: frontendRoot,
    environment: frontendEnvironment,
    config,
    label: "Capacitor Android sync",
  });
  const gradleRoot = join(frontendRoot, "android");
  const gradle = process.platform === "win32" ? "gradlew.bat" : join(gradleRoot, "gradlew");
  const gradleArgs = process.platform === "win32"
    ? ["--no-daemon", ":app:bundleRelease"]
    : ["-p", "android", "--no-daemon", ":app:bundleRelease"];
  runCommand(gradle, gradleArgs, {
    cwd: gradleRoot,
    environment: gradleEnvironment,
    config,
    label: "Android release bundle",
  });
  const artifact = join(frontendRoot, "android", "app", "build", "outputs", "bundle", "release", "app-release.aab");
  if (!existsSync(artifact) || !statSync(artifact).isFile()) throw new Error(`Expected release AAB was not produced at ${artifact}.`);
  const finalIdentity = assertSourceIdentity(repositoryRoot, identity);
  return { artifact, artifactSha256: sha256(artifact), identity: finalIdentity };
}

export async function main(argv = process.argv.slice(2), { repositoryRoot = REPOSITORY_ROOT, environment = process.env } = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(usage());
    return { status: "help" };
  }
  const config = resolveReleaseConfig(options, { environment, repositoryRoot });
  const identity = sourceIdentity(repositoryRoot);
  const mode = options.build ? "build" : "prepare";
  const provenance = provenanceBase(config, identity, mode);
  let buildResult;
  if (options.build) {
    buildResult = buildRelease(repositoryRoot, config, identity);
    provenance.artifact = {
      type: "aab",
      path: buildResult.artifact,
      sha256: buildResult.artifactSha256,
    };
    provenance.commitSha = buildResult.identity.commitSha;
    provenance.treeSha = buildResult.identity.treeSha;
  }
  if (options.provenance) {
    const provenancePath = assertExternalOutputPath(options.provenance, repositoryRoot);
    writeJsonAtomically(provenancePath, provenance);
    provenance.provenancePath = provenancePath;
  }
  const summary = {
    status: mode === "build" ? "artifact-built" : "prepared",
    productionVerified: false,
    verificationStatus: "pending",
    apiBaseUrl: config.apiBaseUrl,
    catalogueScope: config.catalogueScope,
    fieldDiagnostics: config.fieldDiagnostics,
    versionCode: config.versionCode,
    versionName: config.versionName,
    artifact: buildResult?.artifact,
    artifactSha256: buildResult?.artifactSha256,
    provenancePath: provenance.provenancePath,
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`android-release-prep failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
