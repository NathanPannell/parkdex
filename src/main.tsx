import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/figtree";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import "./screens.css";
import { App } from "./App";
import { initAppConfig, startAppConfigCheckIns } from "./lib/appConfig";
import { prewarmMapStartup } from "./lib/mapStartup";
import { startOverTheAirUpdates } from "./lib/ota";
import { startWebApp } from "./lib/webApp";

prewarmMapStartup();
// Web only: hold Chrome's install prompt for Settings and go full screen on the first tap.
startWebApp();

// Apply this build's saved remote configuration before anything reads content or flags.
// A downloaded web bundle is switched to here, before the first render, so nothing reloads later.
void Promise.allSettled([initAppConfig(), startOverTheAirUpdates()]).finally(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  startAppConfigCheckIns();
});
