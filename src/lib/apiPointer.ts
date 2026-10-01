import { KIP_PRODUCTION_ORIGIN, KIP_STAGING_ORIGIN } from "./userDataDestination";

/**
 * A native build's API pointer: which server (production or staging) it talks to for accounts,
 * backups, feedback, interactions and content. Remote configuration can point a build away from
 * the server it was built for; the choice is applied once at startup, before any request.
 */

export type ApiPointer = "production" | "staging";

let override: ApiPointer | null = null;

/** Set once at startup, only for native builds made for production or staging. */
export function setApiPointerOverride(pointer: ApiPointer | null): void {
  override = pointer;
}

export function apiPointerOverride(): ApiPointer | null {
  return override;
}

/** The server this build was made for, from its build environment. Preview builds have none. */
export function bakedApiPointer(): ApiPointer | null {
  const value = import.meta.env.VITE_CONTENT_ENV;
  return value === "main" ? "production" : value === "staging" || value === undefined ? "staging" : null;
}

/** The environment name the API origin checks expect, following any remote pointer. */
export function apiEnvironment(): "main" | "staging" | "preview" | undefined {
  if (override) return override === "production" ? "main" : "staging";
  return import.meta.env.VITE_CONTENT_ENV;
}

/** A build's configured API URL belongs to its own server; once pointed elsewhere, use that server's origin. */
export function apiUrl(configured: string | undefined): string | undefined {
  if (!override) return configured;
  return override === "production" ? KIP_PRODUCTION_ORIGIN : KIP_STAGING_ORIGIN;
}
