import { useDashboard } from "../shell/DashboardContext";
import "./feedback.css";
import { FeedbackBoard } from "./FeedbackBoard";
import { OtherDatabaseNote } from "./OtherDatabaseNote";

/**
 * Feedback section: /feedback and /feedback/review?id=<report>, the link in operator emails.
 * Coming next (#135): a Done column, "Clear done" that archives reports, and a searchable Archive.
 */
export function FeedbackSection(_props: { path: string }) {
  const { environment, switchDatabase } = useDashboard();
  return (
    <>
      <OtherDatabaseNote key={environment} onSwitch={switchDatabase} />
      <FeedbackBoard />
    </>
  );
}
