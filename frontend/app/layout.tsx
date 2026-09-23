import "@fontsource-variable/fraunces";
import "@fontsource-variable/nunito-sans";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Metadata, Viewport } from "next";
import { NativeRuntime } from "@/components/native-runtime";
import "./globals.css";
import "./impression-tokens.css";
import "./sealed-impressions.css";
import "./field-guide.css";
import "./postcard-shelf.css";
import "./field-guide-onboarding.css";
import "./map-panel-layout.css";

const appPublicUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://web.parkdex.app";

export const metadata: Metadata = {
  metadataBase: new URL(appPublicUrl),
  title: "Parkdex · Vancouver Island field guide",
  description: "Collect the parks and major islands of Vancouver Island on a playful interactive map.",
  applicationName: "Parkdex",
  alternates: { canonical: "/" },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "16x16 24x24 32x32 48x48 64x64" },
      { url: "/favicon-16x16.png", type: "image/png", sizes: "16x16" },
      { url: "/favicon-32x32.png", type: "image/png", sizes: "32x32" },
      { url: "/favicon-48x48.png", type: "image/png", sizes: "48x48" },
      { url: "/favicon-64x64.png", type: "image/png", sizes: "64x64" },
    ],
    apple: [{ url: "/apple-touch-icon.png", type: "image/png", sizes: "180x180" }],
  },
  manifest: "/manifest.webmanifest",
  openGraph: {
    title: "Parkdex · Vancouver Island field guide",
    description: "Collect Vancouver Island parks and major islands in your Parkdex.",
    url: appPublicUrl,
    siteName: "Parkdex",
    type: "website",
  },
  other: {
    "parkdex-release": process.env.NEXT_PUBLIC_RELEASE_VERSION ?? "v0.0.000",
    "parkdex-commit": process.env.NEXT_PUBLIC_COMMIT_SHA ?? "local",
  },
};
export const viewport: Viewport = { themeColor: "#173d32", width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><NativeRuntime enabled={process.env.PARKDEX_ANDROID_BUILD === "1"}>{children}</NativeRuntime></body></html>;
}
