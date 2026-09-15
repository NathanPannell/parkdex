import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(frontendRoot, "out");
const manifestPath = resolve(outputRoot, "parkdex-artifact.json");

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (path === manifestPath) return [];
    return entry.isDirectory() ? files(path) : [path];
  });
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for a release build`);
  return value;
}

const commitSha = required("NEXT_PUBLIC_COMMIT_SHA");
if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new Error("NEXT_PUBLIC_COMMIT_SHA must be a full lowercase Git SHA");

const apiBaseUrl = required("NEXT_PUBLIC_API_BASE_URL");
if (apiBaseUrl !== ".") {
  const parsed = new URL(apiBaseUrl);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== apiBaseUrl) {
    throw new Error("NEXT_PUBLIC_API_BASE_URL must be '.' or an HTTP(S) origin");
  }
}

const hash = createHash("sha256");
for (const path of files(outputRoot).sort()) {
  const name = relative(outputRoot, path).split(sep).join("/");
  const content = readFileSync(path);
  hash.update(name).update("\0").update(String(content.length)).update("\0").update(content).update("\0");
}

const manifest = {
  schema: "parkdex.static-export/v1",
  commitSha,
  releaseVersion: required("NEXT_PUBLIC_RELEASE_VERSION"),
  commitDate: required("NEXT_PUBLIC_COMMIT_DATE"),
  apiBaseUrl,
  artifactSha256: hash.digest("hex"),
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote static export manifest ${manifest.artifactSha256}`);
