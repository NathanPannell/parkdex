function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function keyedHash(secret: string, scope: string, value: string): Promise<string> {
  if (new TextEncoder().encode(secret).length < 32) throw new Error("session secret is unavailable");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${scope}\u0000${value}`));
  return bytesToHex(new Uint8Array(signature));
}

export function getClientAddress(request: Request): string {
  const address = request.headers.get("cf-connecting-ip")?.trim();
  if (!address || address.length > 64 || /[\s,]/.test(address)) return "unknown";
  return address.toLowerCase();
}

function normalizedOrigin(value: string | null): string | null {
  if (!value || value === "null") return null;
  if (value === "capacitor://localhost") return value;
  try {
    const origin = new URL(value);
    if (origin.origin === "null" || origin.origin !== value.replace(/\/$/, "")) return null;
    return origin.origin;
  } catch {
    return null;
  }
}

export interface OriginEnvironment {
  PUBLIC_APP_URL?: string;
  ALLOWED_ORIGINS?: string;
}

export function allowedOrigins(request: Request, env: OriginEnvironment): Set<string> {
  const origins = new Set<string>([new URL(request.url).origin, "http://localhost", "https://localhost", "capacitor://localhost"]);
  for (const value of (env.ALLOWED_ORIGINS ?? "").split(/[\s,]+/)) {
    const origin = normalizedOrigin(value);
    if (origin) origins.add(origin);
  }
  if (env.PUBLIC_APP_URL) {
    try {
      const url = new URL(env.PUBLIC_APP_URL);
      if ((url.protocol === "https:" || url.protocol === "http:") && url.origin !== "null") origins.add(url.origin);
    } catch {
      // Invalid public URLs do not expand the cross-origin allowlist.
    }
  }
  return origins;
}

export function requestOriginAllowed(request: Request, env: OriginEnvironment): boolean {
  const originHeader = request.headers.get("origin");
  if (!originHeader) return true;
  const origin = normalizedOrigin(originHeader);
  return origin !== null && allowedOrigins(request, env).has(origin);
}
