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

export type Channel = "staging" | "production";

/** app-bundles/channels/<channel>/current.json (docs/ota-updates.md). */
export type BundlePointer = {
  schema: string;
  channel: Channel;
  generation: number;
  version: string;
  bundleUrl: string;
  sha256: string;
  byteSize: number;
  minimumNativeBuild: number;
  maximumNativeBuild: number;
  sourceCommit: string;
  publishedAt: string;
};

export type ChannelState = "live" | "none" | "not_served" | "invalid" | "unavailable";

export type ChannelView = {
  channel: Channel;
  state: ChannelState;
  pointer: BundlePointer | null;
  etag: string | null;
  r2: { generation: number | null; etag: string | null } | null;
  detail: string;
};

export type BundleView = {
  sha256: string;
  byteSize: number;
  uploadedAt: string | null;
  version: string | null;
  sourceCommit: string | null;
  minimumNativeBuild: number | null;
  maximumNativeBuild: number | null;
  liveOn: Channel[];
};

export type OtaPublish = {
  id: number;
  channel: Channel;
  generation: number;
  previousGeneration: number | null;
  action: "publish" | "rollback" | "promote" | "repoint";
  source: "dashboard" | "script";
  sha256: string;
  previousSha256: string | null;
  version: string;
  byteSize: number;
  minimumNativeBuild: number;
  maximumNativeBuild: number;
  sourceCommit: string;
  outcome: "confirmed" | "cdn_pending" | "conflict";
  note: string;
  publishedAt: string;
  recordedAt: string;
};

/** GET /api/app/updates */
export type UpdatesOverview = {
  cdnOrigin: string;
  bucket: string;
  endpoints: Record<Channel, string>;
  cloudflare: { configured: boolean; error: string | null };
  probe: { serves: boolean | null; method: string; detail: string };
  channels: ChannelView[];
  bundles: BundleView[] | null;
  history: { available: boolean | null; rows: OtaPublish[] };
};

export type SetupItem = { id: string; title: string; status: "done" | "todo" | "error" | "info"; detail: string; next?: string; commands?: string[] };

/** GET /api/app/updates/check */
export type UpdateCheck = { channel: Channel; nativeBuild: number; endpoint: string; status: number; answer: unknown; expected: unknown; matches: boolean };

/** POST /api/app/updates/move */
export type MoveResult = { outcome: "confirmed" | "cdn_pending"; pointer: BundlePointer; previous: BundlePointer | null; action: OtaPublish["action"]; message: string };
