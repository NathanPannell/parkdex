export type Platform = "android" | "web";
export type ApiPointer = "production" | "staging";

export type BuildConfig = {
  platform: Platform;
  build: number;
  label: string;
  apiPointer: ApiPointer | null;
  flags: Record<string, boolean>;
  notes: string;
  updatedAt: string;
};

export type UpdateRules = {
  environment: ApiPointer;
  minimumBuild: number | null;
  latestBuild: number | null;
  updatedAt: string | null;
};

/** GET /api/app/builds */
export type BuildListing = { builds: BuildConfig[]; rules: UpdateRules[]; knownFlags: string[]; retiredFlags: string[] };
