import "@fontsource-variable/fraunces";
import "@fontsource-variable/nunito-sans";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = { metadataBase: new URL("https://parkdex.app"), title: "Parkdex · Vancouver Island field guide", description: "Collect the parks and major islands of Vancouver Island on a playful interactive map.", applicationName: "Parkdex", alternates: { canonical: "/" }, openGraph: { title: "Parkdex · Vancouver Island field guide", description: "Collect Vancouver Island parks and major islands in your Parkdex.", url: "https://parkdex.app", siteName: "Parkdex", type: "website" } };
export const viewport: Viewport = { themeColor: "#173d32", width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
