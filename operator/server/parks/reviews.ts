import {
  createSqlFoundingReviewStore, emptyCounts, rejectionReason, REVIEW_STATUSES,
  type AnalyticsEnvironment, type FoundingReviewStore, type ReviewStatus,
} from "../../../worker/founding-reviews.js";
import { readJsonBody } from "../../../worker/validation.js";
import type { DashboardEnv, SectionContext } from "../api.js";
import { allowMethods, databaseUrl, HttpError, json, plainObject } from "../http.js";
import { neonRunner } from "./manager.js";

/**
 * Parks → Review (#153): players' requests for a manual review of a founding photo the check
 * turned down. The queue, one request with its photo, and Approve or Reject. The SQL, including
 * the shared founding transaction an approval runs, lives in worker/founding-reviews.ts.
 */

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIST_LIMIT = 200;

export function reviewStore(context: SectionContext): FoundingReviewStore {
  return context.dependencies.foundingReviewStore?.(context.env) ?? createSqlFoundingReviewStore(neonRunner(databaseUrl(context.env)));
}

/** The analytics environment of the database the toggle chose, for the decision events. */
export function analyticsEnvironment(env: DashboardEnv): AnalyticsEnvironment {
  const label = env.DASHBOARD_ENVIRONMENT?.trim().toLowerCase();
  if (label === "production" || label === "main") return "main";
  if (label === "staging") return "staging";
  return "preview";
}

function statusParam(url: URL): ReviewStatus | null {
  const value = url.searchParams.get("status") ?? "pending";
  if (value === "all") return null;
  if (!(REVIEW_STATUSES as readonly string[]).includes(value)) throw new HttpError(400, "invalid_status", "Status is pending, approved, rejected, superseded or all.");
  return value as ReviewStatus;
}

/** Handles /api/parks/review and below; null for every other path. */
export async function reviewRoutes(request: Request, context: SectionContext, now: () => string): Promise<Response | null> {
  const { path, url } = context;
  if (path === "/api/parks/review") {
    allowMethods(request, "GET");
    const listed = await reviewStore(context).list(statusParam(url), LIST_LIMIT);
    // A database a release behind has no review table yet; the page says so instead of failing.
    if (!listed) return json({ available: false, counts: emptyCounts(), requests: [] });
    return json({ available: true, ...listed });
  }
  if (path === "/api/parks/review/count") {
    allowMethods(request, "GET");
    const listed = await reviewStore(context).list("pending", 1);
    return json({ available: Boolean(listed), pending: listed?.counts.pending ?? 0 });
  }
  const match = /^\/api\/parks\/review\/([^/]+)(?:\/(photo|approve|reject))?$/.exec(path);
  if (!match) return null;
  const [, id, action] = match;
  if (!ID.test(id)) throw new HttpError(404, "not_found", "That review request does not exist.");
  const store = reviewStore(context);

  if (!action) {
    allowMethods(request, "GET");
    const detail = await store.get(id.toLowerCase());
    if (!detail) throw new HttpError(404, "not_found", "That review request does not exist.");
    return json({ request: detail });
  }
  if (action === "photo") {
    allowMethods(request, "GET");
    const photo = await store.photo(id.toLowerCase());
    if (!photo) throw new HttpError(404, "not_found", "This request has no photo any more.");
    return new Response(new Uint8Array(photo.bytes), {
      headers: {
        "content-type": photo.contentType ?? "image/jpeg", "cache-control": "private, no-store", etag: `"${photo.sha256}"`,
        "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      },
    });
  }
  allowMethods(request, "POST");
  context.requireSameOrigin();
  const environment = analyticsEnvironment(context.env);
  if (action === "approve") {
    // No body is needed; an empty object is accepted for clients that always send one.
    if (request.headers.get("content-type")) plainObject(await readJsonBody(request, 1024), [], "Approve takes no fields.");
    const result = await store.approve(id.toLowerCase(), { at: now(), environment });
    return json({ ok: true, ...result });
  }
  const body = plainObject(await readJsonBody(request, 4096), ["reasonCode", "reason"], "Send { reasonCode, reason }.");
  const reason = rejectionReason(body.reasonCode, body.reason);
  await store.reject(id.toLowerCase(), { at: now(), environment, ...reason });
  return json({ ok: true, ...reason });
}
