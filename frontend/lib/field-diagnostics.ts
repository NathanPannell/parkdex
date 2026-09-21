export type FieldDiagnosticFlow = "location" | "photo";
export type FieldDiagnosticTone = "working" | "success" | "warning" | "error";
export type FieldDiagnosticStage =
  | "permission"
  | "cached-fix"
  | "watch-start"
  | "first-fix"
  | "boundary-check"
  | "camera"
  | "local-save"
  | "location-recheck"
  | "claim"
  | "upload"
  | "cleanup";

type PermissionValue = "precise" | "approximate" | "denied" | "prompt";
type AppStateValue = "active" | "inactive";
type VisibilityValue = "visible" | "hidden";
type SourceValue = "cached" | "live";
type NetworkValue = "online" | "offline";
type ResultValue = "started" | "ready" | "accepted" | "cancelled" | "saved" | "rejected" | "timed-out" | "failed" | "complete";
type PlatformValue = "android" | "web";

/**
 * Deliberately closed diagnostic vocabulary. Callers cannot attach arbitrary
 * objects, coordinates, credentials, URLs, or raw server responses.
 */
export type FieldDiagnosticFact =
  | { kind: "attempt"; value: number }
  | { kind: "permission"; value: PermissionValue }
  | { kind: "app-state"; value: AppStateValue }
  | { kind: "visibility"; value: VisibilityValue }
  | { kind: "source"; value: SourceValue }
  | { kind: "sample-age-ms"; value: number }
  | { kind: "accuracy-meters"; value: number }
  | { kind: "elapsed-ms"; value: number }
  | { kind: "provider-wait-ms"; value: number }
  | { kind: "distance-meters"; value: number }
  | { kind: "network"; value: NetworkValue }
  | { kind: "file-bytes"; value: number }
  | { kind: "mime-type"; value: "image/jpeg" | "image/png" | "image/webp" }
  | { kind: "width-px"; value: number }
  | { kind: "height-px"; value: number }
  | { kind: "http-status"; value: number }
  | { kind: "retry-attempt"; value: number }
  | { kind: "result"; value: ResultValue }
  | { kind: "platform"; value: PlatformValue };

export type FieldDiagnosticTimelineItem = {
  id: number;
  stage: FieldDiagnosticStage;
  tone: FieldDiagnosticTone;
  relativeMs: number;
  summary: string;
  facts: readonly FieldDiagnosticFact[];
};

export type FieldDiagnosticEntry = {
  id: string;
  traceId: string;
  key: string;
  flow: FieldDiagnosticFlow;
  title: string;
  tone: FieldDiagnosticTone;
  summary: string;
  startedAt: number;
  updatedAt: number;
  visible: boolean;
  announcement: string;
  timeline: readonly FieldDiagnosticTimelineItem[];
};

export type FieldDiagnosticsSnapshot = {
  retained: readonly FieldDiagnosticEntry[];
  visible: readonly FieldDiagnosticEntry[];
  announcement: string;
};

type BeginInput = {
  key: string;
  flow: FieldDiagnosticFlow;
  title: string;
  stage: FieldDiagnosticStage;
  summary?: string;
  facts?: readonly FieldDiagnosticFact[];
};

type UpdateInput = {
  summary: string;
  facts?: readonly FieldDiagnosticFact[];
  announce?: boolean;
};

export type FieldDiagnosticTrace = {
  readonly id: string;
  stage: (stage: FieldDiagnosticStage, input: UpdateInput) => void;
  succeed: (stage: FieldDiagnosticStage, input: UpdateInput) => void;
  warn: (stage: FieldDiagnosticStage, input: UpdateInput) => void;
  fail: (stage: FieldDiagnosticStage, input: UpdateInput) => void;
  dismiss: () => void;
};

export type FieldDiagnosticsStore = {
  begin: (input: BeginInput) => FieldDiagnosticTrace;
  dismiss: (id: string) => void;
  pause: (id: string, reason: string) => void;
  resume: (id: string, reason: string) => void;
  pauseAll: (reason: string) => void;
  resumeAll: (reason: string) => void;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => FieldDiagnosticsSnapshot;
  copyText: (id: string) => string;
  reset: () => void;
};

const MAX_RETAINED = 20;
const MAX_VISIBLE = 2;
const WORKING_TTL_MS = 6_000;
const SUCCESS_TTL_MS = 6_000;
const PROBLEM_TTL_MS = 12_000;
const EMPTY_SNAPSHOT: FieldDiagnosticsSnapshot = { retained: [], visible: [], announcement: "" };

type InternalEntry = FieldDiagnosticEntry & {
  expiresAt: number;
  remainingMs: number;
  pauseReasons: Set<string>;
};

function safeText(value: string, fallback: string) {
  const compact = value.replace(/\s+/g, " ").trim().slice(0, 180);
  if (!compact) return fallback;
  return compact
    .replace(/\bBearer\s+\S+/gi, "[redacted]")
    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[redacted-email]")
    .replace(/-?\d{1,2}\.\d{4,}\s*[,/]\s*-?\d{1,3}\.\d{4,}/g, "[redacted-coordinates]")
    .replace(/\b(?:token|signature|authorization|credential|secret)\s*[:=]\s*\S+/gi, "$1=[redacted]");
}

function safeKey(value: string) {
  return value.replace(/[^a-z0-9:._-]/gi, "").slice(0, 80) || "diagnostic";
}

function finite(value: number, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : 0;
}

function safeFact(fact: unknown): FieldDiagnosticFact | null {
  if (!fact || typeof fact !== "object" || !("kind" in fact) || !("value" in fact)) return null;
  const candidate = fact as { kind: string; value: unknown };
  const numeric = typeof candidate.value === "number" ? candidate.value : Number.NaN;
  switch (fact.kind) {
    case "attempt":
    case "retry-attempt":
      return Number.isFinite(numeric) ? { kind: fact.kind, value: Math.round(finite(numeric, 0, 999)) } : null;
    case "sample-age-ms":
    case "elapsed-ms":
    case "provider-wait-ms":
      return Number.isFinite(numeric) ? { kind: fact.kind, value: Math.round(finite(numeric, 0, 86_400_000)) } : null;
    case "accuracy-meters":
    case "distance-meters":
      return Number.isFinite(numeric) ? { kind: fact.kind, value: Math.round(finite(numeric, 0, 100_000)) } : null;
    case "file-bytes":
      return Number.isFinite(numeric) ? { kind: fact.kind, value: Math.round(finite(numeric, 0, 100_000_000)) } : null;
    case "width-px":
    case "height-px":
      return Number.isFinite(numeric) ? { kind: fact.kind, value: Math.round(finite(numeric, 0, 20_000)) } : null;
    case "http-status":
      return Number.isFinite(numeric) ? { kind: fact.kind, value: Math.round(finite(numeric, 0, 599)) } : null;
    case "permission":
      return ["precise", "approximate", "denied", "prompt"].includes(String(candidate.value)) ? candidate as FieldDiagnosticFact : null;
    case "app-state":
      return ["active", "inactive"].includes(String(candidate.value)) ? candidate as FieldDiagnosticFact : null;
    case "visibility":
      return ["visible", "hidden"].includes(String(candidate.value)) ? candidate as FieldDiagnosticFact : null;
    case "source":
      return ["cached", "live"].includes(String(candidate.value)) ? candidate as FieldDiagnosticFact : null;
    case "network":
      return ["online", "offline"].includes(String(candidate.value)) ? candidate as FieldDiagnosticFact : null;
    case "mime-type":
      return ["image/jpeg", "image/png", "image/webp"].includes(String(candidate.value)) ? candidate as FieldDiagnosticFact : null;
    case "result":
      return ["started", "ready", "accepted", "cancelled", "saved", "rejected", "timed-out", "failed", "complete"].includes(String(candidate.value)) ? candidate as FieldDiagnosticFact : null;
    case "platform":
      return ["android", "web"].includes(String(candidate.value)) ? candidate as FieldDiagnosticFact : null;
    default:
      return null;
  }
}

function safeFacts(facts: readonly FieldDiagnosticFact[]) {
  return facts.flatMap((fact) => {
    const safe = safeFact(fact);
    return safe ? [safe] : [];
  });
}

function ttlFor(tone: FieldDiagnosticTone) {
  if (tone === "success") return SUCCESS_TTL_MS;
  if (tone === "warning" || tone === "error") return PROBLEM_TTL_MS;
  return WORKING_TTL_MS;
}

function tonePriority(tone: FieldDiagnosticTone) {
  return tone === "error" ? 4 : tone === "warning" ? 3 : tone === "working" ? 2 : 1;
}

function formatDuration(value: number) {
  return value < 1_000 ? `${Math.round(value)} ms` : `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`;
}

function formatBytes(value: number) {
  if (value < 1_000) return `${value} B`;
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)} KB`;
  return `${(value / 1_000_000).toFixed(1)} MB`;
}

export function formatFieldDiagnosticFact(fact: FieldDiagnosticFact) {
  switch (fact.kind) {
    case "attempt": return ["Attempt", String(fact.value)] as const;
    case "permission": return ["Permission", fact.value] as const;
    case "app-state": return ["App", fact.value] as const;
    case "visibility": return ["Screen", fact.value] as const;
    case "source": return ["Fix source", fact.value] as const;
    case "sample-age-ms": return ["Fix age", formatDuration(fact.value)] as const;
    case "accuracy-meters": return ["Accuracy", `±${fact.value} m`] as const;
    case "elapsed-ms": return ["Elapsed", formatDuration(fact.value)] as const;
    case "provider-wait-ms": return ["Provider wait", formatDuration(fact.value)] as const;
    case "distance-meters": return ["Boundary distance", `${fact.value} m`] as const;
    case "network": return ["Network", fact.value] as const;
    case "file-bytes": return ["Photo size", formatBytes(fact.value)] as const;
    case "mime-type": return ["Photo type", fact.value] as const;
    case "width-px": return ["Photo width", `${fact.value} px`] as const;
    case "height-px": return ["Photo height", `${fact.value} px`] as const;
    case "http-status": return ["HTTP", fact.value ? String(fact.value) : "no response"] as const;
    case "retry-attempt": return ["Retry", String(fact.value)] as const;
    case "result": return ["Result", fact.value] as const;
    case "platform": return ["Platform", fact.value] as const;
  }
}

export function createFieldDiagnosticsStore(enabled = true): FieldDiagnosticsStore {
  let entries: InternalEntry[] = [];
  let snapshot = EMPTY_SNAPSHOT;
  let sequence = 0;
  let eventSequence = 0;
  const listeners = new Set<() => void>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const globalPauseReasons = new Set<string>();

  const publicEntry = (entry: InternalEntry): FieldDiagnosticEntry => ({
    id: entry.id,
    traceId: entry.traceId,
    key: entry.key,
    flow: entry.flow,
    title: entry.title,
    tone: entry.tone,
    summary: entry.summary,
    startedAt: entry.startedAt,
    updatedAt: entry.updatedAt,
    visible: entry.visible,
    announcement: entry.announcement,
    timeline: entry.timeline,
  });

  const emit = () => {
    const retained = entries.map(publicEntry);
    const visible = retained
      .filter((entry) => entry.visible)
      .sort((left, right) => tonePriority(right.tone) - tonePriority(left.tone) || right.updatedAt - left.updatedAt)
      .slice(0, MAX_VISIBLE);
    snapshot = { retained, visible, announcement: retained.find((entry) => entry.announcement)?.announcement ?? "" };
    listeners.forEach((listener) => listener());
  };

  const clearTimer = (id: string) => {
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
  };

  const schedule = (entry: InternalEntry) => {
    clearTimer(entry.id);
    if (!entry.visible || entry.pauseReasons.size) return;
    entry.expiresAt = Date.now() + entry.remainingMs;
    timers.set(entry.id, setTimeout(() => {
      entry.visible = false;
      entry.announcement = "";
      timers.delete(entry.id);
      emit();
    }, entry.remainingMs));
  };

  const update = (id: string, stage: FieldDiagnosticStage, tone: FieldDiagnosticTone, input: UpdateInput) => {
    const entry = entries.find((candidate) => candidate.id === id);
    if (!entry) return;
    const now = Date.now();
    const summary = safeText(input.summary, "Diagnostic updated");
    entry.tone = tone;
    entry.summary = summary;
    entry.updatedAt = now;
    entry.visible = true;
    entry.remainingMs = ttlFor(tone);
    entry.expiresAt = now + entry.remainingMs;
    entries.forEach((candidate) => { candidate.announcement = ""; });
    entry.announcement = (input.announce ?? tone !== "working") ? `${entry.title}: ${summary}` : "";
    entry.timeline = [...entry.timeline, {
      id: ++eventSequence,
      stage,
      tone,
      relativeMs: Math.max(0, now - entry.startedAt),
      summary,
      facts: safeFacts(input.facts ?? []),
    }];
    entries = [entry, ...entries.filter((candidate) => candidate.id !== id)].slice(0, MAX_RETAINED);
    schedule(entry);
    emit();
  };

  const noOpTrace: FieldDiagnosticTrace = {
    id: "disabled",
    stage: () => undefined,
    succeed: () => undefined,
    warn: () => undefined,
    fail: () => undefined,
    dismiss: () => undefined,
  };

  const store: FieldDiagnosticsStore = {
    begin(input) {
      if (!enabled) return noOpTrace;
      const now = Date.now();
      const existing = entries.find((entry) => entry.key === safeKey(input.key));
      const id = existing?.id ?? `field-${++sequence}`;
      if (existing) clearTimer(existing.id);
      const title = safeText(input.title, input.flow === "location" ? "Location diagnostic" : "Photo diagnostic");
      const summary = safeText(input.summary ?? "Started", "Started");
      const entry: InternalEntry = {
        id,
        traceId: existing?.traceId ?? `PD-${sequence.toString(36).toUpperCase().padStart(3, "0")}`,
        key: safeKey(input.key),
        flow: input.flow,
        title,
        tone: "working",
        summary,
        startedAt: now,
        updatedAt: now,
        visible: true,
        announcement: title,
        timeline: [{
          id: ++eventSequence,
          stage: input.stage,
          tone: "working",
          relativeMs: 0,
          summary,
          facts: safeFacts(input.facts ?? []),
        }],
        expiresAt: now + WORKING_TTL_MS,
        remainingMs: WORKING_TTL_MS,
        pauseReasons: new Set(globalPauseReasons),
      };
      entries.forEach((candidate) => { candidate.announcement = ""; });
      entries = [entry, ...entries.filter((candidate) => candidate.id !== id)].slice(0, MAX_RETAINED);
      schedule(entry);
      emit();
      return {
        id,
        stage: (stage, detail) => update(id, stage, "working", detail),
        succeed: (stage, detail) => update(id, stage, "success", detail),
        warn: (stage, detail) => update(id, stage, "warning", detail),
        fail: (stage, detail) => update(id, stage, "error", detail),
        dismiss: () => store.dismiss(id),
      };
    },
    dismiss(id) {
      const entry = entries.find((candidate) => candidate.id === id);
      if (!entry) return;
      clearTimer(id);
      entry.visible = false;
      entry.announcement = "";
      emit();
    },
    pause(id, reason) {
      const entry = entries.find((candidate) => candidate.id === id);
      if (!entry || entry.pauseReasons.has(reason)) return;
      if (!entry.pauseReasons.size) {
        entry.remainingMs = Math.max(0, entry.expiresAt - Date.now());
        clearTimer(id);
      }
      entry.pauseReasons.add(reason);
    },
    resume(id, reason) {
      const entry = entries.find((candidate) => candidate.id === id);
      if (!entry || !entry.pauseReasons.delete(reason)) return;
      schedule(entry);
    },
    pauseAll(reason) { globalPauseReasons.add(reason); entries.forEach((entry) => store.pause(entry.id, reason)); },
    resumeAll(reason) { globalPauseReasons.delete(reason); entries.forEach((entry) => store.resume(entry.id, reason)); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot() { return snapshot; },
    copyText(id) {
      const entry = entries.find((candidate) => candidate.id === id);
      if (!entry) return "";
      const lines = [
        "Parkdex field diagnostic",
        `Trace: ${entry.traceId}`,
        `Flow: ${entry.flow}`,
        `Result: ${entry.tone}`,
        "Timeline:",
      ];
      entry.timeline.forEach((item) => {
        lines.push(`+${formatDuration(item.relativeMs)} ${item.stage}: ${item.summary}`);
        item.facts.forEach((fact) => {
          const [label, value] = formatFieldDiagnosticFact(fact);
          lines.push(`  ${label}: ${value}`);
        });
      });
      return lines.join("\n");
    },
    reset() {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
      globalPauseReasons.clear();
      entries = [];
      snapshot = EMPTY_SNAPSHOT;
      emit();
    },
  };
  return store;
}

export function fieldDiagnosticsEnabled() {
  return process.env.NEXT_PUBLIC_FIELD_DIAGNOSTICS === "1" || process.env.NODE_ENV === "development";
}

export const fieldDiagnostics = createFieldDiagnosticsStore(fieldDiagnosticsEnabled());
