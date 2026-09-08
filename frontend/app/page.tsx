import { ParkdexApp } from "@/components/every-park-app";

export default function Home() {
  return <ParkdexApp apiBaseUrl={process.env.NEXT_PUBLIC_API_BASE_URL ?? ""} />;
}
