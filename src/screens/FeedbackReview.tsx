import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Icon } from "../components/Icon";
import { Kip } from "../components/Kip";
import { fetchOperatorApi } from "../lib/operatorApiTransport";
import "../feedback-review.css";

type ReportStatus = "new" | "reviewing" | "planned" | "closed";
type StatusFilter = "all" | ReportStatus;
type EmailAudience = "operator" | "receipt";
type EmailStatus = "pending" | "sending" | "sent" | "failed" | "ambiguous" | string;

type FeedbackContext = {
  version?: unknown;
  build?: unknown;
  platform?: unknown;
  screen?: unknown;
  parkId?: unknown;
  parkName?: unknown;
  [key: string]: unknown;
};

type EmailDelivery = {
  audience: EmailAudience;
  status: EmailStatus;
  canRetry?: boolean;
  requiresConfirmation?: boolean;
  attempts?: number;
  lastAttemptAt?: string | null;
  sentAt?: string | null;
  lastError?: string | null;
};

type FeedbackReport = {
  id: string;
  kind: string;
  message: string;
  email: string | null;
  contact: boolean;
  context?: FeedbackContext | null;
  createdAt: string;
  status: ReportStatus;
  hasScreenshot: boolean;
  emails?: EmailDelivery[];
  notifications?: Partial<Record<EmailAudience, Omit<EmailDelivery, "audience">>>;
};

type ApiErrorShape = { error?: unknown; message?: unknown };

class OperatorApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "new", label: "New" },
  { value: "reviewing", label: "Reviewing" },
  { value: "planned", label: "Planned" },
  { value: "closed", label: "Closed" },
];

const REPORT_STATUSES: { value: ReportStatus; label: string }[] = STATUS_FILTERS.filter(
  (option): option is { value: ReportStatus; label: string } => option.value !== "all",
);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function responseError(response: Response): Promise<OperatorApiError> {
  let message = friendlyResponseMessage(response.status);
  try {
    const body = (await response.clone().json()) as ApiErrorShape;
    const nestedError = body.error && typeof body.error === "object" ? (body.error as ApiErrorShape).message : undefined;
    const candidate = typeof body.error === "string" ? body.error : typeof body.message === "string" ? body.message : nestedError;
    if (typeof candidate === "string" && candidate.trim()) message = candidate.trim().slice(0, 240);
  } catch {
    // Non-JSON error bodies are intentionally omitted from the operator UI.
  }
  return new OperatorApiError(response.status, message);
}

function friendlyResponseMessage(status: number): string {
  if (status === 401) return "Your operator session has expired.";
  if (status === 403) return "You do not have access to this report.";
  if (status === 404) return "This report could not be found.";
  if (status >= 500) return "The review service is temporarily unavailable.";
  return "The request could not be completed.";
}

async function timedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const parentSignal = init.signal;
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = window.setTimeout(
    () => controller.abort(new DOMException("The review service took too long to respond.", "TimeoutError")),
    40_000,
  );
  try {
    return await fetchOperatorApi(path, { ...init, signal: controller.signal }, globalThis.fetch, {
      pageOrigin: window.location.origin,
      allowLoopbackHttp: import.meta.env.DEV,
    });
  } finally {
    window.clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  const response = await timedFetch(path, { ...init, headers });
  if (!response.ok) throw await responseError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function requestedReportId(): string | null {
  const value = new URLSearchParams(window.location.search).get("id");
  return value && UUID.test(value) ? value : null;
}

function writeReportId(id: string | null) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("id", id);
  else url.searchParams.delete("id");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function reportKind(kind: string): string {
  if (kind === "bug") return "Bug report";
  if (kind === "idea") return "Feature idea";
  if (kind === "general") return "General feedback";
  return kind ? `${kind[0].toUpperCase()}${kind.slice(1)}` : "Feedback report";
}

function statusLabel(status: string): string {
  return REPORT_STATUSES.find((item) => item.value === status)?.label ?? "New";
}

function emailStatusLabel(delivery: EmailDelivery): string {
  if (delivery.requiresConfirmation) return "Recovery check required";
  if (delivery.canRetry && (delivery.status === "sending" || delivery.status === "ambiguous")) return "Retry available";
  if (delivery.status === "pending") return "Waiting";
  if (delivery.status === "sending") return "Sending";
  if (delivery.status === "sent") return "Sent";
  if (delivery.status === "failed") return "Failed";
  if (delivery.status === "ambiguous") return "Delivery unclear";
  if (delivery.status === "disabled") return "Email disabled";
  return "Not sent";
}

function safeText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function safeEmail(value: string | null | undefined): string | null {
  const email = value?.trim();
  return email && EMAIL.test(email) && !/[\r\n]/.test(email) ? email : null;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "Date unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function getDeliveries(report: FeedbackReport): EmailDelivery[] {
  if (Array.isArray(report.emails)) return report.emails;
  if (!report.notifications) return [];
  return (["operator", "receipt"] as const).flatMap((audience) => {
    const delivery = report.notifications?.[audience];
    return delivery ? [{ audience, ...delivery }] : [];
  });
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function FeedbackReview() {
  const [auth, setAuth] = useState<"checking" | "signed-out" | "signed-in">("checking");
  const [authNotice, setAuthNotice] = useState("");
  const [password, setPassword] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const [reports, setReports] = useState<FeedbackReport[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [listState, setListState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [listError, setListError] = useState("");
  const [listRevision, setListRevision] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(() => requestedReportId());
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const authRef = useRef(auth);
  authRef.current = auth;
  const sessionGenerationRef = useRef(0);
  const selectionGenerationRef = useRef(0);
  const [mobilePane, setMobilePane] = useState<"list" | "detail">(() => (requestedReportId() ? "detail" : "list"));
  const [detail, setDetail] = useState<FeedbackReport | null>(null);
  const [detailState, setDetailState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [detailError, setDetailError] = useState("");
  const [detailRevision, setDetailRevision] = useState(0);
  const [attachmentUrl, setAttachmentUrl] = useState<string | null>(null);
  const [attachmentState, setAttachmentState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [attachmentRevision, setAttachmentRevision] = useState(0);
  const [attachmentError, setAttachmentError] = useState("");
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusNotice, setStatusNotice] = useState("");
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryNotice, setRetryNotice] = useState("");
  const [confirmRiskRetry, setConfirmRiskRetry] = useState(false);
  const [pageBusy, setPageBusy] = useState(false);

  const isLiveSessionRequest = useCallback(
    (generation: number) => generation === sessionGenerationRef.current && authRef.current === "signed-in",
    [],
  );

  const clearPrivateData = useCallback(() => {
    sessionGenerationRef.current += 1;
    selectionGenerationRef.current += 1;
    writeReportId(null);
    setAuth("signed-out");
    setPassword("");
    setMobilePane("list");
    setReports([]);
    setNextCursor(null);
    selectedIdRef.current = null;
    setSelectedId(null);
    setDetail(null);
    setDetailState("idle");
    setAttachmentUrl(null);
    setAttachmentState("idle");
    setAttachmentError("");
    setListError("");
    setDetailError("");
    setListState("idle");
    setStatusNotice("");
    setRetryNotice("");
    setConfirmRiskRetry(false);
    setStatusBusy(false);
    setRetryBusy(false);
    setPageBusy(false);
    setLoginBusy(false);
  }, []);

  useEffect(() => {
    let active = true;
    const generation = sessionGenerationRef.current;
    const controller = new AbortController();
    requestJson<{ authenticated?: boolean }>("/api/operator/session", { signal: controller.signal })
      .then((session) => {
        if (!active || generation !== sessionGenerationRef.current) return;
        if (session.authenticated) {
          sessionGenerationRef.current += 1;
          selectionGenerationRef.current += 1;
          setAuth("signed-in");
          setAuthNotice("");
        } else {
          setAuth("signed-out");
          setAuthNotice("");
        }
      })
      .catch((error: unknown) => {
        if (!active || generation !== sessionGenerationRef.current || (error instanceof DOMException && error.name === "AbortError")) return;
        setAuth("signed-out");
        setAuthNotice(error instanceof OperatorApiError && error.status === 401 ? "Sign in to continue." : "Could not check your session. Sign in to continue.");
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  useEffect(() => {
    writeReportId(selectedId);
  }, [selectedId]);

  useEffect(() => {
    if (auth !== "signed-in") return;
    let active = true;
    const generation = sessionGenerationRef.current;
    const controller = new AbortController();
    setListState("loading");
    setListError("");
    const params = new URLSearchParams({ status: filter });
    requestJson<{ reports?: FeedbackReport[]; nextCursor?: string | null }>(`/api/operator/feedback?${params.toString()}`, { signal: controller.signal })
      .then((result) => {
        if (!active || !isLiveSessionRequest(generation)) return;
        const incoming = Array.isArray(result.reports) ? result.reports : [];
        setReports(incoming);
        setNextCursor(result.nextCursor ?? null);
        setListState("ready");
        const requestedId = requestedReportId();
        const currentId = selectedIdRef.current;
        const nextId = requestedId ?? (currentId && incoming.some((report) => report.id === currentId) ? currentId : incoming[0]?.id ?? null);
        if (nextId !== currentId) {
          selectionGenerationRef.current += 1;
          setDetail(null);
          setStatusBusy(false);
          setRetryBusy(false);
          setConfirmRiskRetry(false);
        }
        selectedIdRef.current = nextId;
        setSelectedId(nextId);
        if (requestedId) setMobilePane("detail");
      })
      .catch((error: unknown) => {
        if (!active || !isLiveSessionRequest(generation) || (error instanceof DOMException && error.name === "AbortError")) return;
        if (error instanceof OperatorApiError && error.status === 401) {
          clearPrivateData();
          setAuthNotice("Your session expired. Sign in again.");
          return;
        }
        setListState("error");
        setListError(errorMessage(error, "Could not load feedback. Check your connection and try again."));
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [auth, filter, listRevision, clearPrivateData, isLiveSessionRequest]);

  useEffect(() => {
    if (auth !== "signed-in" || !selectedId) {
      setDetail(null);
      setDetailState("idle");
      setDetailError("");
      return;
    }
    let active = true;
    const generation = sessionGenerationRef.current;
    const selectionGeneration = selectionGenerationRef.current;
    const controller = new AbortController();
    setDetail(null);
    setDetailState("loading");
    setDetailError("");
    requestJson<{ report?: FeedbackReport }>(`/api/operator/feedback/${encodeURIComponent(selectedId)}`, { signal: controller.signal })
      .then((result) => {
        if (!active || !isLiveSessionRequest(generation) || selectionGeneration !== selectionGenerationRef.current || selectedIdRef.current !== selectedId) return;
        if (!result.report) throw new Error("This report could not be found.");
        setDetail(result.report);
        setDetailState("ready");
      })
      .catch((error: unknown) => {
        if (!active || !isLiveSessionRequest(generation) || selectionGeneration !== selectionGenerationRef.current || selectedIdRef.current !== selectedId || (error instanceof DOMException && error.name === "AbortError")) return;
        if (error instanceof OperatorApiError && error.status === 401) {
          clearPrivateData();
          setAuthNotice("Your session expired. Sign in again.");
          return;
        }
        setDetailState("error");
        setDetailError(errorMessage(error, "Could not load this report. Try again."));
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [auth, selectedId, detailRevision, clearPrivateData, isLiveSessionRequest]);

  useEffect(() => {
    if (auth !== "signed-in" || !selectedId || !detail?.hasScreenshot) {
      setAttachmentUrl(null);
      setAttachmentState("idle");
      setAttachmentError("");
      return;
    }
    let active = true;
    const generation = sessionGenerationRef.current;
    const selectionGeneration = selectionGenerationRef.current;
    let createdUrl: string | null = null;
    const controller = new AbortController();
    setAttachmentUrl(null);
    setAttachmentState("loading");
    setAttachmentError("");
    const headers = new Headers();
    headers.set("Content-Type", "application/json");
    timedFetch(`/api/operator/feedback/${encodeURIComponent(selectedId)}/attachment`, { headers, signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw await responseError(response);
        return response.blob();
      })
      .then((blob) => {
        if (!active || !isLiveSessionRequest(generation) || selectionGeneration !== selectionGenerationRef.current || selectedIdRef.current !== selectedId) return;
        createdUrl = URL.createObjectURL(blob);
        setAttachmentUrl(createdUrl);
        setAttachmentState("ready");
      })
      .catch((error: unknown) => {
        if (!active || !isLiveSessionRequest(generation) || selectionGeneration !== selectionGenerationRef.current || selectedIdRef.current !== selectedId || (error instanceof DOMException && error.name === "AbortError")) return;
        if (error instanceof OperatorApiError && error.status === 401) {
          clearPrivateData();
          setAuthNotice("Your session expired. Sign in again.");
          return;
        }
        setAttachmentState("error");
        setAttachmentError(errorMessage(error, "Could not load the screenshot."));
      });
    return () => {
      active = false;
      controller.abort();
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [auth, selectedId, detail?.hasScreenshot, attachmentRevision, clearPrivateData, isLiveSessionRequest]);

  const deliveries = useMemo(() => (detail ? getDeliveries(detail) : []), [detail]);
  const requiresConfirmation = useMemo(() => deliveries.some((delivery) => delivery.requiresConfirmation === true), [deliveries]);
  const retryAudiences = useMemo(
    () => deliveries.filter((delivery) => delivery.canRetry === true || delivery.requiresConfirmation === true || (delivery.canRetry === undefined && (delivery.status === "pending" || delivery.status === "failed"))).map((delivery) => delivery.audience),
    [deliveries],
  );

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!password.trim() || loginBusy || logoutBusy) return;
    const generation = sessionGenerationRef.current;
    setLoginBusy(true);
    setAuthNotice("");
    try {
      await requestJson<{ ok?: boolean }>("/api/operator/login", { method: "POST", body: JSON.stringify({ password }) });
      if (generation !== sessionGenerationRef.current) return;
      sessionGenerationRef.current += 1;
      selectionGenerationRef.current += 1;
      setPassword("");
      setLoginBusy(false);
      setAuth("signed-in");
    } catch (error) {
      if (generation === sessionGenerationRef.current) {
        setAuthNotice(error instanceof OperatorApiError && error.status === 401 ? "That password did not match. Try again." : "Could not sign in. Check your connection and try again.");
      }
    } finally {
      if (generation === sessionGenerationRef.current) setLoginBusy(false);
    }
  }

  async function signOut() {
    if (logoutBusy) return;
    setLogoutBusy(true);
    clearPrivateData();
    const generation = sessionGenerationRef.current;
    setAuthNotice("Signing out...");
    try {
      await requestJson<{ ok?: boolean }>("/api/operator/logout", { method: "POST", body: "{}" });
      if (generation === sessionGenerationRef.current) setAuthNotice("You are signed out.");
    } catch {
      if (generation === sessionGenerationRef.current) setAuthNotice("You are signed out of this screen, but server logout could not be confirmed.");
    } finally {
      if (generation === sessionGenerationRef.current) setLogoutBusy(false);
    }
  }

  function changeFilter(nextFilter: StatusFilter) {
    if (nextFilter === filter) return;
    sessionGenerationRef.current += 1;
    selectionGenerationRef.current += 1;
    writeReportId(null);
    selectedIdRef.current = null;
    setSelectedId(null);
    setDetail(null);
    setStatusNotice("");
    setRetryNotice("");
    setConfirmRiskRetry(false);
    setReports([]);
    setNextCursor(null);
    setListState("idle");
    setPageBusy(false);
    setStatusBusy(false);
    setRetryBusy(false);
    setFilter(nextFilter);
    setMobilePane("list");
  }

  function selectReport(id: string) {
    if (id !== selectedIdRef.current) {
      selectionGenerationRef.current += 1;
      setDetail(null);
      setDetailState("loading");
      setAttachmentUrl(null);
      setStatusBusy(false);
      setRetryBusy(false);
      setConfirmRiskRetry(false);
    }
    selectedIdRef.current = id;
    setSelectedId(id);
    setStatusNotice("");
    setRetryNotice("");
    setMobilePane("detail");
  }

  async function loadNextPage() {
    if (!nextCursor || pageBusy) return;
    const generation = sessionGenerationRef.current;
    const pageFilter = filter;
    setPageBusy(true);
    setListError("");
    const params = new URLSearchParams({ status: filter, cursor: nextCursor });
    try {
      const result = await requestJson<{ reports?: FeedbackReport[]; nextCursor?: string | null }>(`/api/operator/feedback?${params.toString()}`);
      if (!isLiveSessionRequest(generation) || filterRef.current !== pageFilter) return;
      const incoming = Array.isArray(result.reports) ? result.reports : [];
      setReports((current) => {
        const byId = new Map(current.map((report) => [report.id, report]));
        incoming.forEach((report) => byId.set(report.id, report));
        return [...byId.values()];
      });
      setNextCursor(result.nextCursor ?? null);
    } catch (error) {
      if (!isLiveSessionRequest(generation) || filterRef.current !== pageFilter) return;
      if (error instanceof OperatorApiError && error.status === 401) {
        clearPrivateData();
        setAuthNotice("Your session expired. Sign in again.");
      } else {
        setListError(errorMessage(error, "Could not load more feedback. Try again."));
      }
    } finally {
      if (generation === sessionGenerationRef.current) setPageBusy(false);
    }
  }

  async function changeStatus(nextStatus: ReportStatus) {
    if (!detail || detail.status === nextStatus || statusBusy || retryBusy) return;
    const reportId = detail.id;
    const generation = sessionGenerationRef.current;
    const selectionGeneration = selectionGenerationRef.current;
    setStatusBusy(true);
    setStatusNotice("");
    setRetryNotice("");
    try {
      const result = await requestJson<{ report?: FeedbackReport }>(`/api/operator/feedback/${encodeURIComponent(reportId)}`, {
        method: "PATCH",
        body: JSON.stringify({ status: nextStatus }),
      });
      if (!isLiveSessionRequest(generation) || selectionGeneration !== selectionGenerationRef.current || selectedIdRef.current !== reportId) return;
      if (!result.report) throw new Error("The saved report was not returned. Refresh to confirm its status.");
      setDetail(result.report);
      setReports((current) => current.map((report) => (report.id === result.report!.id ? result.report! : report)));
      if (filter !== "all" && filter !== result.report.status) {
        sessionGenerationRef.current += 1;
        setPageBusy(false);
        setStatusBusy(false);
        setConfirmRiskRetry(false);
        setFilter("all");
        setAttachmentRevision((revision) => revision + 1);
        setStatusNotice("Status saved. Showing all reports.");
      } else {
        setStatusNotice("Status saved.");
      }
    } catch (error) {
      if (!isLiveSessionRequest(generation) || selectionGeneration !== selectionGenerationRef.current || selectedIdRef.current !== reportId) return;
      if (error instanceof OperatorApiError && error.status === 401) {
        clearPrivateData();
        setAuthNotice("Your session expired. Sign in again.");
      } else {
        setStatusNotice(errorMessage(error, "Could not save the status. Try again."));
      }
    } finally {
      if (generation === sessionGenerationRef.current && selectionGeneration === selectionGenerationRef.current && selectedIdRef.current === reportId) setStatusBusy(false);
    }
  }

  async function retryEmails() {
    if (!detail || retryAudiences.length === 0 || retryBusy || statusBusy || (requiresConfirmation && !confirmRiskRetry)) return;
    const reportId = detail.id;
    const generation = sessionGenerationRef.current;
    const selectionGeneration = selectionGenerationRef.current;
    setRetryBusy(true);
    setRetryNotice("");
    try {
      const result = await requestJson<{ results?: { audience: EmailAudience; status: string }[] }>(
        `/api/operator/feedback/${encodeURIComponent(reportId)}/retry-emails`,
        { method: "POST", body: JSON.stringify({ audiences: [...new Set(retryAudiences)], ...(requiresConfirmation ? { confirmAmbiguousAfter24h: true } : {}) }) },
      );
      if (!isLiveSessionRequest(generation) || selectionGeneration !== selectionGenerationRef.current || selectedIdRef.current !== reportId) return;
      const outcomes = result.results ?? [];
      if (outcomes.some((item) => item.status === "requires_confirmation" || item.status === "ambiguous")) {
        setRetryNotice("An email delivery is unclear. Check the mailbox before taking action.");
      } else if (outcomes.some((item) => item.status === "failed")) {
        setRetryNotice("Retry finished. Some emails still failed.");
      } else if (outcomes.some((item) => item.status === "sent")) {
        setRetryNotice("Retry finished. Delivery status is updated.");
      } else {
        setRetryNotice("No email needed a retry.");
      }
      setConfirmRiskRetry(false);
      setDetailRevision((revision) => revision + 1);
      setListRevision((revision) => revision + 1);
    } catch (error) {
      if (!isLiveSessionRequest(generation) || selectionGeneration !== selectionGenerationRef.current || selectedIdRef.current !== reportId) return;
      if (error instanceof OperatorApiError && error.status === 401) {
        clearPrivateData();
        setAuthNotice("Your session expired. Sign in again.");
      } else {
        setRetryNotice(errorMessage(error, "Could not retry email delivery. Try again."));
      }
    } finally {
      if (generation === sessionGenerationRef.current && selectionGeneration === selectionGenerationRef.current && selectedIdRef.current === reportId) setRetryBusy(false);
    }
  }

  if (auth === "checking") {
    return (
      <main className="fr-review fr-review--center" aria-live="polite">
        <div className="fr-state-card">
          <span className="fr-spinner" aria-hidden="true" />
          <p>Checking operator access...</p>
        </div>
      </main>
    );
  }

  if (auth !== "signed-in") {
    return (
      <main className="fr-review fr-review--auth">
        <section className="fr-auth-panel" aria-labelledby="fr-auth-title">
          <div className="fr-auth-mark">
            <Kip pose="think" size={62} />
          </div>
          <h1 id="fr-auth-title">Operator sign in</h1>
          <p className="fr-auth-copy">This is a private Parkdex review area. Reports are visible only to signed-in operators.</p>
          {authNotice && <p className="fr-auth-notice" role="status">{authNotice}</p>}
          <form className="fr-login-form" onSubmit={signIn}>
            <label htmlFor="fr-password">Operator password</label>
            <input
              id="fr-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
              autoFocus
              disabled={logoutBusy}
            />
            <button className="fr-button fr-button--primary fr-button--wide" type="submit" disabled={!password.trim() || loginBusy || logoutBusy}>
              {logoutBusy ? <><span className="fr-spinner fr-spinner--small" /> Signing out...</> : loginBusy ? <><span className="fr-spinner fr-spinner--small" /> Signing in...</> : "Sign in"}
            </button>
          </form>
          <div className="fr-auth-foot">
            <LockMark />
            <span>Access is protected by an operator session.</span>
          </div>
        </section>
      </main>
    );
  }

  const hasSelection = Boolean(selectedId);
  const layoutClass = `fr-workbench${mobilePane === "detail" && hasSelection ? " fr-workbench--mobile-detail" : ""}`;

  return (
    <main className="fr-review" aria-label="Private feedback review">
      <div className="fr-shell">
        <header className="fr-header">
          <div className="fr-brand">
            <Kip pose="avatar" size={43} />
            <div>
              <p className="fr-brand-name">parkdex</p>
              <h1>Feedback review</h1>
            </div>
          </div>
          <div className="fr-header-actions">
            <div className="fr-private-label"><LockMark /><span>Private operator area</span></div>
            <a className="fr-button fr-button--paper" href="/operator/builds">Build config</a>
            <button className="fr-button fr-button--quiet fr-signout" type="button" onClick={signOut} disabled={logoutBusy}>
              {logoutBusy ? "Signing out..." : "Sign out"}
            </button>
          </div>
        </header>

        <div className={layoutClass}>
          <aside className="fr-inbox" aria-label="Feedback inbox">
            <div className="fr-inbox-heading">
              <div>
                <h2>Reports</h2>
                <p>Read each report and set its next step.</p>
              </div>
              <button className="fr-icon-button" type="button" aria-label="Refresh reports" onClick={() => setListRevision((revision) => revision + 1)} disabled={listState === "loading"}>
                <Icon name="refresh" size={18} />
              </button>
            </div>

            <div className="fr-filters" role="tablist" aria-label="Filter reports by status">
              {STATUS_FILTERS.map((option) => (
                <button
                  key={option.value}
                  className={`fr-filter${filter === option.value ? " is-selected" : ""}`}
                  type="button"
                  role="tab"
                  aria-selected={filter === option.value}
                  onClick={() => changeFilter(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <div className="fr-report-list" aria-live="polite" aria-busy={listState === "loading"}>
              {listState === "loading" && reports.length === 0 ? (
                <div className="fr-list-state"><span className="fr-spinner" aria-hidden="true" /><span>Loading reports...</span></div>
              ) : listState === "error" ? (
                <div className="fr-list-state fr-list-state--error" role="alert">
                  <strong>Reports did not load.</strong>
                  <span>{listError}</span>
                  <button className="fr-text-button" type="button" onClick={() => setListRevision((revision) => revision + 1)}>Try again</button>
                </div>
              ) : reports.length === 0 ? (
                <div className="fr-list-state fr-list-state--empty">
                  <span className="fr-empty-mark"><Icon name="chat" size={23} /></span>
                  <strong>{filter === "all" ? "Nothing here yet." : `No ${filter} reports.`}</strong>
                  <span>{filter === "all" ? "New feedback will show up here." : "Choose another status to keep reviewing."}</span>
                </div>
              ) : (
                reports.map((report) => (
                  <button
                    key={report.id}
                    className={`fr-report-row${selectedId === report.id ? " is-current" : ""}`}
                    type="button"
                    aria-current={selectedId === report.id ? "true" : undefined}
                    onClick={() => selectReport(report.id)}
                  >
                    <span className="fr-report-row__top">
                      <span className="fr-report-kind">{reportKind(report.kind)}</span>
                      <time dateTime={report.createdAt}>{formatDate(report.createdAt)}</time>
                    </span>
                    <span className="fr-report-preview">{report.message || "No message supplied."}</span>
                    <span className="fr-report-row__bottom">
                      <span className={`fr-status-dot fr-status-dot--${report.status}`} aria-hidden="true" />
                      <span>{statusLabel(report.status)}</span>
                      {safeText(report.context?.parkName) && <><span className="fr-list-separator" aria-hidden="true" /><span className="fr-report-park">{safeText(report.context?.parkName)}</span></>}
                      {report.hasScreenshot && <span className="fr-attachment-label"><Icon name="image" size={14} /> Image</span>}
                    </span>
                  </button>
                ))
              )}
              {listState === "loading" && reports.length > 0 && <div className="fr-refreshing"><span className="fr-spinner fr-spinner--small" /> Updating reports...</div>}
            </div>

            <div className="fr-inbox-foot">
              {listError && listState !== "error" && <p className="fr-inline-error" role="alert">{listError}</p>}
              {nextCursor && <button className="fr-button fr-button--paper fr-button--wide" type="button" onClick={loadNextPage} disabled={pageBusy}>
                {pageBusy ? <><span className="fr-spinner fr-spinner--small" /> Loading...</> : "Load more reports"}
              </button>}
            </div>
          </aside>

          <section className="fr-detail" aria-label="Report details">
            {detailState === "loading" && <div className="fr-detail-state"><span className="fr-spinner" /><p>Opening report...</p></div>}
            {detailState === "error" && <div className="fr-detail-state fr-detail-state--error" role="alert">
              <h2>Could not open this report.</h2>
              <p>{detailError}</p>
              <button className="fr-button fr-button--paper" type="button" onClick={() => setDetailRevision((revision) => revision + 1)}>Try again</button>
            </div>}
            {detailState === "idle" && <div className="fr-detail-state fr-detail-state--empty">
              <span className="fr-empty-mark"><Icon name="chat" size={26} /></span>
              <h2>Select a report</h2>
              <p>Choose feedback from the inbox to read the full report and its context.</p>
            </div>}
            {detailState === "ready" && detail && (
              <>
                <div className="fr-detail-header">
                  <button className="fr-back-button" type="button" onClick={() => setMobilePane("list")}>
                    <Icon name="back" size={18} stroke={2.8} /> Inbox
                  </button>
                  <div className="fr-detail-title">
                    <div className="fr-detail-meta">
                      <span className={`fr-kind-tag fr-kind-tag--${detail.kind}`}>{reportKind(detail.kind)}</span>
                      <time dateTime={detail.createdAt}>{formatDate(detail.createdAt)}</time>
                    </div>
                    <h2>{reportKind(detail.kind)}</h2>
                  </div>
                  <label className="fr-status-control">
                    <span>Status</span>
                    <select value={detail.status} onChange={(event) => void changeStatus(event.target.value as ReportStatus)} disabled={statusBusy} aria-label="Report status">
                      {REPORT_STATUSES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                    {statusBusy && <span className="fr-spinner fr-spinner--small" aria-label="Saving status" />}
                  </label>
                </div>

                <div className="fr-detail-scroll">
                  {statusNotice && <p className="fr-notice" role="status">{statusNotice}</p>}
                  <section className="fr-content-section fr-message-section">
                    <h3>Report</h3>
                    <p className="fr-message">{detail.message || "No message supplied."}</p>
                  </section>

                  <section className="fr-content-section">
                    <h3>Sent with the report</h3>
                    <dl className="fr-context-grid">
                      {safeText(detail.context?.parkName) && <ContextItem label="Park" value={safeText(detail.context?.parkName)!} />}
                      {safeText(detail.context?.screen) && <ContextItem label="Screen" value={safeText(detail.context?.screen)!} />}
                      {safeText(detail.context?.platform) && <ContextItem label="Platform" value={safeText(detail.context?.platform)!} />}
                      {safeText(detail.context?.version) && <ContextItem label="App version" value={safeText(detail.context?.version)!} />}
                      {safeText(detail.context?.build) && <ContextItem label="Build" value={safeText(detail.context?.build)!} />}
                      {safeText(detail.context?.parkId) && <ContextItem label="Park ID" value={safeText(detail.context?.parkId)!} />}
                    </dl>
                    {!detail.context || Object.values(detail.context).every((value) => !safeText(value)) ? <p className="fr-muted-copy">No additional app context was included.</p> : null}
                  </section>

                  <section className="fr-content-section fr-contact-section">
                    <div>
                      <h3>Follow-up</h3>
                      {detail.contact && safeEmail(detail.email) ? (
                        <p className="fr-followup-copy">They asked to be contacted. Reply manually from your mail app.</p>
                      ) : !detail.contact ? (
                        <p className="fr-followup-copy">They did not ask to be contacted. Their email address is hidden here.</p>
                      ) : (
                        <p className="fr-followup-copy">They asked to be contacted, but no usable email address was saved.</p>
                      )}
                    </div>
                    {detail.contact && safeEmail(detail.email) && <a className="fr-button fr-button--paper fr-reply-link" href={`mailto:${safeEmail(detail.email)}`}>
                      <Icon name="chat" size={17} /> Reply by email
                    </a>}
                  </section>

                  {detail.hasScreenshot && <section className="fr-content-section fr-screenshot-section">
                    <div className="fr-section-heading">
                      <h3>Attached screenshot</h3>
                      <span>Private attachment</span>
                    </div>
                    {attachmentState === "loading" && <div className="fr-attachment-state"><span className="fr-spinner fr-spinner--small" /> Loading screenshot...</div>}
                    {attachmentState === "error" && <div className="fr-attachment-state fr-attachment-state--error" role="alert">
                      <span>{attachmentError}</span>
                      <button className="fr-text-button" type="button" onClick={() => setAttachmentRevision((revision) => revision + 1)}>Try again</button>
                    </div>}
                    {attachmentState === "ready" && attachmentUrl && <img className="fr-screenshot" src={attachmentUrl} alt="Screenshot attached to this feedback report" />}
                  </section>}

                  <section className="fr-content-section fr-email-section">
                    <div className="fr-section-heading">
                      <div>
                        <h3>Email delivery</h3>
                        <p>Manual recovery only. No follow-up is sent automatically.</p>
                      </div>
                      <button className="fr-button fr-button--primary fr-retry-button" type="button" onClick={retryEmails} disabled={retryAudiences.length === 0 || retryBusy || (requiresConfirmation && !confirmRiskRetry)}>
                        {retryBusy ? <><span className="fr-spinner fr-spinner--small" /> Retrying...</> : requiresConfirmation && !confirmRiskRetry ? "Check delivery before retry" : retryAudiences.length ? `Retry available (${retryAudiences.length})` : "No retry needed"}
                      </button>
                    </div>
                    {requiresConfirmation && <label className="fr-risk-confirm">
                      <input type="checkbox" checked={confirmRiskRetry} onChange={(event) => setConfirmRiskRetry(event.target.checked)} />
                      <span><strong>Recovery confirmation required.</strong> I checked Resend and each relevant mailbox. No matching message was delivered, and I want to retry with duplicate risk.</span>
                    </label>}
                    {deliveries.length > 0 ? (
                      <div className="fr-delivery-list">
                        {deliveries.map((delivery) => (
                          <div className="fr-delivery-row" key={delivery.audience}>
                            <span className="fr-delivery-label">{delivery.audience === "operator" ? "Operator copy" : "Receipt to sender"}</span>
                            <span className={`fr-delivery-status fr-delivery-status--${delivery.requiresConfirmation ? "needs-confirmation" : delivery.canRetry && delivery.status === "sending" ? "retryable" : delivery.status}`}>{emailStatusLabel(delivery)}</span>
                            <span className="fr-delivery-time">{delivery.sentAt ? `Sent ${formatDate(delivery.sentAt)}` : delivery.lastAttemptAt ? `Last attempt ${formatDate(delivery.lastAttemptAt)}` : delivery.status === "pending" ? "Not attempted yet" : delivery.status === "disabled" && (delivery.attempts ?? 0) === 0 ? "Not attempted" : "Date unavailable"}</span>
                            {delivery.attempts !== undefined && <span className="fr-delivery-attempts">{delivery.attempts} {delivery.attempts === 1 ? "attempt" : "attempts"}</span>}
                            {delivery.lastError && <p className="fr-delivery-error">The previous delivery returned an error. Review it before retrying.</p>}
                          </div>
                        ))}
                      </div>
                    ) : <p className="fr-muted-copy">No email delivery was scheduled for this report.</p>}
                    {retryNotice && <p className="fr-notice" role="status">{retryNotice}</p>}
                    <p className="fr-delivery-guidance">Retryable sends use the recorded delivery state. Older unclear sends require this explicit mailbox check before another attempt.</p>
                  </section>
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

function ContextItem({ label, value }: { label: string; value: string }) {
  return <div className="fr-context-item"><dt>{label}</dt><dd>{value}</dd></div>;
}

function LockMark() {
  return (
    <svg className="fr-lock-mark" viewBox="0 0 20 20" aria-hidden="true">
      <rect x="4.5" y="8.5" width="11" height="8" rx="2" />
      <path d="M6.8 8.5V6.2a3.2 3.2 0 0 1 6.4 0v2.3M10 11.5v2.2" />
    </svg>
  );
}
