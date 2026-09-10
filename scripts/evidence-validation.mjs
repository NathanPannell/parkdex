const BACKEND_RESULTS = ["database isolation contracts", "create owned CI database", "backend seed contract", "backend migrations", "backend tests", "drop owned CI database"];
const FRONTEND_RESULTS = ["repository dependencies", "catalogue validation", "boundary source tests", "boundary geometry", "release metadata tests", "workflow contract tests", "local release contract tests", "CI evidence contract tests", "deployment helper tests", "frontend dependencies", "frontend boundary asset", "frontend territory contract", "frontend lint", "frontend typecheck", "frontend tests", "frontend build"];

export function canonicalGithubRepositorySlug(value) {
  const remote = String(value || "").trim();
  const match = remote.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i)
    || remote.match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i)
    || remote.match(/^ssh:\/\/git@github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : "";
}

export function repositorySlug(value) {
  const github = canonicalGithubRepositorySlug(value);
  if (github) return github;
  const normalized = String(value || "").trim().replaceAll("\\", "/");
  const local = normalized.match(/(?:^|\/)([^/]+)\/([^/]+?)(?:\.git)?$/);
  return local && !/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized) ? `${local[1]}/${local[2]}`.toLowerCase() : "";
}

export function successfulResults(evidence, suite) {
  const required = suite === "backend" ? BACKEND_RESULTS : suite === "frontend" ? FRONTEND_RESULTS : [...BACKEND_RESULTS, ...FRONTEND_RESULTS];
  const labels = new Set((evidence?.results || []).filter((item) => item?.status === 0).map((item) => item.label));
  return required.every((label) => labels.has(label));
}

export function validateNestedLocalEvidence(evidence, { candidateSha, treeSha, repository, validatorSha256, requireCanonicalGithub = false }) {
  const evidenceRepository = requireCanonicalGithub ? canonicalGithubRepositorySlug(evidence?.repository) : repositorySlug(evidence?.repository);
  return evidence?.schema === "parkdex.local-ci/v1"
    && evidence.status === "success"
    && evidence.commitSha === candidateSha
    && evidence.treeSha === treeSha
    && evidence.suite === "all"
    && evidenceRepository === repository.toLowerCase()
    && evidence.validatorSha256 === validatorSha256
    && successfulResults(evidence, "all");
}

export const canonicalSource = (value) => `${String(value).replaceAll("\r\n", "\n").trimEnd()}\n`;
