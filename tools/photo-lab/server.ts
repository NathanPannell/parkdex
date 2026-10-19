/**
 * The photo lab dashboard: http://127.0.0.1:5199 (npm run photo-lab).
 *
 * Serves the dashboard, the manifest, saved runs and the prepared images, and starts new
 * classification runs. Decisions are made in the browser by the production decidePhoto, which
 * this server transpiles from worker/founderPhoto.ts, so moving a threshold costs no API call.
 */
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import ts from "typescript";
import { classify, imagesDir, labDir, LAB_ROOT, listRuns, loadManifest, readApiKey, readRun, REPO_ROOT, RUN_ID } from "./lab.ts";

export const HOST = "127.0.0.1";
export const PORT = Number(process.env.PHOTO_LAB_PORT) || 5199;

/** Only these TypeScript modules are served to the browser. */
const MODULES = new Map([
  ["worker/founderPhoto", "worker/founderPhoto.ts"],
  ["worker/moderation", "worker/moderation.ts"],
  ["tools/photo-lab/evaluate", "tools/photo-lab/evaluate.ts"],
]);
const STATIC = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

interface Job {
  running: boolean;
  done: number;
  total: number;
  failed: number;
  runId: string | null;
  error: string | null;
  startedAt: string;
}

let job: Job | null = null;
const transpiled = new Map<string, string>();

function send(response: ServerResponse, status: number, body: string | Buffer, type = "application/json; charset=utf-8"): void {
  response.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(body);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  send(response, status, JSON.stringify(value));
}

function moduleSource(relative: string): string {
  const cached = transpiled.get(relative);
  if (cached) return cached;
  const source = readFileSync(path.join(REPO_ROOT, relative), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false },
    fileName: relative,
  }).outputText;
  transpiled.set(relative, output);
  return output;
}

/** Same-origin POSTs only, so another page in the browser cannot start paid runs. */
function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  return origin === `http://${HOST}:${PORT}` || origin === `http://localhost:${PORT}`;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new Error("too large");
    chunks.push(chunk as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function startJob(ids: string[] | undefined, basedOn: string | null, label: string | undefined): Job {
  const started: Job = {
    running: true,
    done: 0,
    total: ids?.length ?? loadManifest().photos.length,
    failed: 0,
    runId: null,
    error: null,
    startedAt: new Date().toISOString(),
  };
  job = started;
  classify({
    ids,
    basedOn,
    label,
    onProgress: ({ done, total, failed }) => Object.assign(started, { done, total, failed }),
  }).then(
    (run) => {
      Object.assign(started, { running: false, runId: run.id });
    },
    (error: unknown) => {
      Object.assign(started, { running: false, error: error instanceof Error ? error.message : "The run failed." });
    },
  );
  return started;
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
  const route = url.pathname;
  if (request.method === "GET") {
    const file = STATIC.get(route);
    if (file) return send(response, 200, readFileSync(path.join(LAB_ROOT, "public", file[0])), file[1]);
    const moduleMatch = /^\/modules\/(.+)\.(?:ts|js)$/.exec(route);
    if (moduleMatch && MODULES.has(moduleMatch[1])) return send(response, 200, moduleSource(MODULES.get(moduleMatch[1])!), "text/javascript; charset=utf-8");
    if (route === "/api/manifest") return json(response, 200, loadManifest());
    if (route === "/api/status") return json(response, 200, { job, hasKey: Boolean(readApiKey()), dataDir: labDir() });
    if (route === "/api/runs") return json(response, 200, listRuns());
    const runMatch = /^\/api\/runs\/([^/]+)$/.exec(route);
    if (runMatch) {
      if (!RUN_ID.test(runMatch[1]) || !existsSync(path.join(labDir(), "results", `${runMatch[1]}.json`)))
        return json(response, 404, { error: "Unknown run." });
      return json(response, 200, readRun(runMatch[1]));
    }
    const imageMatch = /^\/images\/([a-z0-9-]+)\.jpg$/.exec(route);
    if (imageMatch && loadManifest().photos.some((photo) => photo.id === imageMatch[1])) {
      const file = path.join(imagesDir(), `${imageMatch[1]}.jpg`);
      if (!existsSync(file)) return json(response, 404, { error: "Run npm run photo-lab:fetch first." });
      response.writeHead(200, { "content-type": "image/jpeg", "cache-control": "max-age=300" });
      createReadStream(file).pipe(response);
      return;
    }
    return json(response, 404, { error: "Not found." });
  }
  if (request.method === "POST" && route === "/api/rerun") {
    if (!sameOrigin(request)) return json(response, 403, { error: "Cross-origin requests are refused." });
    if (job?.running) return json(response, 409, { error: "A run is already in progress.", job });
    const body = (await readBody(request)) as { ids?: unknown; basedOn?: unknown; label?: unknown };
    const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string") : undefined;
    const basedOn = typeof body.basedOn === "string" && RUN_ID.test(body.basedOn) ? body.basedOn : null;
    if (ids?.length && !basedOn) return json(response, 400, { error: "Rerunning some photos needs a run to carry the others over from." });
    if (!readApiKey()) return json(response, 503, { error: "OPENROUTER_API_KEY is not set." });
    const label = typeof body.label === "string" ? body.label.slice(0, 120) : undefined;
    return json(response, 202, { job: startJob(ids?.length ? ids : undefined, ids?.length ? basedOn : null, label) });
  }
  return json(response, 405, { error: "Method not allowed." });
}

const server = createServer((request, response) => {
  handle(request, response).catch((error: unknown) => {
    if (!response.headersSent) json(response, 500, { error: error instanceof Error ? error.message : "Server error." });
  });
});
server.listen(PORT, HOST, () => {
  console.log(`Photo lab on http://${HOST}:${PORT} (data in ${labDir()})`);
});
