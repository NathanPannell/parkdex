import type { SectionContext } from "../api.js";

/**
 * Analytics section under /api/analytics: headline numbers, the accounts table and the event
 * explorer (#135). Nothing is served yet, so every path is a 404.
 */

/** Settings this section reads from the deployment, such as the PostHog personal API key. */
export interface AnalyticsEnv {}

/** Stores and clients the section uses, so tests and the local demo can swap them out. */
export interface AnalyticsDependencies {}

export async function analyticsRoutes(_request: Request, _context: SectionContext): Promise<Response | null> {
  return null;
}
