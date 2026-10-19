import {
  API_POINTERS,
  createNeonAppConfigStore,
  FEATURE_FLAGS,
  parseBuild,
  parseEnvironment,
  parsePlatform,
  validateBuildConfigInput,
  validateUpdateRulesInput,
  type AppConfigStore,
} from "../../../worker/appConfig.js";
import { readJsonBody } from "../../../worker/validation.js";
import type { DashboardEnv, SectionContext } from "../api.js";
import { allowMethods, databaseUrl, HttpError, json } from "../http.js";
import { createNeonOtaHistoryStore, type KnownBundle, type OtaHistoryStore, type OtaPublish } from "./history.js";
import { CDN_ORIGIN, checkLiveEndpoint, loadChannelsAndBundles, movePointer, parseChannel, parseNativeBuild, UPDATE_ENDPOINTS, validateMove } from "./ota.js";
import { assetsBucket, createCloudflareR2, failureText, type Fetcher, type R2Client, type R2Env } from "./r2.js";
import { setupChecklist } from "./setup.js";

/**
 * App and updates section under /api/app: build config and over-the-air updates.
 *
 * Installed apps read build config from production only, and both update channels are recorded
 * in production, so these routes always use the deployment's own database (context.baseEnv) and
 * never follow the staging toggle.
 */

/** Settings this section reads from the deployment. */
export interface AppEnv extends R2Env {
  /** Only checked for presence, for the setup checklist (Analytics reads them). */
  POSTHOG_PERSONAL_API_KEY?: string;
  POSTHOG_PROJECT_ID?: string;
}

export interface AppDependencies {
  appConfigStore?(env: DashboardEnv): AppConfigStore;
  otaHistoryStore?(env: DashboardEnv): OtaHistoryStore;
  /** Cloudflare API, CDN and update endpoint requests. Tests and the demo pass a fake. */
  otaFetch?: Fetcher;
  /** Replaces the Cloudflare client built from CLOUDFLARE_* (the local demo has no real token). */
  otaR2?(env: DashboardEnv): R2Client | null;
  otaNow?(): number;
}

const HISTORY_ROWS = 50;

/** Whether the history table is there, with the reason when the database could not be asked. */
async function historyState(history: () => OtaHistoryStore): Promise<{ store: OtaHistoryStore | null; available: boolean | null; error: string | null }> {
  let store: OtaHistoryStore;
  try {
    store = history();
    return { store, available: await store.available(), error: null };
  } catch (error) {
    return { store: null, available: null, error: error instanceof HttpError ? error.message : failureText(error) };
  }
}

async function safely<T>(work: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await work();
  } catch {
    return fallback;
  }
}

/**
 * Flags the flag game retired. worker/appConfig.ts still lists them because installed builds may
 * read them, but the dashboard no longer offers them for new rows.
 */
export const RETIRED_FLAGS: readonly string[] = ["rankProgression", "parkProposals"];

export async function appRoutes(request: Request, context: SectionContext): Promise<Response | null> {
  const { path } = context;
  const store = () => context.dependencies.appConfigStore?.(context.baseEnv) ?? createNeonAppConfigStore(databaseUrl(context.baseEnv));

  if (path === "/api/app/builds") {
    allowMethods(request, "GET");
    const config = store();
    const [builds, rules] = await Promise.all([config.list(), config.listUpdateRules()]);
    return json({
      builds,
      rules,
      knownFlags: FEATURE_FLAGS.filter((flag) => !RETIRED_FLAGS.includes(flag)),
      retiredFlags: RETIRED_FLAGS,
      pointers: API_POINTERS,
    });
  }

  if (path === "/api/app/updates" || path.startsWith("/api/app/updates/")) return updatesRoutes(request, context);

  const rules = /^\/api\/app\/update-rules\/([a-z]+)$/.exec(path);
  if (rules) {
    allowMethods(request, "PUT");
    context.requireSameOrigin();
    const environment = parseEnvironment(rules[1]);
    const { minimumBuild, latestBuild } = validateUpdateRulesInput(await readJsonBody(request, 1024));
    return json({ rules: await store().setUpdateRules(environment, minimumBuild, latestBuild) });
  }

  const build = /^\/api\/app\/builds\/([a-z]+)\/(\d{1,10})$/.exec(path);
  if (build) {
    allowMethods(request, "PUT", "DELETE");
    context.requireSameOrigin();
    const platform = parsePlatform(build[1]);
    const number = parseBuild(build[2]);
    if (request.method === "DELETE") {
      if (!(await store().remove(platform, number))) throw new HttpError(404, "not_found", "Build configuration not found.");
      return json({ ok: true });
    }
    const input = validateBuildConfigInput(await readJsonBody(request, 8192));
    return json({ build: await store().upsert(platform, number, input) });
  }

  return null;
}

async function updatesRoutes(request: Request, context: SectionContext): Promise<Response | null> {
  const { path, url, dependencies } = context;
  const env = context.baseEnv;
  const fetcher: Fetcher = dependencies.otaFetch ?? ((input, init) => fetch(input, init));
  const history = (): OtaHistoryStore => dependencies.otaHistoryStore?.(env) ?? createNeonOtaHistoryStore(databaseUrl(env));
  const r2 = () => (dependencies.otaR2 ? dependencies.otaR2(env) : createCloudflareR2(env, fetcher));

  if (path === "/api/app/updates") {
    allowMethods(request, "GET");
    const state = await historyState(history);
    const store = state.store;
    const historyAvailable = state.available;
    const [rows, known] = historyAvailable
      ? await Promise.all([safely(() => store!.list(HISTORY_ROWS), [] as OtaPublish[]), safely(() => store!.bundles(), [] as KnownBundle[])])
      : [[] as OtaPublish[], [] as KnownBundle[]];
    const client = r2();
    const loaded = await loadChannelsAndBundles(fetcher, client, known);
    return json({
      cdnOrigin: CDN_ORIGIN,
      bucket: assetsBucket(env),
      endpoints: UPDATE_ENDPOINTS,
      cloudflare: { configured: client !== null, error: loaded.bundlesError },
      probe: loaded.probe,
      channels: loaded.channels,
      bundles: loaded.bundles,
      history: { available: historyAvailable, error: state.error, rows },
    });
  }

  if (path === "/api/app/updates/setup") {
    allowMethods(request, "GET");
    const state = await historyState(history);
    const client = r2();
    const loaded = await loadChannelsAndBundles(fetcher, client, []);
    const items = await setupChecklist({
      probe: loaded.probe,
      channels: loaded.channels,
      cloudflare: { configured: client !== null, error: loaded.bundlesError, bucket: client?.bucket ?? assetsBucket(env) },
      historyAvailable: state.available,
      historyError: state.error,
      posthog: Boolean(env.POSTHOG_PERSONAL_API_KEY?.trim() && env.POSTHOG_PROJECT_ID?.trim()),
      fetch: fetcher,
    });
    return json({ items });
  }

  if (path === "/api/app/updates/check") {
    allowMethods(request, "GET");
    const channel = parseChannel(url.searchParams.get("channel"));
    const build = parseNativeBuild(url.searchParams.get("build"), "Native build");
    const version = (url.searchParams.get("version") ?? "builtin").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(version)) throw new HttpError(400, "invalid_version", "The current version is a bundle version or builtin.");
    return json(await checkLiveEndpoint(fetcher, channel, build, version));
  }

  if (path === "/api/app/updates/move") {
    allowMethods(request, "POST");
    context.requireSameOrigin();
    const input = validateMove(await readJsonBody(request, 4096));
    const client = r2();
    if (!client)
      throw new HttpError(
        503,
        "cloudflare_not_configured",
        "Publishing from the dashboard needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID on this deployment.",
      );
    const state = await historyState(history);
    const recorded = state.available ? state.store : null;
    const result = await movePointer(input, { r2: client, fetch: fetcher, history: recorded, now: dependencies.otaNow ?? Date.now });
    if (result.outcome === "conflict") throw new HttpError(409, "readback_mismatch", result.message);
    return json(result);
  }

  return null;
}
