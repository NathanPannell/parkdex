import type { Metadata } from "next";
import { ParkdexPage } from "../_components/parkdex-page";

export const metadata: Metadata = {
  title: "Badges · Parkdex",
  description: "See the badges earned on your Parkdex adventures.",
  alternates: { canonical: "/badges" },
  openGraph: { url: "/badges" },
};

export default ParkdexPage;
