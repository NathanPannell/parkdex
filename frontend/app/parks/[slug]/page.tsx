import type { Metadata } from "next";
import { notFound } from "next/navigation";
import parkRoutes from "@/lib/park-routes.json";
import { ParkdexPage } from "../../_components/parkdex-page";

type ParkPageProps = { params: Promise<{ slug: string }> };

const parksBySlug = new Map(parkRoutes.map((park) => [park.slug, park]));

export const dynamicParams = false;

export function generateStaticParams() {
  return parkRoutes.map(({ slug }) => ({ slug }));
}

export async function generateMetadata({ params }: ParkPageProps): Promise<Metadata> {
  const { slug } = await params;
  const park = parksBySlug.get(slug);
  if (!park) notFound();
  const path = `/parks/${park.slug}`;
  return {
    title: `${park.name} · Parkdex`,
    description: park.description,
    alternates: { canonical: path },
    openGraph: { title: `${park.name} · Parkdex`, description: park.description, url: path },
  };
}

export default async function ParkPage({ params }: ParkPageProps) {
  const { slug } = await params;
  if (!parksBySlug.has(slug)) notFound();
  return <ParkdexPage />;
}
