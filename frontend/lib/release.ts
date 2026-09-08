export type ReleaseMetadata = {
  version: string;
  commitSha: string;
  commitDate: string;
};

export function resolveReleaseMetadata(values: Partial<ReleaseMetadata>): ReleaseMetadata {
  return {
    version: values.version?.trim() || "v0.0.000",
    commitSha: values.commitSha?.trim() || "local",
    commitDate: values.commitDate?.trim() || "local build",
  };
}

export const RELEASE_METADATA = resolveReleaseMetadata({
  version: process.env.NEXT_PUBLIC_RELEASE_VERSION,
  commitSha: process.env.NEXT_PUBLIC_COMMIT_SHA,
  commitDate: process.env.NEXT_PUBLIC_COMMIT_DATE,
});
