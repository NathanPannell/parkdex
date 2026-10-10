import { Kip } from "./Kip";
import { useContentRuntime, useContentStatus } from "../lib/content/provider";
import { contentGateView } from "./contentGateState";

export function ContentGate({ overMap = false }: { overMap?: boolean }) {
  const status = useContentStatus();
  const runtime = useContentRuntime();
  const view = contentGateView(status);

  return (
    <div className={`screen map-screen map-loading map-loading--content${overMap ? " map-loading--over-map" : ""}`} role="status" aria-live="polite">
      <div className="map-loading__card card">
        <Kip pose={view.showError ? "think" : "walk"} size={72} />
        <strong>{view.title}</strong>
        {view.message && <span>{view.message}</span>}
        {view.showRetry && <button className="btn btn--sm btn--paper" onClick={() => void runtime.retry()}>Try again</button>}
      </div>
    </div>
  );
}
