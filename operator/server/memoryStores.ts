import type { AppConfigPlatform, AppConfigStore, BuildConfigInput, BuildConfigRecord } from "../../worker/appConfig.js";
import type { ParkProposalRecord, ParkProposalStore, ProposalStatus } from "../../worker/parkProposals.js";
import type { AttachmentRecord, ClaimEmailResult, EmailDeliveryView, FeedbackCursor, FeedbackStore, OperatorFeedbackRecord } from "../../worker/store.js";
import type { EmailAudience, FeedbackStatus } from "../../worker/validation.js";
import type { DashboardDependencies } from "./api.js";

/** In-memory stores for tests and the local demo server. Never used by a deployment. */

export class MemoryFeedbackStore implements FeedbackStore {
  readonly reports = new Map<string, OperatorFeedbackRecord>();
  readonly attachments = new Map<string, AttachmentRecord>();

  async saveFeedback(): Promise<never> { throw new Error("not supported"); }
  async findBySubmissionId() { return null; }

  async getReport(id: string) {
    return structuredClone(this.reports.get(id) ?? null);
  }

  async listReports(limit: number, status: FeedbackStatus | null, cursor: FeedbackCursor | null) {
    return [...this.reports.values()]
      .filter((report) => !status || report.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .filter((report) => !cursor || report.createdAt < cursor.createdAt || (report.createdAt === cursor.createdAt && report.id < cursor.id))
      .slice(0, limit)
      .map((report) => structuredClone(report));
  }

  async getAttachment(id: string) {
    return this.attachments.get(id) ?? null;
  }

  async updateStatus(id: string, status: FeedbackStatus) {
    const report = this.reports.get(id);
    if (!report) return null;
    report.status = status;
    return structuredClone(report);
  }

  async getEmailDelivery(id: string, audience: EmailAudience) {
    return structuredClone(this.delivery(id, audience) ?? null);
  }

  async claimEmail(id: string, audience: EmailAudience): Promise<ClaimEmailResult> {
    const delivery = this.delivery(id, audience);
    const report = this.reports.get(id);
    if (!delivery || !report) return { status: "missing" };
    if (delivery.status !== "pending" && delivery.status !== "failed" && !delivery.canRetry) return { status: delivery.status };
    delivery.status = "sending";
    delivery.attempts += 1;
    delivery.lastAttemptAt = new Date().toISOString();
    const recipient = audience === "operator" ? "operator@example.test" : report.email ?? "";
    return {
      status: "claimed",
      email: {
        audience,
        recipient,
        payload: { from: "Parkdex <hello@example.test>", to: recipient ? [recipient] : [], subject: "Feedback", html: "<p>Feedback</p>", text: "Feedback" },
        idempotencyKey: `feedback-${id}-${audience}-v1`,
        initialStatus: "pending",
        initialError: null,
        attempts: delivery.attempts,
      },
    };
  }

  async markEmailDisabled(id: string, audience: EmailAudience) {
    const delivery = this.delivery(id, audience);
    if (delivery) delivery.status = "disabled";
  }

  async finishEmail(id: string, audience: EmailAudience, _lease: string, state: "sent" | "failed" | "ambiguous", error: string | null) {
    const delivery = this.delivery(id, audience);
    if (!delivery) return;
    delivery.status = state;
    delivery.lastError = error;
    delivery.canRetry = state !== "sent";
    if (state === "sent") delivery.sentAt = new Date().toISOString();
  }

  private delivery(id: string, audience: EmailAudience): EmailDeliveryView | undefined {
    return this.reports.get(id)?.emails.find((email) => email.audience === audience);
  }
}

export class MemoryAppConfigStore implements AppConfigStore {
  readonly rows = new Map<string, BuildConfigRecord>();

  async resolve(platform: AppConfigPlatform, build: number) {
    return [...this.rows.values()].filter((row) => row.platform === platform && (row.build === build || row.build === 0));
  }

  async list() {
    return [...this.rows.values()].sort((a, b) => a.platform.localeCompare(b.platform) || b.build - a.build);
  }

  async upsert(platform: AppConfigPlatform, build: number, input: BuildConfigInput) {
    const record = { platform, build, ...input, updatedAt: new Date().toISOString() };
    this.rows.set(`${platform}:${build}`, record);
    return record;
  }

  async remove(platform: AppConfigPlatform, build: number) {
    return this.rows.delete(`${platform}:${build}`);
  }
}

export class MemoryProposalStore implements ParkProposalStore {
  readonly rows = new Map<string, ParkProposalRecord>();

  async save(): Promise<never> { throw new Error("not supported"); }

  async list(status: ProposalStatus | null) {
    return [...this.rows.values()]
      .filter((row) => !status || row.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async updateStatus(id: string, status: ProposalStatus) {
    const row = this.rows.get(id);
    if (!row) return null;
    row.status = status;
    row.updatedAt = new Date().toISOString();
    return structuredClone(row);
  }
}

function delivery(audience: EmailAudience, status: EmailDeliveryView["status"], hoursAgo: number): EmailDeliveryView {
  const at = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
  return {
    audience,
    status,
    attempts: status === "pending" ? 0 : 1,
    lastAttemptAt: status === "pending" ? null : at,
    sentAt: status === "sent" ? at : null,
    providerMessageId: null,
    lastError: status === "failed" ? "Email provider rejected the message (HTTP 422)." : null,
    canRetry: status === "failed" || status === "pending",
    requiresConfirmation: false,
  };
}

const SAMPLE_SHOT = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="640" viewBox="0 0 360 640"><rect width="360" height="640" fill="#fff8ec"/><rect x="24" y="80" width="312" height="300" rx="24" fill="#9fd8ff" stroke="#14231c" stroke-width="4"/><circle cx="180" cy="230" r="26" fill="#ff5a1f" stroke="#14231c" stroke-width="4"/><rect x="24" y="410" width="312" height="70" rx="18" fill="#ffc93c" stroke="#14231c" stroke-width="4"/><text x="180" y="453" font-family="sans-serif" font-size="22" font-weight="700" text-anchor="middle" fill="#14231c">Collect visit</text></svg>`;

/** Fictional sample rows so the dashboard can be explored without a database. */
export function demoDependencies(): DashboardDependencies {
  const feedback = new MemoryFeedbackStore();
  const samples: Array<[FeedbackStatus, OperatorFeedbackRecord["kind"], string, string | null, number, boolean]> = [
    ["new", "bug", "The map froze after I zoomed out past the harbour. Had to close the app to get it moving again.", "Beacon Hill Park", 2, true],
    ["new", "idea", "Could parks show which entrance is closest to the bus stop? I walked the long way round twice.", "Mount Douglas Park", 5, false],
    ["new", "general", "Love Kip. My kids race to collect every badge on the weekend.", null, 9, false],
    ["reviewing", "bug", "Badge photo stayed blurry after the visit was collected on my Pixel.", "Cattle Point", 26, true],
    ["reviewing", "idea", "A dark map style for evening walks would be lovely.", null, 50, false],
    ["planned", "idea", "Let me favourite parks so they show up first on the list.", "Thetis Lake", 80, false],
    ["planned", "bug", "Offline download stopped at 80 percent on a slow connection.", null, 120, false],
    ["closed", "general", "Thanks for adding Saanich parks!", "Cuthbert Holmes Park", 200, false],
  ];
  samples.forEach(([status, kind, message, parkName, hoursAgo, screenshot], index) => {
    const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    const contact = index % 2 === 0;
    feedback.reports.set(id, {
      id,
      submissionId: id,
      kind,
      message,
      email: contact ? `player${index + 1}@example.test` : null,
      contact,
      context: { version: "1.4.0", build: String(40 + index), platform: index % 3 === 0 ? "android" : "web", screen: parkName ? "park" : "map", parkId: parkName ? `park-${index}` : null, parkName },
      createdAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
      status,
      hasScreenshot: screenshot,
      screenshot: screenshot ? { contentType: "image/svg+xml", size: SAMPLE_SHOT.length } : null,
      emails: [delivery("operator", index === 1 ? "failed" : "sent", hoursAgo), ...(contact ? [delivery("receipt", "sent", hoursAgo)] : [])],
    });
    if (screenshot) feedback.attachments.set(id, { contentType: "image/svg+xml", size: SAMPLE_SHOT.length, base64: btoa(SAMPLE_SHOT) });
  });

  const builds = new MemoryAppConfigStore();
  void builds.upsert("android", 0, { label: "Default", contentChannel: null, flags: { rankProgression: true }, minimumBuild: 30, latestBuild: 44, notes: "Applies to every Android build without its own row." });
  void builds.upsert("android", 44, { label: "1.4 closed test", contentChannel: "staging", flags: { parkProposals: true }, minimumBuild: null, latestBuild: null, notes: "" });
  void builds.upsert("web", 0, { label: "", contentChannel: null, flags: {}, minimumBuild: null, latestBuild: null, notes: "" });

  const proposals = new MemoryProposalStore();
  const proposalSamples: Array<[string, string, ProposalStatus, [number, number], boolean]> = [
    ["Swan Lake Nature Sanctuary", "Boardwalk loop with heron nests. Main gate on Swan Lake Road.", "new", [-123.3726, 48.4655], true],
    ["Gonzales Beach", "Small beach park, stairs from Crescent Road.", "new", [-123.3299, 48.4126], false],
    ["Playfair Park", "", "reviewing", [-123.3361, 48.4598], true],
    ["Haro Woods", "Trails connect to Cadboro Bay.", "accepted", [-123.3044, 48.4686], false],
  ];
  proposalSamples.forEach(([name, note, status, point, outline], index) => {
    const id = `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    const createdAt = new Date(Date.now() - (index + 1) * 20 * 3_600_000).toISOString();
    const [lng, lat] = point;
    proposals.rows.set(id, {
      id,
      name,
      note,
      point,
      outline: outline ? [[lng - 0.004, lat + 0.002], [lng + 0.003, lat + 0.003], [lng + 0.004, lat - 0.002], [lng - 0.001, lat - 0.004], [lng - 0.005, lat - 0.001]] : null,
      context: { platform: "android", version: "1.4.0", build: "44" },
      status,
      createdAt,
      updatedAt: createdAt,
    });
  });

  return { feedbackStore: () => feedback, appConfigStore: () => builds, proposalStore: () => proposals };
}
