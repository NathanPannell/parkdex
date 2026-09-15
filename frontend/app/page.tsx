import { ParkdexApp } from "@/components/every-park-app";

export default function Home() {
  // Google OAuth/App Links are intentionally web-only until the native auth flow is scoped.
  return <ParkdexApp
    apiBaseUrl={process.env.NEXT_PUBLIC_API_BASE_URL ?? ""}
    googleAuthAllowed={process.env.PARKDEX_ANDROID_BUILD !== "1"}
  />;
}
