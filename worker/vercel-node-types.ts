import type { IncomingMessage, ServerResponse } from "node:http";

// The two Node function types the API entrypoint uses, declared here so the app does not
// depend on the @vercel/node package (types only), whose pinned undici and path-to-regexp
// fail `npm audit --audit-level=high`. Vercel's own Node runtime still runs the function.
export type VercelRequest = IncomingMessage & {
  query: Partial<Record<string, string | string[]>>;
  cookies: Partial<Record<string, string>>;
  body: unknown;
};

export type VercelResponse = ServerResponse & {
  send(body: unknown): VercelResponse;
  json(body: unknown): VercelResponse;
  status(statusCode: number): VercelResponse;
};
