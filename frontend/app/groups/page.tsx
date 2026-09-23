import type { Metadata } from "next";
import { ParkdexPage } from "../_components/parkdex-page";

export const metadata: Metadata = {
  title: "Groups · Parkdex",
  description: "Organize your Parkdex places into groups.",
  alternates: { canonical: "/groups" },
  openGraph: { url: "/groups" },
};

export default ParkdexPage;
