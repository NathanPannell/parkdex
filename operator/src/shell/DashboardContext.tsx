import { createContext, useContext } from "react";
import type { Health } from "../api";

export type Dashboard = {
  /** /api/health, or null while it loads or when the API is unreachable. */
  health: Health | null;
  /** The data the current page shows: "production", "staging" or a label such as "local demo". */
  environment: string;
  /** Switches the Production/Staging toggle and reloads, so every request follows the cookie. */
  switchDatabase(target: "production" | "staging" | string): void;
};

export const DashboardContext = createContext<Dashboard>({ health: null, environment: "", switchDatabase: () => undefined });

/** Shell state a section may need: which database is showing, and a way to switch it. */
export function useDashboard(): Dashboard {
  return useContext(DashboardContext);
}
