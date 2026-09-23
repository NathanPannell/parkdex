import { ParkdexApp } from "@/components/every-park-app";

export function ParkdexPage() {
  return <ParkdexApp
    apiBaseUrl={process.env.NEXT_PUBLIC_API_BASE_URL ?? ""}
    googleAuthAllowed={process.env.PARKDEX_ANDROID_BUILD !== "1"}
    automaticLocationAllowed={process.env.PARKDEX_ANDROID_BUILD === "1"}
  />;
}
