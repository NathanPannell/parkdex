import { database } from "./db.js";
import { HttpError } from "./validation.js";

/**
 * Remote app configuration. Every native build checks in with the production API on launch.
 *
 * - Update rules are global per environment: builds below an environment's minimum must update,
 *   builds below its latest get a nudge. A build's environment is its API pointer, else the
 *   environment it was built for (sent as `env`; builds 8 and earlier send none, so production).
 * - The API pointer and feature flags are set per build. Build 0 is the default for every build
 *   of a platform; a specific build overrides it, flag by flag.
 */

export const APP_CONFIG_PLATFORMS = ["android", "web"] as const;
export type AppConfigPlatform = (typeof APP_CONFIG_PLATFORMS)[number];

export const API_POINTERS = ["production", "staging"] as const;
export type ApiPointer = (typeof API_POINTERS)[number];

/** Kept in responses for builds 8 and earlier, which only understand content channels. */
export const CONTENT_CHANNELS = ["staging", "main"] as const;
export type ContentChannel = (typeof CONTENT_CHANNELS)[number];

/** Flags the current app reads. Any other well-formed flag is stored and sent too. */
export const FEATURE_FLAGS = ["rankProgression", "parkProposals"] as const;
export type FeatureFlags = Record<string, boolean>;
const FLAG_NAME = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;
const MAX_FLAGS = 64;

export const DEFAULT_BUILD = 0;
const MAX_BUILD = 2_100_000_000;

export interface BuildConfigRecord {
  platform: AppConfigPlatform;
  build: number;
  label: string;
  apiPointer: ApiPointer | null;
  flags: FeatureFlags;
  notes: string;
  updatedAt: string;
}

export interface BuildConfigInput {
  label: string;
  apiPointer: ApiPointer | null;
  flags: FeatureFlags;
  notes: string;
}

export interface UpdateRules {
  environment: ApiPointer;
  minimumBuild: number | null;
  latestBuild: number | null;
  updatedAt: string | null;
}

export interface AppConfigStore {
  /** The exact build row and the platform default row, when they exist. */
  resolve(platform: AppConfigPlatform, build: number): Promise<BuildConfigRecord[]>;
  list(): Promise<BuildConfigRecord[]>;
  upsert(platform: AppConfigPlatform, build: number, input: BuildConfigInput): Promise<BuildConfigRecord>;
  remove(platform: AppConfigPlatform, build: number): Promise<boolean>;
  updateRules(environment: ApiPointer): Promise<UpdateRules>;
  listUpdateRules(): Promise<UpdateRules[]>;
  setUpdateRules(environment: ApiPointer, minimumBuild: number | null, latestBuild: number | null): Promise<UpdateRules>;
}

export interface AppConfigResponse {
  schema: "parkdex.app-config/v1";
  platform: AppConfigPlatform;
  build: number;
  /** Which server's API and content this build should use from its next launch; null keeps its own. */
  apiPointer: ApiPointer | null;
  /** The same choice for builds 8 and earlier, which only switch park content. */
  contentChannel: ContentChannel | null;
  flags: FeatureFlags;
  /** The environment whose update rules applied. */
  environment: ApiPointer;
  /** Builds below this must update from the store before they can be used. */
  minimumBuild: number | null;
  /** The newest build in the store; older builds get a dismissable nudge. */
  latestBuild: number | null;
  update: "required" | "available" | "none";
  /** Which rows contributed: the exact build, the platform default, or neither. */
  source: "build" | "default" | "none";
}

type BuildRow = {
  platform: string;
  build: number;
  label: string;
  api_pointer: string | null;
  flags: unknown;
  notes: string;
  updated_at: string | Date;
};

type RulesRow = { environment: string; minimum_build: number | null; latest_build: number | null; updated_at: string | Date | null };

function toRecord(row: BuildRow): BuildConfigRecord {
  return {
    platform: row.platform as AppConfigPlatform,
    build: Number(row.build),
    label: row.label,
    apiPointer: (row.api_pointer as ApiPointer | null) ?? null,
    flags: sanitizeFlags(row.flags),
    notes: row.notes,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function toRules(environment: ApiPointer, row: RulesRow | undefined): UpdateRules {
  return {
    environment,
    minimumBuild: row?.minimum_build === null || row?.minimum_build === undefined ? null : Number(row.minimum_build),
    latestBuild: row?.latest_build === null || row?.latest_build === undefined ? null : Number(row.latest_build),
    updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

const BUILD_COLUMNS = "platform, build, label, api_pointer, flags, notes, updated_at";

export function createNeonAppConfigStore(databaseUrl: string): AppConfigStore {
  const sql = database(databaseUrl);
  return {
    async resolve(platform, build) {
      const rows = await sql.query(`SELECT ${BUILD_COLUMNS} FROM kip_app_config.builds WHERE platform = $1 AND build IN ($2, $3)`, [platform, build, DEFAULT_BUILD]) as BuildRow[];
      return rows.map(toRecord);
    },
    async list() {
      const rows = await sql.query(`SELECT ${BUILD_COLUMNS} FROM kip_app_config.builds ORDER BY platform, build DESC`) as BuildRow[];
      return rows.map(toRecord);
    },
    async upsert(platform, build, input) {
      // The content channel column is kept in step for any reader of the original schema.
      const rows = await sql.query(
        `INSERT INTO kip_app_config.builds (platform, build, label, api_pointer, content_channel, flags, notes)
         VALUES ($1, $2, $3, $4, CASE $4::text WHEN 'production' THEN 'main' WHEN 'staging' THEN 'staging' END, $5::jsonb, $6)
         ON CONFLICT (platform, build) DO UPDATE SET
           label = EXCLUDED.label,
           api_pointer = EXCLUDED.api_pointer,
           content_channel = EXCLUDED.content_channel,
           flags = EXCLUDED.flags,
           notes = EXCLUDED.notes,
           updated_at = now()
         RETURNING ${BUILD_COLUMNS}`,
        [platform, build, input.label, input.apiPointer, JSON.stringify(input.flags), input.notes],
      ) as BuildRow[];
      return toRecord(rows[0]);
    },
    async remove(platform, build) {
      const rows = await sql.query("DELETE FROM kip_app_config.builds WHERE platform = $1 AND build = $2 RETURNING build", [platform, build]);
      return rows.length > 0;
    },
    async updateRules(environment) {
      const rows = await sql.query("SELECT environment, minimum_build, latest_build, updated_at FROM kip_app_config.update_rules WHERE environment = $1", [environment]) as RulesRow[];
      return toRules(environment, rows[0]);
    },
    async listUpdateRules() {
      const rows = await sql.query("SELECT environment, minimum_build, latest_build, updated_at FROM kip_app_config.update_rules") as RulesRow[];
      return API_POINTERS.map((environment) => toRules(environment, rows.find((row) => row.environment === environment)));
    },
    async setUpdateRules(environment, minimumBuild, latestBuild) {
      const rows = await sql.query(
        `INSERT INTO kip_app_config.update_rules (environment, minimum_build, latest_build) VALUES ($1, $2, $3)
         ON CONFLICT (environment) DO UPDATE SET minimum_build = EXCLUDED.minimum_build, latest_build = EXCLUDED.latest_build, updated_at = now()
         RETURNING environment, minimum_build, latest_build, updated_at`,
        [environment, minimumBuild, latestBuild],
      ) as RulesRow[];
      return toRules(environment, rows[0]);
    },
  };
}

/** Keep every well-formed boolean flag, including ones no current build reads. */
export function sanitizeFlags(value: unknown): FeatureFlags {
  const flags: FeatureFlags = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return flags;
  for (const [key, flag] of Object.entries(value as Record<string, unknown>)) {
    if (FLAG_NAME.test(key) && typeof flag === "boolean" && Object.keys(flags).length < MAX_FLAGS) flags[key] = flag;
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

export function parseEnvironment(value: unknown): ApiPointer {
  if (typeof value === "string" && (API_POINTERS as readonly string[]).includes(value)) return value as ApiPointer;
  throw new HttpError(400, "invalid_environment", "Environment must be production or staging.");
}

export function validateBuildConfigInput(body: unknown): BuildConfigInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "invalid_request", "Invalid build configuration.");
  }
  const input = body as Record<string, unknown>;
  const allowed = new Set(["label", "apiPointer", "flags", "notes"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new HttpError(400, "invalid_request", "Invalid build configuration.");
  const label = input.label ?? "";
  const notes = input.notes ?? "";
  if (typeof label !== "string" || label.length > 80) throw new HttpError(400, "invalid_label", "Label must be 80 characters or fewer.");
  if (typeof notes !== "string" || notes.length > 500) throw new HttpError(400, "invalid_notes", "Notes must be 500 characters or fewer.");
  const pointer = input.apiPointer ?? null;
  if (pointer !== null && !(API_POINTERS as readonly unknown[]).includes(pointer)) {
    throw new HttpError(400, "invalid_api_pointer", "The API pointer must be production, staging, or unset.");
  }
  const rawFlags = input.flags ?? {};
  if (typeof rawFlags !== "object" || rawFlags === null || Array.isArray(rawFlags)) {
    throw new HttpError(400, "invalid_flags", "Flags must be an object.");
  }
  const entries = Object.entries(rawFlags);
  if (entries.length > MAX_FLAGS) throw new HttpError(400, "invalid_flags", `A build can set at most ${MAX_FLAGS} flags.`);
  for (const [key, value] of entries) {
    if (!FLAG_NAME.test(key) || typeof value !== "boolean") {
      throw new HttpError(400, "invalid_flags", `Flag names start with a letter and use letters, digits or underscores; values are on or off (${key.slice(0, 40)}).`);
    }
  }
  return { label: label.trim(), notes: notes.trim(), apiPointer: pointer as ApiPointer | null, flags: sanitizeFlags(rawFlags) };
}

export function validateUpdateRulesInput(body: unknown): { minimumBuild: number | null; latestBuild: number | null } {
  if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).some((key) => key !== "minimumBuild" && key !== "latestBuild")) {
    throw new HttpError(400, "invalid_request", "Invalid update rules.");
  }
  const input = body as Record<string, unknown>;
  const minimumBuild = optionalBuild(input.minimumBuild, "minimum");
  const latestBuild = optionalBuild(input.latestBuild, "latest");
  if (minimumBuild !== null && latestBuild !== null && minimumBuild > latestBuild) {
    throw new HttpError(400, "invalid_builds", "The minimum build cannot be newer than the latest build.");
  }
  return { minimumBuild, latestBuild };
}

function optionalBuild(value: unknown, name: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_BUILD) {
    throw new HttpError(400, "invalid_builds", `The ${name} build must be a whole number.`);
  }
  return value;
}

/** A null pointer on a build's own row deliberately keeps that build's built-in server. */
function pointerFor(rows: BuildConfigRecord[], platform: AppConfigPlatform, build: number) {
  const fallback = rows.find((row) => row.build === DEFAULT_BUILD && row.platform === platform) ?? null;
  const exact = build === DEFAULT_BUILD ? null : rows.find((row) => row.build === build && row.platform === platform) ?? null;
  return { fallback, exact, apiPointer: exact ? exact.apiPointer : fallback?.apiPointer ?? null };
}

/** The environment whose update rules apply: the pointer if set, else what the build says it was made for. */
export function updateEnvironment(rows: BuildConfigRecord[], platform: AppConfigPlatform, build: number, declared: string | null): ApiPointer {
  return pointerFor(rows, platform, build).apiPointer ?? (declared === "staging" ? "staging" : "production");
}

/** The build's own row wins over the platform default, flag by flag; update rules come from its environment. */
export function resolveAppConfig(platform: AppConfigPlatform, build: number, rows: BuildConfigRecord[], rules: UpdateRules): AppConfigResponse {
  const { fallback, exact, apiPointer } = pointerFor(rows, platform, build);
  // Build 0 is an unversioned web or development build, which never needs a store update.
  const update = build === DEFAULT_BUILD ? "none"
    : rules.minimumBuild !== null && build < rules.minimumBuild ? "required"
      : rules.latestBuild !== null && build < rules.latestBuild ? "available" : "none";
  return {
    schema: "parkdex.app-config/v1",
    platform,
    build,
    apiPointer,
    contentChannel: apiPointer === "production" ? "main" : apiPointer === "staging" ? "staging" : null,
    flags: { ...fallback?.flags, ...exact?.flags },
    environment: rules.environment,
    minimumBuild: rules.minimumBuild,
    latestBuild: rules.latestBuild,
    update,
    source: exact ? "build" : fallback ? "default" : "none",
  };
}

/** Public product analytics settings, delivered at runtime so they can change without a build. */
export type AppAnalyticsConfig = { posthogKey: string; posthogHost: string };

export interface AppConfigHandlers {
  json(data: unknown, status?: number): Response;
  store(): AppConfigStore;
  /** Null when no PostHog project key is configured; the app then loads no analytics SDK. */
  analytics?(): AppAnalyticsConfig | null;
}

/**
 * Routes the public `/api/app-config` check-in. Returns null for other paths.
 * Editing configuration belongs to the separately deployed operator dashboard.
 */
export async function handleAppConfigRequest(request: Request, handlers: AppConfigHandlers): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/app-config") return null;
  if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "Use GET.");
  const platform = parsePlatform(url.searchParams.get("platform"));
  const build = parseBuild(url.searchParams.get("build"));
  const store = handlers.store();
  const rows = await store.resolve(platform, build);
  const rules = await store.updateRules(updateEnvironment(rows, platform, build, url.searchParams.get("env")));
  return handlers.json({ ...resolveAppConfig(platform, build, rows, rules), analytics: handlers.analytics?.() ?? null });
}
