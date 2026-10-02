import { isFeatureEnabled } from "../appConfig";

/** Friends ship dark behind the remote `friends` flag. Local dev shows them for testing. */
export function friendsEnabled(): boolean {
  return isFeatureEnabled("friends") || import.meta.env.DEV;
}
