import type { Metadata } from "next";
import { ParkdexPage } from "../_components/parkdex-page";

export const metadata: Metadata = {
  title: "My Dex · Parkdex",
  description: "View your Parkdex account and collected places.",
  alternates: { canonical: "/account" },
  openGraph: { url: "/account" },
};

export default ParkdexPage;
