import type { Metadata } from "next";
import { ParkdexPage } from "../_components/parkdex-page";

export const metadata: Metadata = {
  title: "Places · Parkdex",
  description: "Browse the Parkdex collection of Vancouver Island parks and islands.",
  alternates: { canonical: "/places" },
  openGraph: { url: "/places" },
};

export default ParkdexPage;
