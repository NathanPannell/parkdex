import { ParkdexApp } from "@/components/every-park-app";
import { manualClaimEnabledForApi } from "@/lib/manual-claim-config";

export default function Home() {
  const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
  // Google OAuth/App Links are intentionally web-only until the native auth flow is scoped.
  return <ParkdexApp
    apiBaseUrl={apiBaseUrl}
    googleAuthAllowed={process.env.PARKDEX_ANDROID_BUILD !== "1"}
    automaticLocationAllowed={process.env.PARKDEX_ANDROID_BUILD === "1"}
    manualClaimEnabled={manualClaimEnabledForApi(apiBaseUrl, process.env.NEXT_PUBLIC_MANUAL_CLAIM_ENABLED)}
  />;
}
