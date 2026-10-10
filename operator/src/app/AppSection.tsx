import { SectionTabs } from "../shell/SectionTabs";
import "./app.css";
import { BuildsPage } from "./BuildsPage";
import { UpdatesPage } from "./UpdatesPage";

/** App and updates section: /app/builds (production only) and /app/updates. */
export function AppSection({ path }: { path: string }) {
  return (
    <>
      <SectionTabs section="app" path={path} />
      {path.startsWith("/app/updates") ? <UpdatesPage /> : <BuildsPage />}
    </>
  );
}
