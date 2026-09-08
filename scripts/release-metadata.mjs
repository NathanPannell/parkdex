import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function releaseMetadata(commitSha, git = (args) => execFileSync("git", args, { encoding: "utf8" }).trim()) {
  const sha = git(["rev-parse", "--verify", `${commitSha}^{commit}`]);
  const commitDate = git(["show", "-s", "--format=%cI", sha]);
  const sequence = Number.parseInt(git(["rev-list", "--first-parent", "--count", sha]), 10);
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("Could not derive a release sequence from git history.");
  const minor = Math.floor(sequence / 1000);
  const patch = sequence % 1000;
  return {
    version: `v1.${minor}.${String(patch).padStart(3, "0")}`,
    commitSha: sha,
    commitDate,
  };
}

function output(metadata) {
  process.stdout.write(`version=${metadata.version}\ncommit_sha=${metadata.commitSha}\ncommit_date=${metadata.commitDate}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  output(releaseMetadata(process.argv[2] || "HEAD"));
}
