import { useDashboard } from "../shell/DashboardContext";
import { Tabs } from "../ui";
import { ArchivePage } from "./ArchivePage";
import "./feedback.css";
import { FeedbackBoard } from "./FeedbackBoard";
import { OtherDatabaseNote } from "./OtherDatabaseNote";

const PAGES = [
  { id: "/feedback", label: "Board", icon: "inbox" as const, href: "/feedback" },
  { id: "/feedback/archive", label: "Archive", icon: "clock" as const, href: "/feedback/archive" },
];

/**
 * Feedback section: the board at /feedback (/feedback/review?id=<report> is the link in operator
 * emails) and the archive of cleared done reports at /feedback/archive.
 */
export function FeedbackSection({ path }: { path: string }) {
  const { environment, switchDatabase } = useDashboard();
  const archive = path === "/feedback/archive" || path.startsWith("/feedback/archive/");
  return (
    <>
      <div className={`section-tabs feedback-tabs${archive ? "" : " feedback-tabs--board"}`}>
        <Tabs label="Feedback pages" value={archive ? "/feedback/archive" : "/feedback"} items={PAGES} />
      </div>
      <OtherDatabaseNote key={environment} onSwitch={switchDatabase} />
      {archive ? <ArchivePage /> : <FeedbackBoard />}
    </>
  );
}
