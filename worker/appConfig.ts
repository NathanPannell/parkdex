import { neon } from "@neondatabase/serverless";
import { HttpError, readJsonBody } from "./validation.js";

/**
 * Per-build remote configuration. Each app build checks in with the production API to learn
 * which content database it reads and which feature flags are on. Build 0 is a platform default.
 */

export const APP_CONFIG_PLATFORMS = ["android", "web"] as const;
export type AppConfigPlatform = (typeof APP_CONFIG_PLATFORMS)[number];

export const CONTENT_CHANNELS = ["staging", "main"] as const;
export type ContentChannel = (typeof CONTENT_CHANNELS)[number];

/** Every remotely controlled feature. Keep in step with `src/lib/appConfig.ts`. */
export const FEATURE_FLAGS = ["rankProgression", "parkProposals"] as const;
export type FeatureFlag = (typeof FEATURE_FLAGS)[number];
export type FeatureFlags = Partial<Record<FeatureFlag, boolean>>;

export const DEFAULT_BUILD = 0;
const MAX_BUILD = 2_100_000_000;

export interface BuildConfigRecord {
  platform: AppConfigPlatform;
  build: number;
  label: string;
  contentChannel: ContentChannel | null;
  flags: FeatureFlags;
  minimumBuild: number | null;
  latestBuild: number | null;
  notes: string;
  updatedAt: string;
}

export interface BuildConfigInput {
  label: string;
  contentChannel: ContentChannel | null;
  flags: FeatureFlags;
  minimumBuild: number | null;
  latestBuild: number | null;
  notes: string;
}

export interface AppConfigStore {
  /** The exact build row and the platform default row, when they exist. */
  resolve(platform: AppConfigPlatform, build: number): Promise<BuildConfigRecord[]>;
  list(): Promise<BuildConfigRecord[]>;
  upsert(platform: AppConfigPlatform, build: number, input: BuildConfigInput): Promise<BuildConfigRecord>;
  remove(platform: AppConfigPlatform, build: number): Promise<boolean>;
}

export interface AppConfigResponse {
  schema: "parkdex.app-config/v1";
  platform: AppConfigPlatform;
  build: number;
  /** Null means the app keeps the content database it was built for. */
  contentChannel: ContentChannel | null;
  flags: FeatureFlags;
  /** Builds below this must update from the store before they can be used. */
  minimumBuild: number | null;
  /** The newest build in the store; older builds get a dismissable nudge. */
  latestBuild: number | null;
  update: "required" | "available" | "none";
  /** Which rows contributed: the exact build, the platform default, or neither. */
  source: "build" | "default" | "none";
}

type Row = {
  platform: string;
  build: number;
  label: string;
  content_channel: string | null;
  flags: unknown;
  minimum_build: number | null;
  latest_build: number | null;
  notes: string;
  updated_at: string | Date;
};

function toRecord(row: Row): BuildConfigRecord {
  return {
    platform: row.platform as AppConfigPlatform,
    build: Number(row.build),
    label: row.label,
    contentChannel: (row.content_channel as ContentChannel | null) ?? null,
    flags: sanitizeFlags(row.flags),
    minimumBuild: row.minimum_build === null ? null : Number(row.minimum_build),
    latestBuild: row.latest_build === null ? null : Number(row.latest_build),
    notes: row.notes,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export function createNeonAppConfigStore(databaseUrl: string): AppConfigStore {
  const sql = neon(databaseUrl);
  return {
    async resolve(platform, build) {
      const rows = await sql`
        SELECT platform, build, label, content_channel, flags, minimum_build, latest_build, notes, updated_at
        FROM kip_app_config.builds
        WHERE platform = ${platform} AND build IN (${build}, ${DEFAULT_BUILD})
      ` as Row[];
      return rows.map(toRecord);
    },
    async list() {
      const rows = await sql`
        SELECT platform, build, label, content_channel, flags, minimum_build, latest_build, notes, updated_at
        FROM kip_app_config.builds
        ORDER BY platform, build DESC
      ` as Row[];
      return rows.map(toRecord);
    },
    async upsert(platform, build, input) {
      const rows = await sql`
        INSERT INTO kip_app_config.builds (platform, build, label, content_channel, flags, minimum_build, latest_build, notes)
        VALUES (${platform}, ${build}, ${input.label}, ${input.contentChannel}, ${JSON.stringify(input.flags)}::jsonb, ${input.minimumBuild}, ${input.latestBuild}, ${input.notes})
        ON CONFLICT (platform, build) DO UPDATE SET
          label = EXCLUDED.label,
          content_channel = EXCLUDED.content_channel,
          flags = EXCLUDED.flags,
          minimum_build = EXCLUDED.minimum_build,
          latest_build = EXCLUDED.latest_build,
          notes = EXCLUDED.notes,
          updated_at = now()
        RETURNING platform, build, label, content_channel, flags, minimum_build, latest_build, notes, updated_at
      ` as Row[];
      return toRecord(rows[0]);
    },
    async remove(platform, build) {
      const rows = await sql`
        DELETE FROM kip_app_config.builds WHERE platform = ${platform} AND build = ${build} RETURNING build
      ` as unknown[];
      return rows.length > 0;
    },
  };
}

export function sanitizeFlags(value: unknown): FeatureFlags {
  const flags: FeatureFlags = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return flags;
  for (const key of FEATURE_FLAGS) {
    const flag = (value as Record<string, unknown>)[key];
    if (typeof flag === "boolean") flags[key] = flag;
  }
  return flags;
}

export function parsePlatform(value: string | null | undefined): AppConfigPlatform {
  if (value && (APP_CONFIG_PLATFORMS as readonly string[]).includes(value)) return value as AppConfigPlatform;
  throw new HttpError(400, "invalid_platform", "Unknown app platform.");
}

export function parseBuild(value: string | null | undefined): number {
  if (!value || !/^\d{1,10}$/.test(value)) throw new HttpError(400, "invalid_build", "Build must be a whole number.");
  const build = Number(value);
  if (build > MAX_BUILD) throw new HttpError(400, "invalid_build", "Build must be a whole number.");
  return build;
}

export function validateBuildConfigInput(body: unknown): BuildConfigInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "invalid_request", "Invalid build configuration.");
  }
  const input = body as Record<string, unknown>;
  const allowed = new Set(["label", "contentChannel", "flags", "minimumBuild", "latestBuild", "notes"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new HttpError(400, "invalid_request", "Invalid build configuration.");
  const label = input.label ?? "";
  const notes = input.notes ?? "";
  if (typeof label !== "string" || label.length > 80) throw new HttpError(400, "invalid_label", "Label must be 80 characters or fewer.");
  if (typeof notes !== "string" || notes.length > 500) throw new HttpError(400, "invalid_notes", "Notes must be 500 characters or fewer.");
  const channel = input.contentChannel ?? null;
  if (channel !== null && !(CONTENT_CHANNELS as readonly unknown[]).includes(channel)) {
    throw new HttpError(400, "invalid_channel", "Content database must be staging, main, or unset.");
  }
  const rawFlags = input.flags ?? {};
  if (typeof rawFlags !== "object" || rawFlags === null || Array.isArray(rawFlags)) {
    throw new HttpError(400, "invalid_flags", "Flags must be an object.");
  }
  for (const [key, value] of Object.entries(rawFlags)) {
    if (!(FEATURE_FLAGS as readonly string[]).includes(key) || typeof value !== "boolean") {
      throw new HttpError(400, "invalid_flags", `Unknown or invalid feature flag: ${key.slice(0, 40)}.`);
    }
  }
  const minimumBuild = optionalBuild(input.minimumBuild, "minimum");
  const latestBuild = optionalBuild(input.latestBuild, "latest");
  if (minimumBuild !== null && latestBuild !== null && minimumBuild > latestBuild) {
    throw new HttpError(400, "invalid_builds", "The minimum build cannot be newer than the latest build.");
  }
  return {
    label: label.trim(),
    notes: notes.trim(),
    contentChannel: channel as ContentChannel | null,
    flags: sanitizeFlags(rawFlags),
    minimumBuild,
    latestBuild,
  };
}

function optionalBuild(value: unknown, name: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_BUILD) {
    throw new HttpError(400, "invalid_builds", `The ${name} build must be a whole number.`);
  }
  return value;
}

/** Merge the platform default under the exact build: build values win, flag by flag. */
export function resolveAppConfig(platform: AppConfigPlatform, build: number, rows: BuildConfigRecord[]): AppConfigResponse {
  const fallback = rows.find((row) => row.build === DEFAULT_BUILD && row.platform === platform) ?? null;
  const exact = build === DEFAULT_BUILD ? null : rows.find((row) => row.build === build && row.platform === platform) ?? null;
  const minimumBuild = exact?.minimumBuild ?? fallback?.minimumBuild ?? null;
  const latestBuild = exact?.latestBuild ?? fallback?.latestBuild ?? null;
  // Build 0 is an unversioned web or development build, which never needs a store update.
  const update = build === DEFAULT_BUILD ? "none"
    : minimumBuild !== null && build < minimumBuild ? "required"
      : latestBuild !== null && build < latestBuild ? "available" : "none";
  return {
    schema: "parkdex.app-config/v1",
    platform,
    build,
    contentChannel: exact?.contentChannel ?? fallback?.contentChannel ?? null,
    flags: { ...fallback?.flags, ...exact?.flags },
    minimumBuild,
    latestBuild,
    update,
    source: exact ? "build" : fallback ? "default" : "none",
  };
}

export interface AppConfigHandlers {
  json(data: unknown, status?: number): Response;
  requireOperator(): Promise<void>;
  sameOriginRequired(): void;
  store(): AppConfigStore;
}

const OPERATOR_ROW = /^\/api\/operator\/app-config\/([a-z]+)\/(\d{1,10})$/;

/** Routes `/api/app-config` (public) and `/api/operator/app-config` (operator only). Returns null for other paths. */
export async function handleAppConfigRequest(request: Request, handlers: AppConfigHandlers): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/api/app-config") {
    if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "Use GET.");
    const platform = parsePlatform(url.searchParams.get("platform"));
    const build = parseBuild(url.searchParams.get("build"));
    const rows = await handlers.store().resolve(platform, build);
    return handlers.json(resolveAppConfig(platform, build, rows));
  }
  if (path === "/api/operator/app-config") {
    if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "Use GET.");
    await handlers.requireOperator();
    return handlers.json({ builds: await handlers.store().list(), flags: FEATURE_FLAGS, channels: CONTENT_CHANNELS });
  }
  const row = OPERATOR_ROW.exec(path);
  if (!row) return null;
  if (request.method !== "PUT" && request.method !== "DELETE") throw new HttpError(405, "method_not_allowed", "Use PUT or DELETE.");
  handlers.sameOriginRequired();
  await handlers.requireOperator();
  const platform = parsePlatform(row[1]);
  const build = parseBuild(row[2]);
  if (request.method === "DELETE") {
    if (!await handlers.store().remove(platform, build)) throw new HttpError(404, "not_found", "Build configuration not found.");
    return handlers.json({ ok: true });
  }
  const input = validateBuildConfigInput(await readJsonBody(request, 4096));
  return handlers.json({ build: await handlers.store().upsert(platform, build, input) });
}
