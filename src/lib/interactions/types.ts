export type InteractionEntryPoint = "map" | "nearby" | "collection";
export type InteractionProvider = "google_maps" | "apple_maps";
export type InteractionTravelMode = "driving" | "walking" | "bicycling" | "transit";
export type InteractionEnvironment = "staging" | "main" | "preview";

export type InteractionBase = {
  eventId: string;
  installationId: string;
  sessionId: string;
  occurredAt: string;
  schemaVersion: 1;
  appVersion: string;
  appBuild: string;
  contentReleaseId: string;
  environment: InteractionEnvironment;
  parkId: string;
};

export type ParkViewedEvent = InteractionBase & {
  type: "park_viewed";
  entryPoint: InteractionEntryPoint;
};

export type DirectionsOpenedEvent = InteractionBase & {
  type: "directions_opened";
  entryPoint: InteractionEntryPoint;
  provider: InteractionProvider;
  travelMode: InteractionTravelMode;
};

export type ParkClaimedEvent = InteractionBase & {
  type: "park_claimed";
  claimId: string;
  claimStatus: "first" | "repeat";
};

export type InteractionEvent = ParkViewedEvent | DirectionsOpenedEvent | ParkClaimedEvent;
