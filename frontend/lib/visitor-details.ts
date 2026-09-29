export type PlaceVisitorDetails = {
  schemaVersion: "1.0.0";
  scope: {
    kind: "park" | "site" | "island" | "community" | "dataset";
    matchedName: string | null;
    parentName: string | null;
    matchMethod: string | null;
  };
  source: {
    primaryUrl: string | null;
    authority: string | null;
    kind: "visitor_page" | "official_park_api" | "geographic_record" | "shared_dataset" | "directory";
    geographicSourceUrl: string | null;
    retrievedAt: string | null;
    status: "pending" | "extracted" | "partial" | "no_park_specific_content" | "fetch_failed" | "blocked_by_policy" | "needs_review";
  };
  overview: string | null;
  areaHectares: number | null;
  activities: Array<{ name: string; details: string | null }> | null;
  facilities: Array<{
    name: string;
    details: string | null;
    availability: "available" | "unavailable" | "seasonal" | "conditional" | "unspecified" | null;
  }> | null;
  access: {
    directions: string | null;
    address: string | null;
    transportNotes: string | null;
    entryPoints: Array<{ name: string | null; latitude: number; longitude: number }> | null;
  };
  trails: Array<{
    name: string;
    description: string | null;
    lengthKm: number | null;
    elevationGainM: number | null;
    difficulty: string | null;
    mapUrl: string | null;
  }> | null;
  maps: Array<{
    title: string | null;
    url: string | null;
    kind: "park" | "trail" | "directions" | "other" | null;
  }> | null;
  mapNotes: string | null;
  rules: {
    pets: string | null;
    cycling: string | null;
    campfires: string | null;
    other: Array<{ name: string; details: string | null }> | null;
  };
  accessibility: {
    summary: string | null;
    features: Array<{ name: string; details: string | null }> | null;
  };
  operations: {
    hours: string | null;
    seasons: string | null;
    notes: string | null;
  };
  camping: {
    summary: string | null;
    reservationRequired: boolean | null;
    bookingUrl: string | null;
    reservationNotes: string | null;
    fees: string | null;
  };
  contacts: Array<{
    name: string | null;
    role: string | null;
    phone: string | null;
    email: string | null;
    url: string | null;
  }> | null;
  background: {
    history: string | null;
    conservation: string | null;
    culturalContext: string | null;
    wildlife: string | null;
  };
  officialUpdatesUrl: string | null;
};

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isNonEmptyString(value);
}

function isNullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === "boolean";
}

function isNullableNumber(value: unknown, minimum = -Infinity, exclusiveMinimum = false): value is number | null {
  if (value === null) return true;
  return typeof value === "number" && Number.isFinite(value)
    && (exclusiveMinimum ? value > minimum : value >= minimum);
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function isHttpUrl(value: unknown): value is string {
  if (!isNonEmptyString(value) || value !== value.trim() || /[\u0000-\u0020\u007f]/u.test(value)) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "https:" || parsed.protocol === "http:")
      && Boolean(parsed.hostname)
      && parsed.username === ""
      && parsed.password === "";
  } catch {
    return false;
  }
}

function isNullableHttpUrl(value: unknown): value is string | null {
  return value === null || isHttpUrl(value);
}

function isNameDetails(value: unknown): value is { name: string; details: string | null } {
  return isRecord(value) && isNonEmptyString(value.name) && isNullableString(value.details);
}

function isArrayOf(value: unknown, predicate: (entry: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(predicate);
}

function isAccess(value: unknown): value is PlaceVisitorDetails["access"] {
  if (!isRecord(value)
    || !isNullableString(value.directions)
    || !isNullableString(value.address)
    || !isNullableString(value.transportNotes)) return false;
  if (value.entryPoints === null) return true;
  return isArrayOf(value.entryPoints, (entry) => isRecord(entry)
    && isNullableString(entry.name)
    && typeof entry.latitude === "number" && Number.isFinite(entry.latitude) && entry.latitude >= -90 && entry.latitude <= 90
    && typeof entry.longitude === "number" && Number.isFinite(entry.longitude) && entry.longitude >= -180 && entry.longitude <= 180);
}

function isTrail(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.name)
    && isNullableString(value.description)
    && isNullableNumber(value.lengthKm, 0)
    && isNullableNumber(value.elevationGainM, 0)
    && isNullableString(value.difficulty)
    && isNullableHttpUrl(value.mapUrl);
}

function isMap(value: unknown): boolean {
  return isRecord(value)
    && isNullableString(value.title)
    && isNullableHttpUrl(value.url)
    && (value.kind === null || isOneOf(value.kind, ["park", "trail", "directions", "other"] as const));
}

function isRules(value: unknown): value is PlaceVisitorDetails["rules"] {
  return isRecord(value)
    && isNullableString(value.pets)
    && isNullableString(value.cycling)
    && isNullableString(value.campfires)
    && (value.other === null || isArrayOf(value.other, isNameDetails));
}

function isAccessibility(value: unknown): value is PlaceVisitorDetails["accessibility"] {
  return isRecord(value)
    && isNullableString(value.summary)
    && (value.features === null || isArrayOf(value.features, isNameDetails));
}

function isOperations(value: unknown): value is PlaceVisitorDetails["operations"] {
  return isRecord(value)
    && isNullableString(value.hours)
    && isNullableString(value.seasons)
    && isNullableString(value.notes);
}

function isCamping(value: unknown): value is PlaceVisitorDetails["camping"] {
  return isRecord(value)
    && isNullableString(value.summary)
    && isNullableBoolean(value.reservationRequired)
    && isNullableHttpUrl(value.bookingUrl)
    && isNullableString(value.reservationNotes)
    && isNullableString(value.fees);
}

function isContact(value: unknown): boolean {
  return isRecord(value)
    && isNullableString(value.name)
    && isNullableString(value.role)
    && isNullableString(value.phone)
    && isNullableString(value.email)
    && isNullableHttpUrl(value.url);
}

function isBackground(value: unknown): value is PlaceVisitorDetails["background"] {
  return isRecord(value)
    && isNullableString(value.history)
    && isNullableString(value.conservation)
    && isNullableString(value.culturalContext)
    && isNullableString(value.wildlife);
}

/**
 * Validates the public API shape and copies only public schema fields. Invalid metadata is
 * dropped by the place-cache caller while the enclosing place and canonical boundary remain usable.
 */
export function parsePlaceVisitorDetails(value: unknown): PlaceVisitorDetails | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)
    || value.schemaVersion !== "1.0.0"
    || !isRecord(value.scope)
    || !isOneOf(value.scope.kind, ["park", "site", "island", "community", "dataset"] as const)
    || !isNullableString(value.scope.matchedName)
    || !isNullableString(value.scope.parentName)
    || !isNullableString(value.scope.matchMethod)
    || !isRecord(value.source)
    || !isNullableHttpUrl(value.source.primaryUrl)
    || !isNullableString(value.source.authority)
    || !isOneOf(value.source.kind, ["visitor_page", "official_park_api", "geographic_record", "shared_dataset", "directory"] as const)
    || !isNullableHttpUrl(value.source.geographicSourceUrl)
    || !isNullableString(value.source.retrievedAt)
    || !isOneOf(value.source.status, ["pending", "extracted", "partial", "no_park_specific_content", "fetch_failed", "blocked_by_policy", "needs_review"] as const)
    || !isNullableString(value.overview)
    || !isNullableNumber(value.areaHectares, 0, true)
    || !(value.activities === null || isArrayOf(value.activities, isNameDetails))
    || !(value.facilities === null || isArrayOf(value.facilities, (entry) => isRecord(entry)
      && isNonEmptyString(entry.name)
      && isNullableString(entry.details)
      && (entry.availability === null || isOneOf(entry.availability, ["available", "unavailable", "seasonal", "conditional", "unspecified"] as const))))
    || !isAccess(value.access)
    || !(value.trails === null || isArrayOf(value.trails, isTrail))
    || !(value.maps === null || isArrayOf(value.maps, isMap))
    || !isNullableString(value.mapNotes)
    || !isRules(value.rules)
    || !isAccessibility(value.accessibility)
    || !isOperations(value.operations)
    || !isCamping(value.camping)
    || !(value.contacts === null || isArrayOf(value.contacts, isContact))
    || !isBackground(value.background)
    || !isNullableHttpUrl(value.officialUpdatesUrl)) {
    return undefined;
  }

  const activities = value.activities as PlaceVisitorDetails["activities"];
  const facilities = value.facilities as PlaceVisitorDetails["facilities"];
  const access = value.access as PlaceVisitorDetails["access"];
  const trails = value.trails as PlaceVisitorDetails["trails"];
  const maps = value.maps as PlaceVisitorDetails["maps"];
  const rules = value.rules as PlaceVisitorDetails["rules"];
  const accessibility = value.accessibility as PlaceVisitorDetails["accessibility"];
  const operations = value.operations as PlaceVisitorDetails["operations"];
  const camping = value.camping as PlaceVisitorDetails["camping"];
  const contacts = value.contacts as PlaceVisitorDetails["contacts"];
  const background = value.background as PlaceVisitorDetails["background"];

  // Rebuild the object to exclude fields reserved for ingestion review or source archives.
  return {
    schemaVersion: "1.0.0",
    scope: {
      kind: value.scope.kind,
      matchedName: value.scope.matchedName,
      parentName: value.scope.parentName,
      matchMethod: value.scope.matchMethod,
    },
    source: {
      primaryUrl: value.source.primaryUrl,
      authority: value.source.authority,
      kind: value.source.kind,
      geographicSourceUrl: value.source.geographicSourceUrl,
      retrievedAt: value.source.retrievedAt,
      status: value.source.status,
    },
    overview: value.overview,
    areaHectares: value.areaHectares,
    activities: activities === null ? null : activities.map(({ name, details }) => ({ name, details })),
    facilities: facilities === null ? null : facilities.map(({ name, details, availability }) => ({ name, details, availability })),
    access: {
      directions: access.directions,
      address: access.address,
      transportNotes: access.transportNotes,
      entryPoints: access.entryPoints === null ? null : access.entryPoints.map(({ name, latitude, longitude }) => ({ name, latitude, longitude })),
    },
    trails: trails === null ? null : trails.map(({ name, description, lengthKm, elevationGainM, difficulty, mapUrl }) => ({
      name, description, lengthKm, elevationGainM, difficulty, mapUrl,
    })),
    maps: maps === null ? null : maps.map(({ title, url, kind }) => ({ title, url, kind })),
    mapNotes: value.mapNotes,
    rules: {
      pets: rules.pets,
      cycling: rules.cycling,
      campfires: rules.campfires,
      other: rules.other === null ? null : rules.other.map(({ name, details }) => ({ name, details })),
    },
    accessibility: {
      summary: accessibility.summary,
      features: accessibility.features === null ? null : accessibility.features.map(({ name, details }) => ({ name, details })),
    },
    operations: { hours: operations.hours, seasons: operations.seasons, notes: operations.notes },
    camping: {
      summary: camping.summary,
      reservationRequired: camping.reservationRequired,
      bookingUrl: camping.bookingUrl,
      reservationNotes: camping.reservationNotes,
      fees: camping.fees,
    },
    contacts: contacts === null ? null : contacts.map(({ name, role, phone, email, url }) => ({ name, role, phone, email, url })),
    background: {
      history: background.history,
      conservation: background.conservation,
      culturalContext: background.culturalContext,
      wildlife: background.wildlife,
    },
    officialUpdatesUrl: value.officialUpdatesUrl,
  };
}
