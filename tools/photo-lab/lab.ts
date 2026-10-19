/**
 * Photo lab, Node side: the manifest, the data folder, the API key, and classification runs that
 * send each prepared photo through the production photo check (worker/jpeg.ts metadata strip,
 * then createPhotoChecker from worker/founderPhoto.ts with its questions and context line).
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPhotoChecker, PHOTO_FLAGS, PHOTO_QUESTIONS, type PhotoAnswers } from "../../worker/founderPhoto.ts";
import { stripJpegMetadata } from "../../worker/jpeg.ts";
import { DEFAULT_MODERATION_MODEL, type ModerationEnv, type ModerationFetch } from "../../worker/moderation.ts";
import { CATEGORIES, type Manifest, type RunFile, type RunPhotoResult } from "./evaluate.ts";

export const LAB_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(LAB_ROOT, "..", "..");
export const MANIFEST_PATH = path.join(LAB_ROOT, "manifest.json");
export const RUN_ID = /^run-\d{8}-\d{6}-[0-9a-f]{4}$/;
const PHOTO_ID = /^[a-z]+(?:-[a-z]+)*-\d{2}$/;
const TRANSFORMS = new Set(["gaussian_blur", "motion_blur", "gamma_darken", "overexpose", "partial_blur", "pocket"]);
/** Production founding sends the park's name and kind; the lab uses one fixed park for every photo. */
export const LAB_CONTEXT = { parkName: "Beacon Hill Park", parkKind: "leisure=park" } as const;
const KEY_ENDPOINT = "https://openrouter.ai/api/v1/key";

/** PHOTO_LAB_DIR, else `.codex/photo-lab` in the nearest folder above the repo that has `.codex`. */
export function labDir(env: NodeJS.ProcessEnv = process.env, repoRoot = REPO_ROOT): string {
  const configured = env.PHOTO_LAB_DIR?.trim();
  if (configured) return path.resolve(configured);
  let current = path.dirname(repoRoot);
  for (;;) {
    if (existsSync(path.join(current, ".codex")) && statSync(path.join(current, ".codex")).isDirectory()) return path.join(current, ".codex", "photo-lab");
    const parent = path.dirname(current);
    if (parent === current) return path.join(repoRoot, ".codex", "photo-lab");
    current = parent;
  }
}

export function imagesDir(root = labDir()): string {
  return path.join(root, "images");
}

export function resultsDir(root = labDir()): string {
  return path.join(root, "results");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function commonsErrors(source: unknown, where: string): string[] {
  if (!isRecord(source)) return [`${where}: source is missing`];
  const errors: string[] = [];
  if (source.type !== "commons") errors.push(`${where}: expected a commons source`);
  if (!nonEmpty(source.title) || !source.title.startsWith("File:")) errors.push(`${where}: title must be a Commons File: title`);
  if (!nonEmpty(source.page) || !source.page.startsWith("https://commons.wikimedia.org/")) errors.push(`${where}: page must be a Commons URL`);
  if (!nonEmpty(source.author)) errors.push(`${where}: author is required`);
  if (!nonEmpty(source.licence)) errors.push(`${where}: licence is required`);
  if (typeof source.sha1 !== "string" || !/^[0-9a-f]{40}$/.test(source.sha1)) errors.push(`${where}: sha1 must be 40 hex characters`);
  return errors;
}

/** Every problem with the manifest, or an empty list. */
export function validateManifest(value: unknown): string[] {
  if (!isRecord(value)) return ["manifest must be an object"];
  const errors: string[] = [];
  if (value.version !== 1) errors.push("version must be 1");
  if (!nonEmpty(value.notes)) errors.push("notes are required");
  const flags = new Set<string>(PHOTO_FLAGS);
  const notCovered = Array.isArray(value.notCovered) ? value.notCovered : [];
  if (!Array.isArray(value.notCovered) || notCovered.some((flag) => !flags.has(flag as string))) errors.push("notCovered must list photo flags");
  if (!Array.isArray(value.photos) || value.photos.length === 0) return [...errors, "photos must be a non-empty list"];
  const ids = new Map<string, Record<string, unknown>>();
  for (const [index, photo] of value.photos.entries()) {
    const where = `photos[${index}]`;
    if (!isRecord(photo)) {
      errors.push(`${where}: must be an object`);
      continue;
    }
    if (typeof photo.id !== "string" || !PHOTO_ID.test(photo.id)) errors.push(`${where}: id must look like good-01`);
    else if (ids.has(photo.id)) errors.push(`${where}: duplicate id ${photo.id}`);
    else ids.set(photo.id, photo);
    if (!(CATEGORIES as readonly unknown[]).includes(photo.category)) errors.push(`${where}: unknown category`);
    if (!nonEmpty(photo.description)) errors.push(`${where}: description is required`);
    const expected = photo.expected;
    if (!isRecord(expected) || !["approve", "reject", "either"].includes(expected.outcome as string)) {
      errors.push(`${where}: expected.outcome must be approve, reject or either`);
    } else {
      const listed = [expected.flags, expected.optionalFlags];
      if (listed.some((list) => !Array.isArray(list) || list.some((flag) => !flags.has(flag)))) {
        errors.push(`${where}: expected flags must be photo flags`);
      } else {
        const required = expected.flags as string[];
        const optional = expected.optionalFlags as string[];
        if (required.some((flag) => optional.includes(flag))) errors.push(`${where}: a flag cannot be both expected and optional`);
        if (expected.outcome === "approve" && (required.length || optional.length)) errors.push(`${where}: an approved photo expects no flags`);
        if (expected.outcome === "reject" && required.length === 0) errors.push(`${where}: a rejected photo names the flag it expects`);
        if (expected.outcome === "either" && required.length) errors.push(`${where}: a borderline photo lists its flags as optional`);
        for (const flag of [...required, ...optional]) {
          if (notCovered.includes(flag)) errors.push(`${where}: ${flag} is listed as not covered`);
        }
      }
      if (photo.category === "good" && expected.outcome !== "approve") errors.push(`${where}: good photos expect approve`);
      if (photo.category === "borderline" && expected.outcome !== "either") errors.push(`${where}: borderline photos expect either`);
      if (!["good", "borderline"].includes(photo.category as string) && expected.outcome !== "reject") errors.push(`${where}: bad photos expect reject`);
    }
    const source = photo.source;
    if (isRecord(source) && source.type === "derived") {
      if (!isRecord(source.transform) || !TRANSFORMS.has(source.transform.op as string)) errors.push(`${where}: unknown transform`);
      if (typeof source.from === "string") {
        // Checked once every id is known.
      } else if ("fromCommons" in source) {
        errors.push(...commonsErrors(source.fromCommons, `${where}.fromCommons`));
      } else {
        errors.push(`${where}: a derived photo needs from or fromCommons`);
      }
    } else {
      errors.push(...commonsErrors(source, where));
    }
  }
  for (const [index, photo] of value.photos.entries()) {
    if (!isRecord(photo) || !isRecord(photo.source) || photo.source.type !== "derived" || typeof photo.source.from !== "string") continue;
    const parent = ids.get(photo.source.from);
    if (!parent || !isRecord(parent.source) || parent.source.type !== "commons")
      errors.push(`photos[${index}]: from must name a Commons photo in the manifest`);
  }
  return errors;
}

export function loadManifest(file = MANIFEST_PATH): Manifest {
  const manifest = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const errors = validateManifest(manifest);
  if (errors.length) throw new Error(`Invalid photo lab manifest:\n${errors.join("\n")}`);
  return manifest as Manifest;
}

/**
 * The key from the process environment, else from the Windows user environment, so the lab works
 * from a shell started before the key was set. The value is only passed to the API calls.
 */
export function readApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const direct = env.OPENROUTER_API_KEY?.trim();
  if (direct) return direct;
  if (process.platform !== "win32") return undefined;
  try {
    const output = execFileSync("reg", ["query", "HKCU\\Environment", "/v", "OPENROUTER_API_KEY"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return /OPENROUTER_API_KEY\s+REG_(?:EXPAND_)?SZ\s+(\S+)/.exec(output)?.[1];
  } catch {
    return undefined;
  }
}

export function moderationEnv(env: NodeJS.ProcessEnv = process.env): ModerationEnv {
  return { OPENROUTER_API_KEY: readApiKey(env), OPENROUTER_MODERATION_MODEL: env.OPENROUTER_MODERATION_MODEL };
}

export function questionsSha256(): string {
  return createHash("sha256").update(JSON.stringify(PHOTO_QUESTIONS)).digest("hex");
}

function newRunId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `run-${stamp}-${randomBytes(2).toString("hex")}`;
}

export function listRuns(root = labDir()): Omit<RunFile, "results">[] {
  const dir = resultsDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => RUN_ID.test(name.replace(/\.json$/, "")) && name.endsWith(".json"))
    .map((name) => {
      const { results: _results, ...rest } = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as RunFile;
      return rest;
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function readRun(id: string, root = labDir()): RunFile {
  if (!RUN_ID.test(id)) throw new Error("Unknown run.");
  return JSON.parse(readFileSync(path.join(resultsDir(root), `${id}.json`), "utf8")) as RunFile;
}

function writeRun(run: RunFile, root: string): void {
  const dir = resultsDir(root);
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${run.id}.json`);
  writeFileSync(`${target}.tmp`, `${JSON.stringify(run, null, 1)}\n`);
  renameSync(`${target}.tmp`, target);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface CallRecord {
  attempts: number;
  costUsd: number | null;
  status: number | null;
}

/**
 * Retries 429 and 5xx responses and network errors with backoff, and reads the reported cost from
 * the response. moderate() owns the overall timeout and aborts through the signal.
 */
export function retryingFetch(base: ModerationFetch, record: CallRecord, options: { retries?: number; baseDelayMs?: number } = {}): ModerationFetch {
  const retries = options.retries ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 1_500;
  return async (input, init) => {
    for (let attempt = 0; ; attempt += 1) {
      record.attempts += 1;
      let response: Response | null = null;
      try {
        response = await base(input, init);
      } catch (error) {
        if (init?.signal?.aborted || attempt >= retries) throw error;
      }
      if (response) {
        record.status = response.status;
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt >= retries) {
          if (response.ok) {
            try {
              const body = JSON.parse(await response.clone().text()) as { usage?: { cost?: unknown } };
              if (typeof body.usage?.cost === "number") record.costUsd = body.usage.cost;
            } catch {
              // moderate() reports the malformed body.
            }
          }
          return response;
        }
      }
      const retryAfter = Number(response?.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1_000 : baseDelayMs * 2 ** attempt);
    }
  };
}

async function keyUsage(env: ModerationEnv, fetchImpl: ModerationFetch): Promise<number | null> {
  if (!env.OPENROUTER_API_KEY) return null;
  try {
    const response = await fetchImpl(KEY_ENDPOINT, { headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` } });
    if (!response.ok) return null;
    const body = (await response.json()) as { data?: { usage?: unknown } };
    return typeof body.data?.usage === "number" ? body.data.usage : null;
  } catch {
    return null;
  }
}

export interface ClassifyOptions {
  ids?: string[];
  label?: string;
  /** Results for photos not in `ids` are carried over from this run. */
  basedOn?: string | null;
  concurrency?: number;
  root?: string;
  env?: ModerationEnv;
  fetchImpl?: ModerationFetch;
  timeoutMs?: number;
  retryDelayMs?: number;
  now?: () => Date;
  onProgress?: (progress: { done: number; total: number; failed: number; id: string }) => void;
}

/** Sends the photos through the production checker and saves a new versioned run. */
export async function classify(options: ClassifyOptions = {}): Promise<RunFile> {
  const root = options.root ?? labDir();
  const manifest = loadManifest();
  const env = options.env ?? moderationEnv();
  if (!env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set in the environment or the Windows user environment.");
  const fetchImpl = options.fetchImpl ?? fetch;
  const known = new Set(manifest.photos.map((photo) => photo.id));
  const ids = options.ids?.length ? [...new Set(options.ids)] : manifest.photos.map((photo) => photo.id);
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`Unknown photo ids: ${unknown.join(", ")}`);
  const base = options.basedOn ? readRun(options.basedOn, root) : null;
  const now = options.now ?? (() => new Date());
  const started = now();
  const id = newRunId(started);
  const results: Record<string, RunPhotoResult> = {};
  if (base) {
    for (const photo of manifest.photos) {
      if (!ids.includes(photo.id) && base.results[photo.id]) results[photo.id] = base.results[photo.id];
    }
  }
  const before = await keyUsage(env, fetchImpl);
  let next = 0;
  let done = 0;
  let failed = 0;
  let model = env.OPENROUTER_MODERATION_MODEL?.trim() || DEFAULT_MODERATION_MODEL;
  const worker = async () => {
    while (next < ids.length) {
      const photoId = ids[next++];
      const record: CallRecord = { attempts: 0, costUsd: null, status: null };
      const t0 = Date.now();
      let answers: PhotoAnswers | null = null;
      let error: string | null = null;
      try {
        const jpeg = stripJpegMetadata(new Uint8Array(readFileSync(path.join(imagesDir(root), `${photoId}.jpg`)))).bytes;
        const checker = createPhotoChecker(env, retryingFetch(fetchImpl, record, { baseDelayMs: options.retryDelayMs }), options.timeoutMs ?? 90_000);
        answers = await checker({ jpeg, ...LAB_CONTEXT });
        if (!answers) error = record.status && record.status !== 200 ? `HTTP ${record.status}` : "no answer";
      } catch (caught) {
        error = caught instanceof Error ? caught.message.slice(0, 200) : "failed";
      }
      if (answers?.model) model = answers.model;
      results[photoId] = {
        answers: answers?.answers ?? null,
        model: answers?.model ?? null,
        error,
        latencyMs: Date.now() - t0,
        attempts: record.attempts,
        costUsd: record.costUsd,
        queriedIn: id,
      };
      done += 1;
      if (error) failed += 1;
      options.onProgress?.({ done, total: ids.length, failed, id: photoId });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 4, ids.length)) }, worker));
  const after = await keyUsage(env, fetchImpl);
  const reportedCostUsd = ids.reduce((sum, photoId) => sum + (results[photoId]?.costUsd ?? 0), 0);
  const run: RunFile = {
    version: 1,
    id,
    label: options.label?.trim() || (base ? `Rerun of ${ids.length} photos` : `All ${ids.length} photos`),
    createdAt: started.toISOString(),
    finishedAt: now().toISOString(),
    model,
    context: { ...LAB_CONTEXT },
    questionsSha256: questionsSha256(),
    basedOn: base?.id ?? null,
    queried: ids,
    results: Object.fromEntries(manifest.photos.filter((photo) => results[photo.id]).map((photo) => [photo.id, results[photo.id]])),
    spend: { reportedCostUsd, keyUsageBeforeUsd: before, keyUsageAfterUsd: after },
  };
  writeRun(run, root);
  return run;
}
