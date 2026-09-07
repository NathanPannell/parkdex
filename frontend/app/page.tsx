import { EveryParkApp } from "@/components/every-park-app";

export default function Home() {
  return <EveryParkApp apiBaseUrl={process.env.NEXT_PUBLIC_API_BASE_URL ?? ""} />;
}
