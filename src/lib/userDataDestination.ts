export type ParkdexApiEnvironment = "staging" | "main" | "preview";

export const KIP_STAGING_ORIGIN = "https://staging.web.parkdex.app";
export const KIP_PRODUCTION_ORIGIN = "https://web.parkdex.app";
export const KIP_STAGING_VERCEL_ORIGIN = "https://parkdex-kip-staging.vercel.app";
export const KIP_PRODUCTION_VERCEL_ORIGIN = "https://parkdex-kip.vercel.app";

const STAGING_ORIGINS = new Set([KIP_STAGING_ORIGIN, KIP_STAGING_VERCEL_ORIGIN]);
const PRODUCTION_ORIGINS = new Set([KIP_PRODUCTION_ORIGIN, KIP_PRODUCTION_VERCEL_ORIGIN]);
const ALL_DEPLOYED_ORIGINS = new Set([...STAGING_ORIGINS, ...PRODUCTION_ORIGINS]);

export type UserDataDestinationOptions = {
  native: boolean;
  webOrigin?: string;
  allowLoopbackHttp?: boolean;
  environment?: ParkdexApiEnvironment | string;
  previewOrigin?: string;
};

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * Development builds only: an http loopback origin, such as the Vite dev server proxying to
 * `npm run local:api`. Production and field builds compile this to false.
 */
export function isDevLoopbackHttp(url: URL, dev: boolean = Boolean(import.meta.env?.DEV)): boolean {
  return dev && url.protocol === "http:" && isLoopback(url.hostname) && !hasUrlCredentials(url);
}

export function hasUrlCredentials(url: URL): boolean {
  const authority = url.href.slice(url.protocol.length + 2).split(/[/?#]/, 1)[0];
  return Boolean(url.username || url.password || authority.includes("@"));
}

export function hasRawUrlCredentials(value: string): boolean {
  const authority = value.trim().match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i)?.[1];
  return Boolean(authority?.includes("@"));
}

function parseOrigin(value: string, allowLoopbackHttp = false): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("The Parkdex API destination must be a valid HTTPS origin.");
  }

  const secure = url.protocol === "https:";
  const localDevelopment = allowLoopbackHttp && url.protocol === "http:" && isLoopback(url.hostname);
  if ((!secure && !localDevelopment) || url.origin === "null" || hasUrlCredentials(url) || hasRawUrlCredentials(value) || url.search || url.hash ||
      !["", "/"].includes(url.pathname) || (secure && url.port && url.port !== "443")) {
    throw new Error("The Parkdex API destination must be an approved HTTPS origin.");
  }
  return url.origin;
}

function nativeEnvironment(value: string | undefined): ParkdexApiEnvironment {
  if (!value || value === "staging") return "staging";
  if (value === "main") return "main";
  if (value === "preview") return "preview";
  throw new Error("The Parkdex API environment is not recognized.");
}

function defaultNativeOrigin(environment: ParkdexApiEnvironment): string {
  if (environment === "main") return KIP_PRODUCTION_ORIGIN;
  if (environment === "staging") return KIP_STAGING_ORIGIN;
  throw new Error("A preview app must be bound to its exact preview API origin.");
}

/** Resolve the destination for requests containing personal, account, or diagnostic data. */
export function resolveUserDataApiOrigin(
  configuredValue: string | undefined,
  options: UserDataDestinationOptions,
): string {
  const configured = (configuredValue ?? "").trim();

  if (options.native) {
    const environment = nativeEnvironment(options.environment);
    let origin: string;
    if (environment === "preview") {
      if (!options.previewOrigin) throw new Error("A preview app must be bound to its exact preview API origin.");
      const previewOrigin = parseOrigin(options.previewOrigin);
      origin = configured ? parseOrigin(configured) : previewOrigin;
      if (origin !== previewOrigin) throw new Error("The native preview API must match its configured preview origin.");
      return origin;
    }

    const approved = environment === "main" ? PRODUCTION_ORIGINS : STAGING_ORIGINS;
    origin = configured ? parseOrigin(configured) : defaultNativeOrigin(environment);
    if (!approved.has(origin)) throw new Error("The native account API is not approved for this Parkdex environment.");
    return origin;
  }

  if (!options.webOrigin) {
    if (configured) throw new Error("A configured Parkdex API destination requires a page origin.");
    return "";
  }

  const pageOrigin = parseOrigin(options.webOrigin, options.allowLoopbackHttp);
  if (!configured) return pageOrigin;
  const configuredOrigin = parseOrigin(configured, options.allowLoopbackHttp);
  if (configuredOrigin !== pageOrigin) {
    throw new Error("Web account and feedback requests must use the current Parkdex page origin.");
  }
  return pageOrigin;
}

export function isApprovedKipOrigin(origin: string): boolean {
  return ALL_DEPLOYED_ORIGINS.has(origin);
}

export function isSecureUserDataApiOrigin(value: string): boolean {
  try {
    return value === parseOrigin(value) && value.startsWith("https://");
  } catch {
    return false;
  }
}

export function assertUserDataApiBuildConfiguration(
  environment: Record<string, string | undefined>,
  options: { mode: string; vercelUrl?: string },
): void {
  const appEnvironment = nativeEnvironment(environment.VITE_CONTENT_ENV);
  const configuredKeys = ["VITE_APP_URL", "VITE_ACCOUNT_API_URL", "VITE_FEEDBACK_API_URL"] as const;
  const deployedVercelUrl = options.vercelUrl?.trim();
  const deployedVercelOrigin = deployedVercelUrl
    ? parseOrigin(/^https:\/\//i.test(deployedVercelUrl) ? deployedVercelUrl : `https://${deployedVercelUrl}`)
    : null;
  const configuredPreviewOrigin = environment.VITE_PREVIEW_API_ORIGIN?.trim()
    ? parseOrigin(environment.VITE_PREVIEW_API_ORIGIN)
    : null;
  const allowedEnvironmentOrigins = appEnvironment === "main" ? PRODUCTION_ORIGINS
    : appEnvironment === "staging" ? STAGING_ORIGINS : null;

  if (appEnvironment === "preview" && (!deployedVercelOrigin || configuredPreviewOrigin !== deployedVercelOrigin)) {
    throw new Error("Preview builds require VITE_PREVIEW_API_ORIGIN to match the exact Vercel deployment URL.");
  }
  if (appEnvironment !== "preview" && configuredPreviewOrigin) {
    throw new Error("VITE_PREVIEW_API_ORIGIN is only valid in an explicitly identified preview build.");
  }

  for (const key of configuredKeys) {
    const value = environment[key];
    if (!value?.trim()) continue;
    const origin = parseOrigin(value, options.mode === "development");
    if (options.mode === "development" && origin.startsWith("http://")) continue;

    if (appEnvironment === "preview") {
      if (origin !== configuredPreviewOrigin) {
        throw new Error(`${key} in a preview build must match VITE_PREVIEW_API_ORIGIN.`);
      }
      continue;
    }

    if (!allowedEnvironmentOrigins?.has(origin) && origin !== deployedVercelOrigin) {
      throw new Error(`${key} is not an approved origin for the ${appEnvironment} Parkdex build.`);
    }
  }
}
