import type { DashboardDependencies } from "./api.js";
import { demoApp } from "./app/memory.js";
import { demoFeedback } from "./feedback/memory.js";
import { demoParks } from "./parks/memory.js";

/**
 * Fictional in-memory data for the local demo server (vite.config.ts) when no DATABASE_URL is
 * set. Each section supplies its own sample stores.
 */
export function demoDependencies(): DashboardDependencies {
  return { ...demoFeedback(), ...demoParks(), ...demoApp() };
}
