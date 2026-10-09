import type { ArchivedFeedbackRecord, FeedbackArchiveStore } from "../../../worker/feedbackArchive.js";
import type { AttachmentRecord, ClaimEmailResult, EmailDeliveryView, FeedbackCursor, FeedbackStore, OperatorFeedbackRecord } from "../../../worker/store.js";
import type { EmailAudience, FeedbackStatus } from "../../../worker/validation.js";
import type { FeedbackDependencies } from "./routes.js";

/** In-memory feedback store for tests and the local demo server. Never used by a deployment. */

const newestFirst = (a: { at: string; id: string }, b: { at: string; id: string }) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id);
const before = (item: { at: string; id: string }, cursor: FeedbackCursor | null) => !cursor || item.at < cursor.createdAt || (item.at === cursor.createdAt && item.id < cursor.id);

export class MemoryFeedbackStore implements FeedbackStore, FeedbackArchiveStore {
  readonly reports = new Map<string, OperatorFeedbackRecord>();
  readonly attachments = new Map<string, AttachmentRecord>();
  /** Report id to the time it was archived. */
  readonly archived = new Map<string, string>();

  async saveFeedback(): Promise<never> { throw new Error("not supported"); }
  async findBySubmissionId() { return null; }

  private view(report: OperatorFeedbackRecord): ArchivedFeedbackRecord {
    return { ...structuredClone(report), archivedAt: this.archived.get(report.id) ?? null };
  }

  async getReport(id: string) {
    const report = this.reports.get(id);
    return report ? this.view(report) : null;
  }

  async listReports(limit: number, status: FeedbackStatus | null, cursor: FeedbackCursor | null) {
    return [...this.reports.values()]
      .filter((report) => !status || report.status === status)
      .map((report) => ({ report, at: report.createdAt, id: report.id }))
      .sort(newestFirst)
      .filter((item) => before(item, cursor))
      .slice(0, limit)
      .map(({ report }) => this.view(report));
  }

  async listBoard(limit: number, status: FeedbackStatus | null, cursor: FeedbackCursor | null) {
    return (await this.listReports(Number.MAX_SAFE_INTEGER, status, cursor)).filter((report) => !report.archivedAt).slice(0, limit);
  }

  private archiveMatches(search: string | null) {
    const text = search?.toLowerCase() ?? "";
    return [...this.reports.values()]
      .filter((report) => this.archived.has(report.id))
      .filter((report) => !text || report.id === text || [report.message, report.context.parkName, report.email, report.context.version, report.context.build]
        .some((value) => typeof value === "string" && value.toLowerCase().includes(text)));
  }

  async listArchive(limit: number, search: string | null, cursor: FeedbackCursor | null) {
    return this.archiveMatches(search)
      .map((report) => ({ report, at: this.archived.get(report.id)!, id: report.id }))
      .sort(newestFirst)
      .filter((item) => before(item, cursor))
      .slice(0, limit)
      .map(({ report }) => this.view(report));
  }

  async countArchive(search: string | null) {
    return this.archiveMatches(search).length;
  }

  async archiveDone(limit: number) {
    const now = new Date().toISOString();
    const done = [...this.reports.values()].filter((report) => report.status === "closed" && !this.archived.has(report.id)).slice(0, limit);
    for (const report of done) this.archived.set(report.id, now);
    return done.map((report) => report.id);
  }

  async restore(ids: string[]) {
    return ids.filter((id) => this.archived.delete(id));
  }

  async liveCounts() {
    const counts: Record<string, number> = {};
    for (const report of this.reports.values()) if (!this.archived.has(report.id)) counts[report.status] = (counts[report.status] ?? 0) + 1;
    return counts;
  }

  async getAttachment(id: string) {
    return this.attachments.get(id) ?? null;
  }

  async updateStatus(id: string, status: FeedbackStatus) {
    const report = this.reports.get(id);
    if (!report) return null;
    report.status = status;
    return this.view(report);
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
    if (delivery) {
      delivery.status = "disabled";
      delivery.canRetry = false;
      delivery.lastError = null;
    }
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

type Sample = [FeedbackStatus, OperatorFeedbackRecord["kind"], string, string | null, number, boolean, number | null];

/** Fictional sample reports so the board and the archive can be explored without a database. */
export function demoFeedback(): FeedbackDependencies {
  const feedback = new MemoryFeedbackStore();
  // [status, kind, message, park, hours ago, screenshot, archived days ago]
  const samples: Sample[] = [
    ["new", "bug", "The map froze after I zoomed out past the harbour. Had to close the app to get it moving again.", "Beacon Hill Park", 2, true, null],
    ["new", "idea", "Could parks show which entrance is closest to the bus stop? I walked the long way round twice.", "Mount Douglas Park", 5, false, null],
    ["new", "general", "Love Kip. My kids race to plant a flag in every park on the weekend.", null, 9, false, null],
    ["reviewing", "bug", "My flag photo stayed blurry after the visit was saved on my Pixel.", "Cattle Point", 26, true, null],
    ["reviewing", "idea", "A dark map style for evening walks would be lovely.", null, 50, false, null],
    ["planned", "idea", "Let me favourite parks so they show up first on the list.", "Thetis Lake", 80, false, null],
    ["planned", "bug", "Offline download stopped at 80 percent on a slow connection.", null, 120, false, null],
    ["closed", "general", "Thanks for adding Saanich parks!", "Cuthbert Holmes Park", 200, false, null],
    ["closed", "bug", "Someone else's flag showed on Gonzales Beach after I took it back. Fixed after a restart.", "Gonzales Beach Park", 150, false, null],
    ["closed", "idea", "Show the walking time, not just the distance.", null, 300, false, null],
    ["closed", "bug", "The founder name ran off the edge of the park card.", "Summit Park", 600, true, 3],
    ["closed", "general", "Great update, the leaderboard is fun.", null, 900, false, 12],
    ["closed", "bug", "Photo check said my flag was a screenshot. It was not.", "Moss Rock Park", 1400, false, 40],
    ["closed", "idea", "Badges for visiting every park in a region.", null, 2000, false, 85],
  ];
  samples.forEach(([status, kind, message, parkName, hoursAgo, screenshot, archivedDaysAgo], index) => {
    const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    const contact = index % 2 === 0;
    const build = 14 - (index % 4);
    feedback.reports.set(id, {
      id,
      submissionId: id,
      kind,
      message,
      email: contact ? `player${index + 1}@example.test` : null,
      contact,
      context: {
        // Over-the-air bundles report "<native build> bundle <version>" (docs/ota-updates.md).
        version: index % 3 === 1 ? `${build} bundle 0b68799-2f554cf6` : "1.4.0",
        build: String(build),
        platform: index % 3 === 0 ? "android" : "web",
        screen: parkName ? "park" : "map",
        parkId: parkName ? `park-${index}` : null,
        parkName,
      },
      createdAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
      status,
      hasScreenshot: screenshot,
      screenshot: screenshot ? { contentType: "image/svg+xml", size: SAMPLE_SHOT.length } : null,
      emails: [delivery("operator", index === 1 ? "failed" : "sent", hoursAgo), ...(contact ? [delivery("receipt", "sent", hoursAgo)] : [])],
    });
    if (archivedDaysAgo !== null) feedback.archived.set(id, new Date(Date.now() - archivedDaysAgo * 86_400_000).toISOString());
    if (screenshot) feedback.attachments.set(id, { contentType: "image/svg+xml", size: SAMPLE_SHOT.length, base64: btoa(SAMPLE_SHOT) });
  });
  return {
    feedbackStore: () => feedback,
    feedbackArchive: () => feedback,
    // The demo has one set of sample rows, so the other database reports fixed counts.
    feedbackCounts: async () => ({ new: 6, reviewing: 2, closed: 9 }),
  };
}
