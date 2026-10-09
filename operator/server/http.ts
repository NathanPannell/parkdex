import { HttpError } from "../../worker/validation.js";

/** Response and request helpers shared by every section's routes, so errors look the same everywhere. */

export { HttpError };

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

/** The one error shape the client reads: { error: { code, message } }. Unknown errors never leak details. */
export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) return json({ error: { code: error.code, message: error.message } }, error.status);
  return json({ error: { code: "service_unavailable", message: "The dashboard service is temporarily unavailable." } }, 503);
}

export function notFound(): Response {
  return json({ error: { code: "not_found", message: "API route not found." } }, 404);
}

export function databaseUrl(env: { DATABASE_URL?: string }): string {
  if (!env.DATABASE_URL) throw new HttpError(503, "service_unavailable", "The dashboard database is not configured.");
  return env.DATABASE_URL;
}

/** Throws 405 unless the request uses one of the given methods. */
export function allowMethods(request: Request, ...methods: string[]): void {
  if (!methods.includes(request.method)) {
    const list = methods.length === 1 ? methods[0] : `${methods.slice(0, -1).join(", ")} or ${methods[methods.length - 1]}`;
    throw new HttpError(405, "method_not_allowed", `Use ${list}.`);
  }
}

export function plainObject(value: unknown, keys: string[], message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new HttpError(400, "invalid_request", message);
  }
  return value as Record<string, unknown>;
}
