import type { DeliveryDependencies } from "../../worker/feedbackDelivery.js";
import { analyticsRoutes, type AnalyticsDependencies, type AnalyticsEnv } from "./analytics/routes.js";
import { appRoutes, type AppDependencies, type AppEnv } from "./app/routes.js";
import { feedbackRoutes, type FeedbackDependencies, type FeedbackEnv } from "./feedback/routes.js";
import { errorResponse, HttpError, json, notFound } from "./http.js";
import { parksRoutes, type ParksDependencies, type ParksEnv } from "./parks/routes.js";

/**
 * The operator dashboard API. It has no sign-in of its own: every deployment of this app sits
 * behind Vercel Authentication, which rejects unauthenticated requests before they reach here.
 *
 * This file only does the work every section shares: the same-origin check, choosing the
 * database, /api/health and the error shape. Each section owns everything under its own prefix
 * in server/<section>/routes.ts, along with its env and dependency types.
 */

export interface DashboardEnv extends FeedbackEnv, ParksEnv, AnalyticsEnv, AppEnv {
  DATABASE_URL?: string;
  /** Shown in the UI so it is obvious which database the dashboard edits. */
  DASHBOARD_ENVIRONMENT?: string;
  /** Optional second database the operator can switch to, such as the staging branch. */
  STAGING_DATABASE_URL?: string;
}

export interface DashboardDependencies extends DeliveryDependencies, FeedbackDependencies, ParksDependencies, AnalyticsDependencies, AppDependencies {}

/** What a section's router gets for each request. */
export interface SectionContext {
  url: URL;
  /** The request path, for example /api/feedback/abc. */
  path: string;
  /**
   * The database the operator chose with the sidebar toggle. Reading it throws a 503 when the
   * operator chose staging and this deployment has no staging database, so staging is never
   * silently replaced by production.
   */
  readonly env: DashboardEnv;
  /** The deployment's own settings, which point at production. Build config reads only this. */
  readonly baseEnv: DashboardEnv;
  /** The database the operator is not looking at, or null when this deployment cannot reach it. */
  readonly otherEnv: DashboardEnv | null;
  readonly dependencies: DashboardDependencies;
  /** Call before any write. */
  requireSameOrigin(): void;
}

/** A section handles its own prefix and returns null for paths it does not know (a 404). */
export type SectionRoute = (request: Request, context: SectionContext) => Promise<Response | null>;

export interface Section {
  prefix: string;
  route: SectionRoute;
}

export const SECTIONS: readonly Section[] = [
  { prefix: "/api/feedback", route: feedbackRoutes },
  { prefix: "/api/parks", route: parksRoutes },
  { prefix: "/api/analytics", route: analyticsRoutes },
  { prefix: "/api/app", route: appRoutes },
];

// Vercel Authentication cookies are not sent on cross-site fetches, but a same-origin check
// keeps writes safe even if that ever changes.
export function requireSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) {
    throw new HttpError(403, "forbidden", "This change must come from the dashboard itself.");
  }
}

export const DATABASE_COOKIE = "parkdex_operator_db";

function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

/**
 * The dashboard edits production unless the operator switched to staging with the sidebar
 * toggle, which sets a cookie so image requests follow the same choice.
 */
export function selectDatabase(request: Request, env: DashboardEnv): DashboardEnv {
  if (cookie(request, DATABASE_COOKIE) !== "staging") return env;
  if (!env.STAGING_DATABASE_URL) throw new HttpError(503, "staging_unavailable", "The staging database is not configured on this deployment.");
  return { ...env, DATABASE_URL: env.STAGING_DATABASE_URL, DASHBOARD_ENVIRONMENT: "staging" };
}

/** The database the operator is not looking at, if this deployment can reach it. */
export function otherDatabase(request: Request, env: DashboardEnv): DashboardEnv | null {
  if (!env.STAGING_DATABASE_URL) return null;
  if (cookie(request, DATABASE_COOKIE) === "staging") return env;
  return { ...env, DATABASE_URL: env.STAGING_DATABASE_URL, DASHBOARD_ENVIRONMENT: "staging" };
}

function health(request: Request, env: DashboardEnv): Response {
  const staging = cookie(request, DATABASE_COOKIE) === "staging" && Boolean(env.STAGING_DATABASE_URL);
  return json({
    ok: true,
    environment: staging ? "staging" : (env.DASHBOARD_ENVIRONMENT ?? "unknown"),
    canSwitch: Boolean(env.STAGING_DATABASE_URL),
    emailMode: env.EMAIL_MODE === "disabled" ? "disabled" : env.RESEND_API_KEY ? "resend" : "unconfigured",
  });
}

export function sectionFor(path: string, sections: readonly Section[] = SECTIONS): Section | null {
  return sections.find((section) => path === section.prefix || path.startsWith(`${section.prefix}/`)) ?? null;
}

export function createDashboardApi(dependencies: DashboardDependencies = {}, sections: readonly Section[] = SECTIONS) {
  return async function handle(request: Request, baseEnv: DashboardEnv): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === "/api/health") return health(request, baseEnv);
      const section = sectionFor(path, sections);
      if (!section) return notFound();
      let selected: DashboardEnv | null = null;
      const context: SectionContext = {
        url,
        path,
        get env() {
          return (selected ??= selectDatabase(request, baseEnv));
        },
        baseEnv,
        otherEnv: otherDatabase(request, baseEnv),
        dependencies,
        requireSameOrigin: () => requireSameOrigin(request),
      };
      return (await section.route(request, context)) ?? notFound();
    } catch (error) {
      return errorResponse(error);
    }
  };
}
