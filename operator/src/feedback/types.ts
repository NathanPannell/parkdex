export type ReportStatus = "new" | "reviewing" | "planned" | "closed";
export type ReportKind = "bug" | "idea" | "general";
export type EmailAudience = "operator" | "receipt";

export type EmailDelivery = {
  audience: EmailAudience;
  status: string;
  attempts: number;
  lastAttemptAt: string | null;
  sentAt: string | null;
  lastError: string | null;
  canRetry: boolean;
  requiresConfirmation: boolean;
};

export type FeedbackReport = {
  id: string;
  kind: ReportKind;
  message: string;
  email: string | null;
  contact: boolean;
  context: { version?: string; build?: string; platform?: string; screen?: string; parkId?: string | null; parkName?: string | null };
  createdAt: string;
  status: ReportStatus;
  hasScreenshot: boolean;
  emails: EmailDelivery[];
};

export type FeedbackPage = { reports: FeedbackReport[]; nextCursor: string | null };
