type RequestLike = {
  method?: string;
  headers: Record<string, string | string[] | undefined> & {
    get?: (name: string) => string | null;
  };
};

type ResponseLike = {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
};

type ChannelEnvironment = "staging" | "main";
type ContentChannel = {
  schema: "parkdex.content-channel/v1";
  environment: ChannelEnvironment;
  generation: number;
  releaseId: string;
  manifestUrl: string;
  manifestSha256: string;
  minimumReaderVersion: number;
};

type HandlerOptions = {
  env?: Record<string, string | undefined>;
  fetcher?: typeof fetch;
};

const CDN_ORIGIN = "https://kip-assets.parkdex.app";
const ALLOWED_ORIGINS = new Set([
  "https://localhost",
  "https://staging.web.parkdex.app",
  "https://web.parkdex.app",
]);
const PUBLIC_CACHE_CONTROL = "public, max-age=60, s-maxage=60";
const NO_STORE_CACHE_CONTROL = "no-store";
const HEX_SHA256 = /^[a-f0-9]{64}$/;

function header(request: RequestLike, name: string): string | undefined {
  const fromGetter = request.headers.get?.(name);
  if (fromGetter !== null && fromGetter !== undefined) return fromGetter;
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function setCors(request: RequestLike, response: ResponseLike): void {
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "If-None-Match");
  response.setHeader("Access-Control-Expose-Headers", "Cache-Control, ETag, Last-Modified");
  const origin = header(request, "origin");
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
  }
}

function configuredChannel(env: Record<string, string | undefined>): ChannelEnvironment {
  const configured = env.CONTENT_CHANNEL?.trim();
  if (configured) {
    if (configured === "staging" || configured === "main") return configured;
    throw new Error("CONTENT_CHANNEL must be staging or main");
  }

  const deployment = env.VERCEL_ENV;
  if (
    deployment === "preview" ||
    deployment === "development" ||
    (deployment !== "production" && env.NODE_ENV !== "production")
  ) {
    return "staging";
  }
  throw new Error("CONTENT_CHANNEL is required in production");
}

function validateChannel(value: unknown, expectedEnvironment: ChannelEnvironment): ContentChannel {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("content channel must be an object");
  }
  const channel = value as Record<string, unknown>;
  const expectedKeys = [
    "schema",
    "environment",
    "generation",
    "releaseId",
    "manifestUrl",
    "manifestSha256",
    "minimumReaderVersion",
  ];
  if (
    Object.keys(channel).length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(channel, key))
  ) {
    throw new Error("content channel has unexpected or missing fields");
  }
  if (channel.schema !== "parkdex.content-channel/v1") {
    throw new Error("content channel schema is unsupported");
  }
  if (channel.environment !== expectedEnvironment) {
    throw new Error("content channel environment does not match server configuration");
  }
  if (!Number.isSafeInteger(channel.generation) || (channel.generation as number) < 1) {
    throw new Error("content channel generation must be a positive integer");
  }
  if (typeof channel.releaseId !== "string" || !HEX_SHA256.test(channel.releaseId)) {
    throw new Error("content channel releaseId is invalid");
  }
  const expectedManifestUrl =
    CDN_ORIGIN + "/releases/" + channel.releaseId + "/manifest.json";
  if (channel.manifestUrl !== expectedManifestUrl) {
    throw new Error("content channel manifestUrl does not match its releaseId");
  }
  if (typeof channel.manifestSha256 !== "string" || !HEX_SHA256.test(channel.manifestSha256)) {
    throw new Error("content channel manifestSha256 is invalid");
  }
  if (
    !Number.isSafeInteger(channel.minimumReaderVersion) ||
    (channel.minimumReaderVersion as number) < 1
  ) {
    throw new Error("content channel minimumReaderVersion must be a positive integer");
  }
  return channel as ContentChannel;
}

function sendError(
  response: ResponseLike,
  status: number,
  message: string,
  cacheControl = NO_STORE_CACHE_CONTROL,
): void {
  response.statusCode = status;
  response.setHeader("Cache-Control", cacheControl);
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify({ error: message }));
}

export function createCurrentHandler(options: HandlerOptions = {}) {
  const env = options.env ?? process.env;
  const fetcher = options.fetcher ?? fetch;

  return async function currentHandler(request: RequestLike, response: ResponseLike): Promise<void> {
    setCors(request, response);
    const method = (request.method ?? "GET").toUpperCase();
    if (method === "OPTIONS") {
      response.statusCode = 204;
      response.setHeader("Cache-Control", NO_STORE_CACHE_CONTROL);
      response.end();
      return;
    }
    if (method !== "GET" && method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD, OPTIONS");
      sendError(response, 405, "Method Not Allowed");
      return;
    }

    let channel: ChannelEnvironment;
    try {
      channel = configuredChannel(env);
    } catch (error) {
      sendError(response, 500, error instanceof Error ? error.message : "Content channel is misconfigured");
      return;
    }

    const url = CDN_ORIGIN + "/channels/" + channel + "/current.json";
    const requestHeaders: Record<string, string> = {};
    const ifNoneMatch = header(request, "if-none-match");
    if (ifNoneMatch) requestHeaders["If-None-Match"] = ifNoneMatch;

    let upstream: Response;
    try {
      upstream = await fetcher(url, {
        method,
        headers: requestHeaders,
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      sendError(response, 502, "Content channel could not be reached");
      return;
    }

    response.setHeader("Cache-Control", PUBLIC_CACHE_CONTROL);
    const etag = upstream.headers.get("ETag");
    if (etag) response.setHeader("ETag", etag);
    const lastModified = upstream.headers.get("Last-Modified");
    if (lastModified) response.setHeader("Last-Modified", lastModified);

    if (upstream.status === 304) {
      response.statusCode = 304;
      response.end();
      return;
    }
    if (!upstream.ok) {
      sendError(response, 502, "Content channel is unavailable");
      return;
    }
    if (method === "HEAD") {
      response.statusCode = 200;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end();
      return;
    }

    let raw: string;
    let parsed: unknown;
    try {
      raw = await upstream.text();
      parsed = JSON.parse(raw);
      validateChannel(parsed, channel);
    } catch {
      sendError(response, 502, "Content channel pointer is invalid");
      return;
    }

    response.statusCode = 200;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(raw);
  };
}

declare const process: { env: Record<string, string | undefined> };

export default createCurrentHandler();
