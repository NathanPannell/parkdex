// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PlaceVisitorDetails as VisitorDetailsRecord } from "@/lib/visitor-details";
import { PlaceVisitorDetails } from "./place-visitor-details";

afterEach(cleanup);

const sparseRecord: VisitorDetailsRecord = {
  schemaVersion: "1.0.0",
  scope: { kind: "park", matchedName: null, parentName: null, matchMethod: "exact_name" },
  source: {
    primaryUrl: null,
    authority: null,
    kind: "directory",
    geographicSourceUrl: null,
    retrievedAt: null,
    status: "partial",
  },
  overview: null,
  areaHectares: null,
  activities: null,
  facilities: null,
  access: { directions: null, address: null, transportNotes: null, entryPoints: null },
  trails: null,
  maps: null,
  mapNotes: null,
  rules: { pets: null, cycling: null, campfires: null, other: null },
  accessibility: { summary: null, features: null },
  operations: { hours: null, seasons: null, notes: null },
  camping: { summary: null, reservationRequired: null, bookingUrl: null, reservationNotes: null, fees: null },
  contacts: null,
  background: { history: null, conservation: null, culturalContext: null, wildlife: null },
  officialUpdatesUrl: null,
};

function richRecord(): VisitorDetailsRecord {
  return {
    ...sparseRecord,
    scope: { kind: "park", matchedName: "Goldstream Park", parentName: null, matchMethod: "reviewed_name" },
    source: {
      primaryUrl: "https://bcparks.ca/goldstream/",
      authority: "BC Parks",
      kind: "visitor_page",
      geographicSourceUrl: "https://bcparks.ca/goldstream/",
      retrievedAt: "2026-09-24T04:00:00Z",
      status: "extracted",
    },
    overview: "Goldstream protects an old-growth forest near Victoria. The park is known for seasonal salmon runs and waterfalls.\n\nVisitors can explore a network of trails beside the river.",
    areaHectares: 712.5,
    activities: [{ name: "Cycling", details: "Cycling is prohibited on this trail, including the lower river section." }],
    facilities: [
      { name: "Washrooms", details: "Facilities close outside the operating season.", availability: "seasonal" },
      { name: "Boat launch", details: "No boat launch is provided here.", availability: "unavailable" },
      { name: "Parking", details: "Check current site notices.", availability: "unspecified" },
      { name: "Picnic area", details: "Near the main day-use area.", availability: "available" },
    ],
    access: {
      directions: "Follow Highway 1 to the park entrance.",
      address: "Trans-Canada Highway, Goldstream, BC",
      transportNotes: "Regional transit stops nearby; confirm the schedule before travel.",
      entryPoints: [{ name: "Main entrance", latitude: 48.48123, longitude: -123.5521 }],
    },
    trails: [{ name: "Creekside Trail", description: "A short trail with river access.", lengthKm: 0, elevationGainM: 0, difficulty: "Easy", mapUrl: "https://bcparks.ca/goldstream/trails/" }],
    maps: [{ title: "Park map", url: "https://bcparks.ca/goldstream/map.pdf", kind: "park" }],
    mapNotes: "Trail conditions can change after heavy rain.",
    rules: {
      pets: "Dogs must remain on leash in day-use areas.",
      cycling: "Cycling is not permitted on the Creekside Trail.",
      campfires: "Campfires are prohibited during fire bans.",
      other: [{ name: "Wildlife viewing", details: "Keep a respectful distance from wildlife." }],
    },
    accessibility: {
      summary: "An accessibility guide is available at https://bcparks.ca/goldstream/accessibility.pdf.",
      features: [{ name: "Accessible washroom", details: "At the main day-use area." }],
    },
    operations: { hours: "Day-use area is open from dawn to dusk.", seasons: "Some services operate seasonally.", notes: "Check notices before leaving.", },
    camping: {
      summary: "No campground is listed in this park record.",
      reservationRequired: false,
      bookingUrl: "https://camping.example.test/goldstream",
      reservationNotes: "Reservations are not required for day use.",
      fees: "Day-use parking fee may apply.",
    },
    contacts: [{
      name: "Goldstream Park office",
      role: "Park information",
      phone: "+1 (250) 555-0123",
      email: "parks@example.ca",
      url: "https://bcparks.ca/contact/",
    }],
    background: {
      history: "The park was established to protect the river valley.",
      conservation: "Old-growth forest is protected within the park.",
      culturalContext: "This place is within the traditional territory of local First Nations.",
      wildlife: "Salmon return to the river in autumn.",
    },
    officialUpdatesUrl: "https://bcparks.ca/goldstream/notices/",
  };
}

describe("PlaceVisitorDetails", () => {
  it("shows every accepted public field in useful native disclosures with source context", () => {
    const details = richRecord();
    render(<PlaceVisitorDetails details={details} leadOverview="A short curated introduction." />);

    expect(screen.getByRole("heading", { name: "Plan your visit" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Official visitor information/ }).getAttribute("href")).toBe("https://bcparks.ca/goldstream/");
    expect(screen.getByText("Source checked Sep 24, 2026")).toBeTruthy();
    expect(screen.getByText(/Information applies to Goldstream Park/)).toBeTruthy();
    expect(screen.queryByText("Geographic source")).toBeNull();

    for (const label of ["More about this place", "Getting here", "Activities", "Facilities", "Trails and maps", "Hours and seasons", "Rules", "Camping", "Accessibility", "Contacts", "History and nature"]) {
      const summary = [...document.querySelectorAll("summary")].find((candidate) => candidate.textContent?.trim() === label)!;
      expect(summary.tagName).toBe("SUMMARY");
      expect(summary.tabIndex).toBe(0);
      fireEvent.click(summary);
    }

    expect(screen.getByText(/Goldstream protects an old-growth forest/)).toBeTruthy();
    expect(screen.getByText("Trans-Canada Highway, Goldstream, BC")).toBeTruthy();
    expect(screen.getByText("Regional transit stops nearby; confirm the schedule before travel.")).toBeTruthy();
    expect(screen.getByText("48.48123, -123.5521")).toBeTruthy();
    expect(screen.getByText("Cycling is prohibited on this trail, including the lower river section.")).toBeTruthy();
    expect(screen.getByText("Availability: seasonal")).toBeTruthy();
    expect(screen.getByText("Availability: unavailable")).toBeTruthy();
    expect(screen.getByText("Availability: Not specified")).toBeTruthy();
    expect(screen.getByText("Availability: available")).toBeTruthy();
    expect(screen.getByText("0 km")).toBeTruthy();
    expect(screen.getByText("0 m")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Trail map" }).getAttribute("href")).toBe("https://bcparks.ca/goldstream/trails/");
    expect(screen.getByRole("link", { name: "Park map" }).getAttribute("href")).toBe("https://bcparks.ca/goldstream/map.pdf");
    expect(screen.getByRole("link", { name: "https://bcparks.ca/goldstream/accessibility.pdf" }).getAttribute("href")).toBe("https://bcparks.ca/goldstream/accessibility.pdf");
    expect(screen.getByText("Not required")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Visit booking page" }).getAttribute("href")).toBe("https://camping.example.test/goldstream");
    expect(screen.getByRole("link", { name: "+1 (250) 555-0123" }).getAttribute("href")).toBe("tel:+12505550123");
    expect(screen.getByRole("link", { name: "parks@example.ca" }).getAttribute("href")).toBe("mailto:parks%40example.ca");
    expect(screen.queryByText("Community-wide details may be outside the place pin.")).toBeNull();
    expect(screen.getAllByText("Source: BC Parks")).toHaveLength(1);
  });

  it("keeps community-scoped records distinct from the exact place pin", () => {
    const details = {
      ...sparseRecord,
      scope: { kind: "community" as const, matchedName: "Port Hardy", parentName: null, matchMethod: "reviewed_name" },
      source: { ...sparseRecord.source, authority: "District of Port Hardy", retrievedAt: "2026-09-24T00:30:00+02:00" },
      facilities: [{ name: "Public washroom", details: null, availability: "unspecified" as const }],
    };
    render(<PlaceVisitorDetails details={details} />);

    expect(screen.getByText(/Information applies to Port Hardy/).textContent).toContain("Community-wide details may be outside the place pin.");
    const summary = screen.getByText("Facilities", { exact: true }).closest("summary")!;
    fireEvent.click(summary);
    const section = summary.closest("details")!;
    expect(within(section).getByText("Availability: Not specified")).toBeTruthy();
    expect(screen.getByText("Source checked Sep 23, 2026")).toBeTruthy();
  });

  it("labels island-scoped information without implying a single access point", () => {
    const details = {
      ...sparseRecord,
      scope: { kind: "island" as const, matchedName: "Memory Island", parentName: null, matchMethod: "reviewed_name" },
      access: { ...sparseRecord.access, transportNotes: "Boat access is required." },
    };
    render(<PlaceVisitorDetails details={details} />);

    expect(screen.getByText(/Information applies to Memory Island/).textContent).toContain("Information covers the island.");
    const summary = screen.getByText("Getting here", { exact: true }).closest("summary")!;
    fireEvent.click(summary);
    expect(within(summary.closest("details")!).getByText("Boat access is required.")).toBeTruthy();
  });

  it("omits unknown sections, keeps the verified visitor fallback, and never promotes shared sources to visitor pages", () => {
    const details = {
      ...sparseRecord,
      source: { ...sparseRecord.source, primaryUrl: "https://data.example.test/shared", authority: "Shared dataset", kind: "shared_dataset" as const },
    };
    render(<PlaceVisitorDetails
      details={details}
      visitorFallback={{ url: "https://parks.example.test/visitor", title: "Park guide", authority: "Parks Office", verifiedAt: "2026-09-01", evidenceUrl: "https://parks.example.test/evidence" }}
    />);

    expect(screen.getByRole("link", { name: /Official visitor information/ }).getAttribute("href")).toBe("https://parks.example.test/visitor");
    expect(screen.getByRole("link", { name: "Source: Shared dataset" }).getAttribute("href")).toBe("https://data.example.test/shared");
    for (const label of ["Getting here", "Activities", "Facilities", "Trails and maps", "Hours and seasons", "Rules", "Camping", "Accessibility", "Contacts", "History and nature"]) {
      expect(screen.queryByText(label, { exact: true })).toBeNull();
    }
  });

  it("shows an unavailable note and keeps unsafe links as text", () => {
    const unsafe = {
      ...sparseRecord,
      maps: [{ title: "Unsafe map", url: "javascript:alert(1)", kind: "park" as const }],
      contacts: [{ name: "Desk", role: null, phone: "javascript:alert(1)", email: "desk@example.ca?subject=hello", url: "javascript:alert(1)" }],
    };
    render(<PlaceVisitorDetails details={unsafe} />);

    expect(screen.getByText("Official visitor information is not available for this place yet.")).toBeTruthy();
    const mapsSummary = screen.getByText("Trails and maps", { exact: true }).closest("summary")!;
    fireEvent.click(mapsSummary);
    expect(screen.getByText("Unsafe map").closest("a")).toBeNull();
    const contactsSummary = screen.getByText("Contacts", { exact: true }).closest("summary")!;
    fireEvent.click(contactsSummary);
    expect(screen.getAllByText("javascript:alert(1)").every((node) => node.closest("a") === null)).toBe(true);
    expect(screen.getByText("desk@example.ca?subject=hello").closest("a")).toBeNull();
  });
});
