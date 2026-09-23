import type { Metadata } from "next";
import { ParkdexPage } from "../_components/parkdex-page";

export const metadata: Metadata = {
  title: "Map · Parkdex",
  description: "Explore parks and islands around Vancouver Island on the Parkdex map.",
  alternates: { canonical: "/map" },
  openGraph: { url: "/map" },
};

export default ParkdexPage;
