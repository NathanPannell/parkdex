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

prewarmMapStartup();

// Apply this build's saved remote configuration before anything reads content or flags.
void initAppConfig().finally(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  startAppConfigCheckIns();
});
