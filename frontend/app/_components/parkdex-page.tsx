import { ParkdexApp } from "@/components/every-park-app";
import { manualClaimEnabledForApi } from "@/lib/manual-claim-config";

export function ParkdexPage() {
  const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
  return <ParkdexApp
    apiBaseUrl={apiBaseUrl}
    googleAuthAllowed={process.env.PARKDEX_ANDROID_BUILD !== "1"}
    automaticLocationAllowed={process.env.PARKDEX_ANDROID_BUILD === "1"}
    manualClaimEnabled={manualClaimEnabledForApi(apiBaseUrl, process.env.NEXT_PUBLIC_MANUAL_CLAIM_ENABLED)}
  />;
}
