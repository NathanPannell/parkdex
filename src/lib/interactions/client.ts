import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { Network } from "@capacitor/network";
import { InteractionOutbox } from "./outbox";
import type {
  InteractionBase,
  InteractionEntryPoint,
  InteractionEnvironment,
  InteractionEvent,
  InteractionProvider,
  InteractionTravelMode,
} from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PARK_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;
const RELEASE_ID = /^[0-9a-f]{64}$/i;
const MAX_FLUSH_BATCHES = 5;
const MIN_ATTEMPT_INTERVAL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 8_000;
const ENTRY_POINTS: readonly InteractionEntryPoint[] = ["map", "nearby", "collection"];
const PROVIDERS: readonly InteractionProvider[] = ["google_maps", "apple_maps"];
const TRAVEL_MODES: readonly InteractionTravelMode[] = ["driving", "walking", "bicycling", "transit"];

export type ParkViewedInput = {
  parkId: string;
  entryPoint: InteractionEntryPoint;
  contentReleaseId: string;
};

export type DirectionsOpenedInput = ParkViewedInput & {
  provider: InteractionProvider;
  travelMode: InteractionTravelMode;
};

export type ParkClaimedInput = {
  parkId: string;
  claimId: string;
  claimStatus: "first" | "repeat";
  contentReleaseId: string;
};

export interface InteractionClientOptions {
  outbox?: InteractionOutbox;
  fetcher?: typeof fetch;
  now?(): number;
  apiBaseUrl?: string;
  appVersion?: string;
  appBuild?: string;
  environment?: InteractionEnvironment;
  lifecycleHooks?: boolean;
  automaticDelivery?: boolean;
}

type DeliveryResult = "accepted" | "conflict" | "retry";

function createUuid(): string {
  if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") {
    throw new Error("Secure random IDs are unavailable.");
  }
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID().toLowerCase();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function environmentValue(): InteractionEnvironment {
  const value = import.meta.env.VITE_CONTENT_ENV;
  return value === "main" || value === "preview" ? value : "staging";
}

function defaultApiBaseUrl(): string {
  const configured = (import.meta.env.VITE_ACCOUNT_API_URL ?? "").trim() || (import.meta.env.VITE_FEEDBACK_API_URL ?? "").trim();
  return configured.replace(/\/+$/, "");
}

function isBaseInputValid(parkId: string, contentReleaseId: string): boolean {
  return PARK_ID.test(parkId) && RELEASE_ID.test(contentReleaseId);
}

function responseBody(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class InteractionClient {
  private readonly outbox: InteractionOutbox;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly apiBaseUrl: string;
  private readonly appVersion: string;
  private readonly appBuild: string;
  private readonly environment: InteractionEnvironment;
  private readonly lifecycleHooks: boolean;
  private readonly automaticDelivery: boolean;
  private sessionId: string | null = null;
  private hooksInstalled = false;
  private flushing: Promise<void> | null = null;
  private connected: boolean | null = null;
  private lastAttemptAt = Number.NEGATIVE_INFINITY;

  constructor(options: InteractionClientOptions = {}) {
    this.outbox = options.outbox ?? new InteractionOutbox();
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    this.apiBaseUrl = options.apiBaseUrl ?? defaultApiBaseUrl();
    this.appVersion = options.appVersion ?? (typeof __APP_VERSION__ === "undefined" ? "unknown" : __APP_VERSION__);
    this.appBuild = options.appBuild ?? (typeof __APP_BUILD__ === "undefined" ? "unknown" : __APP_BUILD__);
    this.environment = options.environment ?? environmentValue();
    this.lifecycleHooks = options.lifecycleHooks ?? true;
    this.automaticDelivery = options.automaticDelivery ?? true;
    this.ensureLifecycleHooks();
  }

  recordParkViewed(input: ParkViewedInput): Promise<void> {
    if (!isBaseInputValid(input.parkId, input.contentReleaseId) || !ENTRY_POINTS.includes(input.entryPoint)) return Promise.resolve();
    return this.enqueue(input.parkId, input.contentReleaseId, (base) => ({ ...base, type: "park_viewed", entryPoint: input.entryPoint }));
  }

  recordDirectionsOpened(input: DirectionsOpenedInput): Promise<void> {
    if (!isBaseInputValid(input.parkId, input.contentReleaseId) || !ENTRY_POINTS.includes(input.entryPoint) ||
      !PROVIDERS.includes(input.provider) || !TRAVEL_MODES.includes(input.travelMode)) return Promise.resolve();
    return this.enqueue(input.parkId, input.contentReleaseId, (base) => ({
      ...base, type: "directions_opened", entryPoint: input.entryPoint, provider: input.provider, travelMode: input.travelMode,
    }));
  }

  recordParkClaimed(input: ParkClaimedInput): Promise<void> {
    if (!isBaseInputValid(input.parkId, input.contentReleaseId) || !UUID.test(input.claimId) ||
      (input.claimStatus !== "first" && input.claimStatus !== "repeat")) return Promise.resolve();
    return this.enqueue(input.parkId, input.contentReleaseId, (base) => ({
      ...base, type: "park_claimed", claimId: input.claimId.toLowerCase(), claimStatus: input.claimStatus,
    }));
  }

  async flush(force = false): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.connected === false) return;
    if (!force && this.now() - this.lastAttemptAt < MIN_ATTEMPT_INTERVAL_MS) return;

    const work = this.flushBatches();
    this.flushing = work;
    try {
      await work;
    } finally {
      if (this.flushing === work) this.flushing = null;
    }
  }

  private async enqueue(
    parkId: string,
    contentReleaseId: string,
    createEvent: (base: InteractionBase) => InteractionEvent,
  ): Promise<void> {
    try {
      const installationId = await this.outbox.getInstallationId();
      this.sessionId ??= createUuid();
      const now = this.now();
      const base: InteractionBase = {
        eventId: createUuid(),
        installationId,
        sessionId: this.sessionId,
        occurredAt: new Date(now).toISOString(),
        schemaVersion: 1,
        appVersion: this.appVersion,
        appBuild: this.appBuild,
        contentReleaseId: contentReleaseId.toLowerCase(),
        environment: this.environment,
        parkId,
      };
      const event = createEvent(base);
      await this.outbox.enqueue(event, now);
      this.ensureLifecycleHooks();
      if (this.automaticDelivery) void this.flush().catch(() => {});
    } catch {
      // Interaction storage and delivery must never interrupt the app action.
    }
  }

  private async flushBatches(): Promise<void> {
    for (let batchNumber = 0; batchNumber < MAX_FLUSH_BATCHES; batchNumber += 1) {
      const batch = await this.outbox.nextBatch(this.now());
      if (batch.length === 0) return;
      this.lastAttemptAt = this.now();
      const result = await this.sendBatch(batch.map((item) => item.event));
      if (result === "retry") return;
      if (result === "accepted") await this.outbox.remove(batch.map((item) => item.event.eventId));
    }
  }

  private async sendBatch(events: InteractionEvent[]): Promise<DeliveryResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetcher(`${this.apiBaseUrl}/api/interactions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "omit",
        body: JSON.stringify({ events }),
        signal: controller.signal,
      });
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return "retry";
      }
      if (response.status === 409 && responseBody(body) && Array.isArray(body.conflictingEventIds)) {
        const batchIds = new Set(events.map((event) => event.eventId));
        const conflicts = body.conflictingEventIds.filter((value): value is string => typeof value === "string" && UUID.test(value) && batchIds.has(value.toLowerCase()));
        if (conflicts.length > 0) {
          await this.outbox.remove(conflicts.map((id) => id.toLowerCase()));
          return "conflict";
        }
        return "retry";
      }
      if (!response.ok || !responseBody(body)) return "retry";
      const accepted = body.accepted;
      const inserted = body.inserted;
      const duplicates = body.duplicates;
      if (accepted !== events.length || !Number.isInteger(inserted) || !Number.isInteger(duplicates) ||
        (inserted as number) + (duplicates as number) !== events.length) return "retry";
      return "accepted";
    } catch {
      return "retry";
    } finally {
      clearTimeout(timeout);
    }
  }

  private ensureLifecycleHooks(): void {
    if (!this.lifecycleHooks || this.hooksInstalled || typeof window === "undefined" || typeof document === "undefined") return;
    this.hooksInstalled = true;
    window.addEventListener("online", () => {
      this.connected = true;
      void this.flush(true).catch(() => {});
    });
    window.addEventListener("offline", () => { this.connected = false; });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void this.flush(true).catch(() => {});
    });
    if (!Capacitor.isNativePlatform()) {
      if (document.visibilityState === "visible") void this.flush(true).catch(() => {});
      return;
    }
    void Network.getStatus().then((status) => {
      this.connected = status.connected;
      if (status.connected) void this.flush(true).catch(() => {});
    }).catch(() => {});
    void Network.addListener("networkStatusChange", (status) => {
      this.connected = status.connected;
      if (status.connected) void this.flush(true).catch(() => {});
    }).catch(() => {});
    void App.addListener("appStateChange", ({ isActive }) => {
      if (isActive) void this.flush(true).catch(() => {});
    }).catch(() => {});
  }
}

const interactionClient = new InteractionClient();

export function recordParkViewed(input: ParkViewedInput): Promise<void> {
  return interactionClient.recordParkViewed(input);
}

export function recordDirectionsOpened(input: DirectionsOpenedInput): Promise<void> {
  return interactionClient.recordDirectionsOpened(input);
}

export function recordParkClaimed(input: ParkClaimedInput): Promise<void> {
  return interactionClient.recordParkClaimed(input);
}

export function flushInteractions(): Promise<void> {
  return interactionClient.flush(true);
}
