import { API_POINTERS, createNeonAppConfigStore, FEATURE_FLAGS, parseBuild, parseEnvironment, parsePlatform, validateBuildConfigInput, validateUpdateRulesInput, type AppConfigStore } from "../../../worker/appConfig.js";
import { readJsonBody } from "../../../worker/validation.js";
import type { DashboardEnv, SectionContext } from "../api.js";
import { allowMethods, databaseUrl, HttpError, json } from "../http.js";

/**
 * App and updates section under /api/app: build config now, over-the-air updates next.
 *
 * Installed apps read build config from production only, so these routes always use the
 * deployment's own database (context.baseEnv) and never follow the staging toggle.
 */

/** Settings this section reads from the deployment. Add R2 and CDN settings for updates here. */
export interface AppEnv {}

export interface AppDependencies {
  appConfigStore?(env: DashboardEnv): AppConfigStore;
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
    return json({ builds, rules, knownFlags: FEATURE_FLAGS.filter((flag) => !RETIRED_FLAGS.includes(flag)), retiredFlags: RETIRED_FLAGS, pointers: API_POINTERS });
  }

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
      if (!await store().remove(platform, number)) throw new HttpError(404, "not_found", "Build configuration not found.");
      return json({ ok: true });
    }
    const input = validateBuildConfigInput(await readJsonBody(request, 8192));
    return json({ build: await store().upsert(platform, number, input) });
  }

  return null;
}
