import { APP_BUNDLE_CHANNELS, type AppBundleChannel } from "../../../worker/appUpdates.js";
import { UPDATE_ENDPOINTS, type ChannelView, type WorkerProbe } from "./ota.js";
import { failureText, noCacheHeaders, timedFetch, type Fetcher } from "./r2.js";

/**
 * The over-the-air setup checklist. Each item is done, todo, info or error, with the exact next
 * step. Nothing here changes anything; it only reads public endpoints and the dashboard's own env.
 */

export type SetupStatus = "done" | "todo" | "error" | "info";

export interface SetupItem {
  id: string;
  title: string;
  status: SetupStatus;
  detail: string;
  /** Plain-words next step, when there is one. */
  next?: string;
  /** Commands to run on the operator's machine, in order. */
  commands?: string[];
}

export interface SetupInput {
  probe: WorkerProbe;
  channels: ChannelView[];
  cloudflare: { configured: boolean; error: string | null; bucket: string };
  historyAvailable: boolean | null;
  /** Why the production database could not be asked, when it could not. */
  historyError?: string | null;
  posthog: boolean;
  fetch: Fetcher;
}

export const WORKER_DEPLOY_COMMANDS = [
  "node --test cloudflare/content-worker.test.mjs",
  "node scripts/build-content-worker.mjs",
  "cd cloudflare",
  "npx wrangler pages deploy ../.codex/cdn-dist --project-name parkdex-kip-content --branch staging --commit-hash <sha>",
];

export function firstPublishCommands(channel: AppBundleChannel): string[] {
  return [
    `node scripts/publish-app-bundle.mjs --channel ${channel} --min-native-build <build>`,
    `node scripts/publish-app-bundle.mjs --channel ${channel} --min-native-build <build> --apply --expected-generation 0 --record`,
  ];
}

async function endpointAnswers(fetcher: Fetcher, channel: AppBundleChannel): Promise<{ ok: boolean; detail: string }> {
  try {
    const response = await timedFetch(fetcher, UPDATE_ENDPOINTS[channel], {
      method: "POST",
      headers: noCacheHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ platform: "android", app_id: "app.parkdex", defaultChannel: channel, version_code: "1", version_name: "builtin" }),
    });
    const body = (await response.json().catch(() => null)) as { kind?: unknown; error?: unknown } | null;
    if (typeof body?.kind === "string")
      return {
        ok: true,
        detail: `${new URL(UPDATE_ENDPOINTS[channel]).host} answers ${body.kind}${typeof body.error === "string" ? ` (${body.error})` : ""}.`,
      };
    return { ok: false, detail: `${new URL(UPDATE_ENDPOINTS[channel]).host} answered HTTP ${response.status} without an update answer.` };
  } catch (error) {
    return { ok: false, detail: `${new URL(UPDATE_ENDPOINTS[channel]).host} could not be reached: ${failureText(error)}` };
  }
}

export async function setupChecklist(input: SetupInput): Promise<SetupItem[]> {
  const { probe, channels, cloudflare } = input;
  const items: SetupItem[] = [];

  items.push(
    probe.serves === true
      ? { id: "cdn-worker", title: "CDN worker serves app-bundles/", status: "done", detail: probe.detail }
      : probe.serves === false
        ? {
            id: "cdn-worker",
            title: "CDN worker serves app-bundles/",
            status: "todo",
            detail: probe.detail,
            next: "Redeploy the content worker from a clean checkout of staging, with CLOUDFLARE_ACCOUNT_ID set. It is a one-time step (docs/ota-updates.md).",
            commands: WORKER_DEPLOY_COMMANDS,
          }
        : {
            id: "cdn-worker",
            title: "CDN worker serves app-bundles/",
            status: "error",
            detail: probe.detail,
            next: "Reload in a minute. If it persists, check kip-assets.parkdex.app in the Cloudflare dashboard.",
          },
  );

  for (const channel of APP_BUNDLE_CHANNELS) {
    const view = channels.find((item) => item.channel === channel)!;
    const title = `${channel === "production" ? "Production" : "Staging"} channel has a bundle`;
    if (view.state === "live") items.push({ id: `pointer-${channel}`, title, status: "done", detail: view.detail });
    else if (view.state === "none") {
      items.push(
        probe.serves === false
          ? {
              id: `pointer-${channel}`,
              title,
              status: "todo",
              detail: "No pointer yet. Publishing now would not reach devices, because the CDN worker does not serve app-bundles/.",
              next: "Deploy the CDN worker first, then publish.",
            }
          : {
              id: `pointer-${channel}`,
              title,
              status: "todo",
              detail: "No pointer yet, so installed builds keep their built-in code.",
              next: `Publish a first bundle from a clean checkout at the commit to ship${channel === "production" ? " (usually main)" : ""}. Use the oldest native build whose plugins it needs.`,
              commands: firstPublishCommands(channel),
            },
      );
    } else if (view.state === "not_served")
      items.push({ id: `pointer-${channel}`, title, status: "todo", detail: view.detail, next: "Deploy the CDN worker; the pointer is already in R2." });
    else if (view.state === "invalid")
      items.push({ id: `pointer-${channel}`, title, status: "error", detail: view.detail, next: "Publish again with the script; it writes a valid pointer." });
    else items.push({ id: `pointer-${channel}`, title, status: "error", detail: view.detail });
  }

  const endpoints = await Promise.all(APP_BUNDLE_CHANNELS.map((channel) => endpointAnswers(input.fetch, channel)));
  items.push({
    id: "endpoint",
    title: "Update endpoint answers on both hosts",
    status: endpoints.every((item) => item.ok) ? "done" : "error",
    detail: endpoints.map((item) => item.detail).join(" "),
    ...(endpoints.every((item) => item.ok) ? {} : { next: "POST /api/updates ships with the app API; check the staging and production deployments." }),
  });

  items.push(
    !cloudflare.configured
      ? {
          id: "cloudflare",
          title: "Dashboard can read and move pointers in R2",
          status: "todo",
          detail: "CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID is missing on this deployment, so the bundle list and Publish and roll back are off.",
          next: `Add both to the parkdex-operator project's Preview environment on Vercel. The token needs R2 read and write on ${cloudflare.bucket}.`,
        }
      : cloudflare.error
        ? {
            id: "cloudflare",
            title: "Dashboard can read and move pointers in R2",
            status: "error",
            detail: cloudflare.error,
            next: `Give the token R2 read and write on ${cloudflare.bucket}, or set ASSETS_BUCKET if the bucket has another name.`,
          }
        : { id: "cloudflare", title: "Dashboard can read and move pointers in R2", status: "done", detail: `The Cloudflare token lists ${cloudflare.bucket}.` },
  );

  items.push(
    input.historyAvailable === true
      ? { id: "history", title: "Publish history table exists", status: "done", detail: "kip_app_config.ota_publishes is in production." }
      : {
          id: "history",
          title: "Publish history table exists",
          status: input.historyAvailable === false ? "todo" : "error",
          detail:
            input.historyAvailable === false
              ? "kip_app_config.ota_publishes is missing, so moves are not recorded and older bundles cannot be repointed."
              : `The production database could not be checked. ${input.historyError ?? ""}`.trim(),
          next: "Apply database/migrations/app_config_003_ota_publishes.sql to production (it ships in deployment.json).",
        },
  );

  items.push({
    id: "script-keys",
    title: "R2 S3 keys for the publish script",
    status: "info",
    detail: "Only scripts/publish-app-bundle.mjs needs them, on your machine, to upload new zips. The dashboard does not, and cannot check your machine.",
    next: "Have the loader pass R2_ACCOUNT_ID, R2_BUCKET=parkdex-kip-content, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY (plus R2_SESSION_TOKEN for temporary keys). For --record, also OTA_HISTORY_DATABASE_URL pointing at production.",
  });

  items.push(
    input.posthog
      ? {
          id: "posthog",
          title: "PostHog personal API key",
          status: "done",
          detail: "POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID are set, so Analytics can read app taps and screen views.",
        }
      : {
          id: "posthog",
          title: "PostHog personal API key",
          status: "todo",
          detail: "Analytics shows app events only with a PostHog personal API key.",
          next: "In PostHog, create a personal API key with Query Read for the Parkdex project, then add POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID to the dashboard's Preview environment on Vercel.",
        },
  );

  return items;
}
