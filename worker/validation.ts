export const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 3 * 1024 * 1024;

export type FeedbackKind = "bug" | "idea" | "general";
export type FeedbackStatus = "new" | "reviewing" | "planned" | "closed";
export type EmailAudience = "operator" | "receipt";
export type EmailStatus = "pending" | "sending" | "sent" | "failed" | "ambiguous" | "disabled";

export interface FeedbackContext {
  version: string;
  build?: string;
  platform: string;
  screen: string;
  parkId: string | null;
  parkName: string | null;
}

export interface FeedbackEmailReport {
  id: string;
  kind: FeedbackKind;
  message: string;
  email: string | null;
  contact: boolean;
  context: FeedbackContext;
  createdAt: string;
  hasScreenshot: boolean;
}

export interface ValidatedFeedback {
  submissionId: string;
  kind: FeedbackKind;
  message: string;
  email: string | null;
  contact: boolean;
  screenshot: null | {
    contentType: "image/png" | "image/jpeg" | "image/webp";
    bytes: Uint8Array;
    base64: string;
  };
  context: FeedbackContext;
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATA_URL = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]*={0,2})$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const CONTEXT_KEYS = new Set(["version", "build", "platform", "screen", "parkId", "parkName"]);
const REPORT_KEYS = new Set(["submissionId", "kind", "message", "email", "contact", "screenshot", "context"]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowlist: Set<string>): boolean {
  return Object.keys(value).every((key) => allowlist.has(key));
}

function boundedString(value: unknown, field: string, max: number, allowBlank = false): string {
  if (typeof value !== "string") throw new HttpError(400, "invalid_request", `Invalid ${field}.`);
  const normalized = value.trim();
  if ((!allowBlank && normalized.length === 0) || normalized.length > max) {
    throw new HttpError(400, "invalid_request", `Invalid ${field}.`);
  }
  return normalized;
}

function nullableContextString(value: unknown, field: string, max: number): string | null {
  if (value === null) return null;
  return boundedString(value, field, max);
}

function validateContext(value: unknown): FeedbackContext {
  if (!record(value) || !hasOnlyKeys(value, CONTEXT_KEYS)) {
    throw new HttpError(400, "invalid_request", "Invalid feedback context.");
  }
  if (!("version" in value) || !("platform" in value) || !("screen" in value)) {
    throw new HttpError(400, "invalid_request", "Invalid feedback context.");
  }
  const context: FeedbackContext = {
    version: boundedString(value.version, "context version", 80),
    platform: boundedString(value.platform, "context platform", 40),
    screen: boundedString(value.screen, "context screen", 80),
    parkId: nullableContextString(value.parkId ?? null, "context park id", 160),
    parkName: nullableContextString(value.parkName ?? null, "context park name", 180),
  };
  if ("build" in value) context.build = boundedString(value.build, "context build", 80);
  return context;
}

function decodeScreenshot(value: unknown): ValidatedFeedback["screenshot"] {
  if (value === null) return null;
  if (typeof value !== "string") throw new HttpError(400, "invalid_screenshot", "Invalid screenshot.");
  const match = DATA_URL.exec(value);
  if (!match) throw new HttpError(400, "invalid_screenshot", "Screenshot must be a PNG, JPEG, or WebP data URL.");
  const subtype = match[1];
  const base64 = match[2];
  if (!base64 || base64.length > Math.ceil((MAX_SCREENSHOT_BYTES + 2) / 3) * 4 || !BASE64.test(base64)) {
    throw new HttpError(400, "invalid_screenshot", "Screenshot must be no larger than 2 MiB.");
  }
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new HttpError(400, "invalid_screenshot", "Invalid screenshot data.");
  }
  if (binary.length === 0 || binary.length > MAX_SCREENSHOT_BYTES || btoa(binary) !== base64) {
    throw new HttpError(400, "invalid_screenshot", "Screenshot must be no larger than 2 MiB.");
  }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const contentType = subtype === "png" ? "image/png" : subtype === "jpeg" ? "image/jpeg" : "image/webp";
  const validMagic = contentType === "image/png"
    ? bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte)
    : contentType === "image/jpeg"
      ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : bytes.length >= 12 &&
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  if (!validMagic) throw new HttpError(400, "invalid_screenshot", "Screenshot content does not match its image type.");
  return { contentType, bytes, base64 };
}

export function validateFeedbackBody(value: unknown): ValidatedFeedback {
  if (!record(value) || !hasOnlyKeys(value, REPORT_KEYS)) {
    throw new HttpError(400, "invalid_request", "Invalid feedback request.");
  }
  if (typeof value.submissionId !== "string" || !UUID.test(value.submissionId)) {
    throw new HttpError(400, "invalid_request", "A valid submissionId is required.");
  }
  if (value.kind !== "bug" && value.kind !== "idea" && value.kind !== "general") {
    throw new HttpError(400, "invalid_request", "Invalid feedback kind.");
  }
  const message = boundedString(value.message, "message", 4000);
  if (typeof value.contact !== "boolean") throw new HttpError(400, "invalid_request", "Invalid contact preference.");
  let email: string | null = null;
  if (value.email !== undefined && value.email !== null) {
    const suppliedEmail = boundedString(value.email, "email", 254, true);
    if (suppliedEmail) {
      if (!EMAIL.test(suppliedEmail)) throw new HttpError(400, "invalid_email", "Enter a valid email address.");
      email = suppliedEmail.toLowerCase();
    }
  }
  if (value.contact && !email) throw new HttpError(400, "invalid_email", "A valid email is required when contact is allowed.");
  return {
    submissionId: value.submissionId.toLowerCase(),
    kind: value.kind,
    message,
    email,
    contact: value.contact,
    screenshot: decodeScreenshot(value.screenshot ?? null),
    context: validateContext(value.context),
  };
}

export async function readJsonBody(request: Request, maxBytes = MAX_REQUEST_BYTES): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new HttpError(415, "unsupported_media_type", "Expected a JSON request.");
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader && /^\d+$/.test(lengthHeader) && Number(lengthHeader) > maxBytes) {
    throw new HttpError(413, "request_too_large", "Request is too large.");
  }
  if (!request.body) throw new HttpError(400, "invalid_json", "Invalid JSON request.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new HttpError(413, "request_too_large", "Request is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new HttpError(400, "invalid_json", "Invalid JSON request.");
  }
}

export function validateStatus(value: unknown): FeedbackStatus {
  if (value === "new" || value === "reviewing" || value === "planned" || value === "closed") return value;
  throw new HttpError(400, "invalid_status", "Invalid feedback status.");
}

export function validateRetryBody(value: unknown): { audiences: EmailAudience[] | null; confirmAmbiguousAfter24h: boolean } {
  if (!record(value) || !hasOnlyKeys(value, new Set(["audiences", "confirmAmbiguousAfter24h"]))) {
    throw new HttpError(400, "invalid_request", "Invalid retry request.");
  }
  let audiences: EmailAudience[] | null = null;
  if (value.audiences !== undefined) {
    if (!Array.isArray(value.audiences) || value.audiences.some((item) => item !== "operator" && item !== "receipt")) {
      throw new HttpError(400, "invalid_request", "Invalid email audiences.");
    }
    audiences = [...new Set(value.audiences as EmailAudience[])];
  }
  if (value.confirmAmbiguousAfter24h !== undefined && typeof value.confirmAmbiguousAfter24h !== "boolean") {
    throw new HttpError(400, "invalid_request", "Invalid retry confirmation.");
  }
  return { audiences, confirmAmbiguousAfter24h: value.confirmAmbiguousAfter24h === true };
}
