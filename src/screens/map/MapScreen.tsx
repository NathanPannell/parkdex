import type { Map as MLMap } from "maplibre-gl";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "../../components/Badge";
import { ContentSyncStatus } from "../../components/ContentSyncStatus";
import { ContentGate } from "../../components/ContentGate";
import { Icon } from "../../components/Icon";
import { Kip } from "../../components/Kip";
import { RollingNumber } from "../../components/Motion";
import { parkContaining, useBoundaries } from "../../lib/boundaries";
import { burst } from "../../lib/confetti";
import { buzz, sfx } from "../../lib/feedback";
import { estimateTrip, formatTrip } from "../../lib/drive";
import { arcPath, arrivalPoint, distanceKm, isUsableGpsAccuracy, ringBounds, type LngLat } from "../../lib/geo";
import { badgeTotal, isLive, mapParks, RARITY } from "../../lib/parks";
import { UNAVAILABLE_ELIGIBILITY, getCollectionRankProgress, getParkRarityEligibility, getRarityProgress, isRankProgressionEnabled, type ParkRarityEligibility } from "../../lib/progression";
import { rarityLockMessage } from "../../lib/rarityUi";
import { readLastLocation, saveLastLocation } from "../../lib/lastLocation";
import { FIELD, isNative } from "../../lib/native";
import { useStore } from "../../lib/store";
import { useContent } from "../../lib/content/provider";
import { recordParkViewed } from "../../lib/interactions";
import { MapView } from "./MapView";
import { ProposePark } from "./ProposePark";
import { isFeatureEnabled } from "../../lib/appConfig";
import { ParkSheet } from "./ParkSheet";
import { ArrivalCard, TripPanel } from "./TripPanel";

const SHEET_PAD = { top: 80, bottom: 460, left: 40, right: 40 };
const TRIP_PAD = { top: 120, bottom: 300, left: 60, right: 60 };

// Close enough to show badges rather than dots when the map opens on the visitor.
const USER_ZOOM = 12.5;
// Without any known location, frame British Columbia rather than a placeholder town.
const BC_VIEW = { center: [-125.5, 53.8] as LngLat, zoom: 4.6 };
// Devices with real GPS never open on the demo starting point.
const TRACKS_REAL_LOCATION = FIELD || isNative;

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export function MapScreen() {
  const { state, dispatch } = useStore();
  const content = useContent();
  const mapRef = useRef<MLMap | null>(null);
  const bounds = useBoundaries();
  const [route, setRoute] = useState<LngLat[] | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [dismissedArrival, setDismissedArrival] = useState<string | null>(null);
  const [demoOpen, setDemoOpen] = useState(false);
  const [proposing, setProposing] = useState(false);
  const [selectedEntryPoint, setSelectedEntryPoint] = useState<"map" | "nearby" | "collection">("map");
  const tripStart = useRef<{ from: LngLat; total: number } | null>(null);
  const [initialView] = useState(() => {
    if (!TRACKS_REAL_LOCATION) return { center: state.user, zoom: 12 };
    const last = readLastLocation();
    return last ? { center: last, zoom: USER_ZOOM } : BC_VIEW;
  });

  const { user, claims, selectedId, tripId } = state;
  const parks = useMemo(() => mapParks(content?.parks ?? [], claims), [content?.parks, claims]);
  const visibleFc = useMemo(() => {
    if (!bounds) return undefined;
    const ids = new Set(parks.map((park) => park.id));
    return { ...bounds.fc, features: bounds.fc.features.filter((feature) => ids.has(feature.properties.id)) };
  }, [bounds, parks]);
  const selected = selectedId ? content?.parkById.get(selectedId) : undefined;
  const trip = tripId ? content?.parkById.get(tripId) : undefined;
  const rarityProgress = useMemo(() => getRarityProgress(claims, content?.parkById), [claims, content?.parkById]);
  const eligibilityFor = useCallback((park: (typeof parks)[number]): ParkRarityEligibility => {
    if (!state.progressReady) return UNAVAILABLE_ELIGIBILITY;
    return getParkRarityEligibility(park, rarityProgress, !!claims[park.id]);
  }, [claims, rarityProgress, state.progressReady]);
  const hasUsableGpsFix = state.locationError !== "denied" && isUsableGpsAccuracy(state.accuracy);
  const here = useMemo(() => parkContaining(user, parks, bounds?.byId, hasUsableGpsFix ? state.accuracy ?? 0 : 0), [user, parks, bounds, state.accuracy, hasUsableGpsFix]);
  const arrivedId = here && !claims[here.id] ? here.id : null;
  const showArrival = !!arrivedId && arrivedId !== dismissedArrival && !selected && !simulating;
  const claimedCount = Object.keys(claims).length;
  const rank = state.progressReady && isRankProgressionEnabled() ? getCollectionRankProgress(rarityProgress) : null;
  const rankLine = !rank?.rank ? "badges collected" : rank.next ? `${rank.rank.name} · ${rank.next.remaining} to rank up` : rank.rank.name;
  const totalBadges = content ? badgeTotal(content.liveParks, Object.keys(claims)) : 0;

  const nearby = useMemo(
    () =>
      parks.filter((p) => !claims[p.id])
        .map((p) => ({ p, trip: estimateTrip(user, p, content?.drive), eligibility: eligibilityFor(p) }))
        .sort((a, b) => Number(b.eligibility.eligible) - Number(a.eligibility.eligible) || a.trip.minutes - b.trip.minutes)
        .slice(0, 8),
    [parks, content?.drive, user, claims, eligibilityFor],
  );

  // Arrival moment: celebrate once each time the visitor crosses into an unclaimed park.
  const lastArrived = useRef<string | null>(null);
  useEffect(() => {
    if (state.screen === "splash") return;
    if (arrivedId && arrivedId !== lastArrived.current) {
      sfx.arrive();
      buzz([30, 60, 30]);
      burst({ x: 0.5, y: 0.55 }, 0.7);
      const b = bounds?.byId.get(arrivedId);
      // Keep the boundary above the arrival card and Kip, which take more of a short screen.
      const height = mapRef.current?.getContainer().clientHeight ?? 844;
      if (b) mapRef.current?.fitBounds(ringBounds(b), { padding: { top: 110, bottom: Math.min(500, height * 0.6), left: 50, right: 50 }, maxZoom: 15, duration: 1400 });
      setRoute(null);
    }
    lastArrived.current = arrivedId;
  }, [arrivedId, state.screen]);

  // Jump to the visitor the first time a real GPS fix lands, wherever they are.
  const hadFix = useRef(false);
  useEffect(() => {
    if (!hasUsableGpsFix) return;
    saveLastLocation(user);
    if (hadFix.current) return;
    hadFix.current = true;
    mapRef.current?.flyTo({ center: user, zoom: USER_ZOOM, duration: 1200, padding: { top: 0, bottom: 200, left: 0, right: 0 } });
  }, [hasUsableGpsFix, state.accuracy, user]);

  // The "focus" request comes from the collection screen or deep links.
  useEffect(() => {
    if (state.focusId && content) {
      select(state.focusId, "collection");
      dispatch({ type: "focus", id: null });
    }
  }, [state.focusId, content]);

  function select(id: string | null, entryPoint: "map" | "nearby" | "collection" = "map") {
    if (simulating) return;
    if (id && !content?.parkById.has(id)) return;
    dispatch({ type: "select", id });
    if (!id) return;
    setSelectedEntryPoint(entryPoint);
    sfx.pop();
    buzz(10);
    const p = content?.parkById.get(id);
    if (!p) return;
    if (content) void recordParkViewed({ parkId: p.id, entryPoint, contentReleaseId: content.releaseId }).catch(() => {});
    mapRef.current?.flyTo({ center: [p.lng, p.lat], zoom: Math.max(mapRef.current.getZoom(), 11.5), padding: SHEET_PAD, duration: 900, essential: true });
  }

  function startTrip() {
    if (!selected) return;
    const tripEstimate = estimateTrip(user, selected, content?.drive);
    if (tripEstimate.mode === "unknown") {
      tripStart.current = null;
      setRoute(null);
      sfx.pop();
    } else {
      if (!bounds) return;
      const target = arrivalPoint(bounds.byId.get(selected.id)!, user);
      const path = arcPath(user, target);
      tripStart.current = { from: user, total: tripEstimate.km };
      setRoute(path);
      sfx.whoosh();
      const lngs = path.map((p) => p[0]);
      const lats = path.map((p) => p[1]);
      mapRef.current?.fitBounds(
        [
          [Math.min(...lngs), Math.min(...lats)],
          [Math.max(...lngs), Math.max(...lats)],
        ],
        { padding: TRIP_PAD, duration: 1200, maxZoom: 14 },
      );
    }
    buzz(15);
    dispatch({ type: "trip", id: selected.id });
    dispatch({ type: "select", id: null });
  }

  function endTrip() {
    dispatch({ type: "trip", id: null });
    setRoute(null);
    tripStart.current = null;
  }

  function simulate() {
    if (!route || simulating) return;
    setSimulating(true);
    const km = tripStart.current?.total ?? 5;
    const duration = Math.min(5200, 2600 + km * 90);
    const t0 = performance.now();
    let lastStep = -1;
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / duration);
      const idx = Math.round(ease(t) * (route.length - 1));
      if (idx !== lastStep) {
        lastStep = idx;
        dispatch({ type: "move", user: route[idx], accuracy: null });
      }
      if (t < 1) requestAnimationFrame(step);
      else setSimulating(false);
    };
    requestAnimationFrame(step);
  }

  function teleportNearest() {
    if (!bounds) return;
    const target = nearby[0]?.p;
    if (!target) return;
    const point = arrivalPoint(bounds.byId.get(target.id)!, user);
    setDemoOpen(false);
    dispatch({ type: "select", id: null });
    dispatch({ type: "trip", id: target.id });
    dispatch({ type: "move", user: point, accuracy: null });
  }

  function checkIn(id: string) {
    const park = content?.parkById.get(id);
    if (!park || !state.progressReady || claims[id] || !eligibilityFor(park).eligible) return;
    dispatch({ type: "trip", id });
    dispatch({ type: "select", id: null });
    dispatch({ type: "go", screen: "camera" });
    sfx.tap();
  }

  function recenter() {
    sfx.tap();
    mapRef.current?.flyTo({ center: user, zoom: 12.5, duration: 900, padding: { top: 0, bottom: 200, left: 0, right: 0 } });
  }

  const remaining = trip ? estimateTrip(user, trip, content?.drive) : null;

  const mapView = (
    <MapView
      mapRef={mapRef}
      user={user}
      showUser={!TRACKS_REAL_LOCATION || hasUsableGpsFix}
      initialView={initialView}
      fc={content ? visibleFc : undefined}
      parks={content ? parks : []}
      claims={claims}
      rarityProgress={rarityProgress}
      progressReady={state.progressReady}
      selectedId={content ? selectedId : null}
      tripId={content ? tripId : null}
      arrivedId={content ? arrivedId : null}
      route={content ? route : null}
      onSelect={content && !proposing ? select : () => {}}
      visible={state.screen === "map"}
    />
  );

  if (!content) {
    return (
      <div className="screen map-screen">
        {mapView}
        <ContentGate overMap />
      </div>
    );
  }

  if (proposing) {
    return (
      <div className="screen map-screen">
        {mapView}
        <ProposePark mapRef={mapRef} user={user} onClose={() => setProposing(false)} />
      </div>
    );
  }

  return (
    <div className="screen map-screen">
      {mapView}

      <div className="map-top">
        <motion.button
          className="counter card"
          onClick={() => dispatch({ type: "go", screen: "collection" })}
          initial={{ y: -80 }}
          animate={{ y: 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 22, delay: 0.3 }}
          whileTap={{ scale: 0.95 }}
        >
          <span className="counter__kip">
            <Kip pose="avatar" size={48} />
          </span>
          <span className="counter__text">
            <strong>
              <RollingNumber value={claimedCount} />
              <em> / {totalBadges.toLocaleString("en-CA")}</em>
            </strong>
            <span>{rankLine}</span>
          </span>
        </motion.button>
        <motion.div className="map-top__tools" initial={{ y: -80 }} animate={{ y: 0 }} transition={{ type: "spring", stiffness: 300, damping: 22, delay: 0.4 }}>
          <button className="tool card" onClick={() => dispatch({ type: "feedback", open: true })} aria-label="Send feedback" title="Send feedback">
            <Icon name="feedback" size={22} />
          </button>
          {isFeatureEnabled("parkProposals") && (
            <button
              className="tool card"
              onClick={() => {
                sfx.tap();
                select(null);
                setProposing(true);
              }}
              aria-label="Propose a park"
              title="Propose a park"
            >
              <Icon name="pinPlus" size={22} />
            </button>
          )}
          {!FIELD && (
            <button className="tool card" onClick={() => setDemoOpen((v) => !v)} aria-label="Demo controls">
              <Icon name="wand" size={20} />
            </button>
          )}
        </motion.div>
        <ContentSyncStatus />
      </div>

      <AnimatePresence>
        {demoOpen && (
          <motion.div
            className="demo card"
            initial={{ opacity: 0, scale: 0.6, y: -20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.7, y: -10 }}
            transition={{ type: "spring", stiffness: 500, damping: 30 }}
          >
            <span className="eyebrow">Demo controls</span>
            <button onClick={teleportNearest}>
              <Icon name="sparkle" size={18} /> Teleport into nearest park
            </button>
            <button
              onClick={() => {
                setDemoOpen(false);
                endTrip();
                dispatch({ type: "move", user: [-123.3656, 48.4284], accuracy: null });
                recenter();
              }}
            >
              <Icon name="locate" size={18} /> Back to downtown Victoria
            </button>
            <button
              onClick={() => {
                if (confirm("Reset the mockup and replay onboarding?")) dispatch({ type: "reset" });
              }}
            >
              <Icon name="refresh" size={18} /> Reset and replay onboarding
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <motion.button
        className="locate card"
        onClick={recenter}
        aria-label="Center on me"
        animate={{ y: selected ? 80 : trip ? -250 : showArrival ? 80 : 0, opacity: selected || showArrival ? 0 : 1 }}
        transition={{ type: "spring", stiffness: 300, damping: 28 }}
      >
        <Icon name="locate" size={22} />
      </motion.button>

      <AnimatePresence>
        {!selected && !trip && !showArrival && (
          <motion.div
            className="nearby"
            initial={{ y: 200, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 200, opacity: 0 }}
            transition={{ type: "spring", stiffness: 280, damping: 28 }}
          >
            <div className="nearby__head">
              <span className="eyebrow">Badges near you</span>
            </div>
            <div className="nearby__rail scroll">
              {nearby.map(({ p, trip: est, eligibility }, i) => (
                <motion.button
                  key={p.id}
                  className={`nearby__card card ${eligibility.eligible ? "" : "nearby__card--locked"}`}
                  onClick={() => select(p.id, "nearby")}
                  aria-label={`${p.name}, ${RARITY[p.rarity].label}. ${eligibility.eligible ? formatTrip(est) : rarityLockMessage(eligibility)}${isLive(p) ? "" : ". Badge art coming soon"}`}
                  initial={{ y: 60, opacity: 0, rotate: 4 }}
                  animate={{ y: 0, opacity: 1, rotate: 0 }}
                  transition={{ type: "spring", stiffness: 380, damping: 22, delay: 0.1 + i * 0.05 }}
                  whileTap={{ scale: 0.94, rotate: -2 }}
                >
                  <span className="nearby__badge">
                    <Badge park={p} size={64} showName={false} state="preview" />
                  </span>
                  <span className="nearby__name">{p.short}</span>
                  <span className="nearby__meta">
                    <i style={{ background: RARITY[p.rarity].ink }} />
                    {eligibility.eligible ? formatTrip(est) : eligibility.reason === "unavailable" ? "Checking" : "Locked"}
                  </span>
                </motion.button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {trip && !showArrival && !selected && (
          <TripPanel
            key="trip"
            park={trip}
            remaining={here?.id === trip.id ? { mode: "walk", km: 0, minutes: 0 } : remaining!}
            totalKm={tripStart.current?.total ?? remaining!.km}
            simulating={simulating}
            onSimulate={simulate}
            onEnd={endTrip}
            onOpen={() => select(trip.id)}
            entryPoint={selectedEntryPoint}
            contentReleaseId={content.releaseId}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showArrival && here && (
          <ArrivalCard
            key={here.id}
            park={here}
            eligibility={eligibilityFor(here)}
            artComingSoon={!isLive(here)}
            onCheckIn={() => checkIn(here.id)}
            onShowRequirements={() => select(here.id, "map")}
            onDismiss={() => setDismissedArrival(here.id)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {selected && (
          <>
            <motion.div key="scrim" className="sheet-scrim sheet-scrim--light" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => select(null)} />
            <ParkSheet
              key={selected.id}
              park={selected}
              entryPoint={selectedEntryPoint}
              user={user}
              claim={claims[selected.id]}
              inside={here?.id === selected.id}
              eligibility={eligibilityFor(selected)}
              progressReady={state.progressReady}
              onClose={() => select(null)}
              onGo={startTrip}
              onCheckIn={() => checkIn(selected.id)}
              onFeedback={() => dispatch({ type: "feedback", open: true, parkId: selected.id })}
              onViewCase={() => {
                dispatch({ type: "select", id: null });
                dispatch({ type: "go", screen: "collection" });
              }}
            />
          </>
        )}
      </AnimatePresence>

      {!bounds && <div className="map-loading">Loading parks…</div>}
      {FIELD && !hasUsableGpsFix && !state.locationError && <div className="finding card">Finding you…</div>}
    </div>
  );
}
