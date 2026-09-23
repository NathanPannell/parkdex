import type { Metadata } from "next";
import { ParkdexPage } from "../_components/parkdex-page";

export const metadata: Metadata = {
  title: "Settings · Parkdex",
  description: "Manage your Parkdex account and preferences.",
  alternates: { canonical: "/settings" },
  openGraph: { url: "/settings" },
};

export default ParkdexPage;
