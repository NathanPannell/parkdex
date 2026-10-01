import { HttpError } from "../../worker/validation.js";
import { imageType } from "./badges.js";
import { MAX_IMAGE_BYTES } from "./drafts.js";

/**
 * Reference photo search through Wikimedia Commons, which needs no key and allows embedding.
 * Results combine a text search for the park's name with photos geotagged near its pin.
 */

export interface WebPhoto {
  title: string;
  thumbUrl: string;
  pageUrl: string;
  width: number;
  height: number;
  /** "name" for a text match, "nearby" for a photo geotagged near the pin. */
  match: "name" | "nearby";
}

const API = "https://commons.wikimedia.org/w/api.php";
// Wikimedia asks API clients to identify themselves.
const HEADERS = { "user-agent": "ParkdexOperator/1.0 (https://parkdex.app)", "api-user-agent": "ParkdexOperator/1.0 (https://parkdex.app)" };

/** Public web hosts only: the dashboard fetches images the operator dragged in from a search. */
function publicHttpsUrl(value: unknown): URL | null {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  // No IP literals or single-label names, so a dropped link cannot point at a private address.
  if (/^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[") || !host.includes(".") || host.endsWith(".local") || host.endsWith(".internal") || host === "localhost") return null;
  return url;
}

type CommonsPage = { title: string; index?: number; imageinfo?: Array<{ thumburl?: string; thumbwidth?: number; thumbheight?: number; mime?: string; descriptionurl?: string }> };

async function query(params: Record<string, string>, fetcher: typeof fetch): Promise<CommonsPage[]> {
  const url = new URL(API);
  for (const [key, value] of Object.entries({
    action: "query", format: "json", prop: "imageinfo", iiprop: "url|mime", iiurlwidth: "640", origin: "*", ...params,
  })) url.searchParams.set(key, value);
  const response = await fetcher(url, { headers: HEADERS, signal: AbortSignal.timeout(5000) });
  if (!response.ok) return [];
  const body = await response.json() as { query?: { pages?: Record<string, CommonsPage> } };
  return Object.values(body.query?.pages ?? {}).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
}

function toPhoto(page: CommonsPage, match: WebPhoto["match"]): WebPhoto | null {
  const info = page.imageinfo?.[0];
  if (!info?.thumburl || !info.mime || !["image/jpeg", "image/png", "image/webp"].includes(info.mime)) return null;
  return {
    title: page.title.replace(/^File:/, "").replace(/\.[a-z]+$/i, ""),
    thumbUrl: info.thumburl,
    pageUrl: info.descriptionurl ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title)}`,
    width: info.thumbwidth ?? 0,
    height: info.thumbheight ?? 0,
    match,
  };
}

export async function searchPhotos(park: { name: string; region: string; lat: number; lng: number }, fetcher: typeof fetch = fetch): Promise<WebPhoto[]> {
  const text = [park.name, park.region].filter(Boolean).join(" ");
  const [named, nearby] = await Promise.all([
    query({ generator: "search", gsrsearch: `${text} filetype:bitmap`, gsrnamespace: "6", gsrlimit: "12" }, fetcher).catch(() => []),
    query({ generator: "geosearch", ggscoord: `${park.lat}|${park.lng}`, ggsradius: "1500", ggsnamespace: "6", ggslimit: "12" }, fetcher).catch(() => []),
  ]);
  const seen = new Set<string>();
  const photos: WebPhoto[] = [];
  for (const [pages, match] of [[named, "name"], [nearby, "nearby"]] as const) {
    for (const page of pages) {
      const photo = toPhoto(page, match);
      if (photo && !seen.has(photo.thumbUrl)) {
        seen.add(photo.thumbUrl);
        photos.push(photo);
      }
    }
  }
  return photos;
}

/** The first photo to attach automatically: a name match that mentions the park, else the nearest geotagged photo. */
export function bestPhoto(photos: WebPhoto[], name: string): WebPhoto | null {
  const words = name.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 3 && !["park", "regional", "provincial", "national", "community"].includes(word));
  const named = photos.find((photo) => photo.match === "name" && words.some((word) => photo.title.toLowerCase().includes(word)));
  return named ?? photos.find((photo) => photo.match === "nearby") ?? null;
}

/** Downloads an image from a public https address and checks it really is a JPEG, PNG or WebP. */
export async function downloadPhoto(value: unknown, fetcher: typeof fetch = fetch): Promise<{ bytes: Uint8Array; contentType: string }> {
  const url = publicHttpsUrl(value);
  if (!url) throw new HttpError(400, "invalid_request", "Use an https image address.");
  let response: Response;
  try {
    response = await fetcher(url, { headers: HEADERS, signal: AbortSignal.timeout(8000), redirect: "manual" });
  } catch {
    throw new HttpError(502, "photo_unavailable", "That photo could not be downloaded.");
  }
  // Follow at most one redirect, and only to another public https address.
  if (response.status >= 300 && response.status < 400) {
    const next = publicHttpsUrl(new URL(response.headers.get("location") ?? "", url).toString());
    if (!next) throw new HttpError(502, "photo_unavailable", "That photo could not be downloaded.");
    response = await fetcher(next, { headers: HEADERS, signal: AbortSignal.timeout(8000), redirect: "manual" });
  }
  if (!response.ok) throw new HttpError(502, "photo_unavailable", "That photo could not be downloaded.");
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) throw new HttpError(502, "photo_unavailable", "That photo is too large to attach.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES) throw new HttpError(502, "photo_unavailable", "That photo is too large to attach.");
  const contentType = imageType(bytes);
  if (!contentType) throw new HttpError(502, "photo_unavailable", "That photo is not a JPEG, PNG or WebP image.");
  return { bytes, contentType };
}
