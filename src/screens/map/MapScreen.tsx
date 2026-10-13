import type { Map as MLMap } from "maplibre-gl";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ContentSyncStatus } from "../../components/ContentSyncStatus";
import { ContentGate } from "../../components/ContentGate";
import { Icon } from "../../components/Icon";
import { Kip } from "../../components/Kip";
import { RollingNumber } from "../../components/Motion";
import { Flag } from "../../components/Flag";
import { insidePark, parkContaining, useBoundaries } from "../../lib/boundaries";
import { burst } from "../../lib/confetti";
import { buzz, sfx } from "../../lib/feedback";
import { estimateTrip } from "../../lib/drive";
import { arcPath, arrivalPoint, distanceKm, isUsableGpsAccuracy, ringBounds, type LngLat } from "../../lib/geo";
import { useGame } from "../../lib/game/GameProvider";
import { useVisit } from "../../lib/game/useVisit";
import { useCrew } from "../../lib/game/CrewProvider";
import { flagAgeDays, flagAgeMs } from "../../lib/game/flag";
import { nextVisitStep } from "../../lib/game/visit";
import { readLastLocation, saveLastLocation } from "../../lib/lastLocation";
import { startingMapView, USER_ZOOM } from "../../lib/provinces";
import { FIELD, isNative } from "../../lib/native";
import { DEMO_TOOLS } from "../../lib/demo";
import { KIP_TIP_IDS, requestKipTip } from "../../lib/kipTips";
import { openDexOn } from "../../lib/dex/prefs";
import { useStore, type Screen } from "../../lib/store";
import { useContent, useContentRuntime, useContentStatus } from "../../lib/content/provider";
import { recordParkViewed } from "../../lib/interactions";
import { MapView, type MapLongPress } from "./MapView";
import { PressMenu } from "./PressMenu";
import { FoundPark } from "./FoundPark";
import { forgetSummaries } from "../../lib/parkSummary";
import { DownloadMaps } from "./DownloadMaps";
import { consumeDownloadMapsRequest, subscribeDownloadMapsRequest } from "../../lib/mapCells";
import { isFeatureEnabled } from "../../lib/appConfig";
import { ParkSheet } from "./ParkSheet";
import { NearbyPanel } from "./NearbyPanel";
import { NEARBY_LIST_KM, NEARBY_LIST_SIZE, nearestParks } from "../../lib/nearbyParks";
import { ArrivalCard, TripPanel } from "./TripPanel";

const SHEET_PAD = { top: 80, bottom: 460, left: 40, right: 40 };
// Below this zoom the map shows parks as dots (see tierOf in MapView).
const FAR_ZOOM = 10.5;
const TRIP_PAD = { top: 120, bottom: 300, left: 60, right: 60 };

// Devices with real GPS never open on the demo starting point.
const TRACKS_REAL_LOCATION = FIELD || isNative;

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export function MapScreen() {
  const { state, dispatch } = useStore();
  const content = useContent();
  const contentStatus = useContentStatus();
  const mapRef = useRef<MLMap | null>(null);
  const bounds = useBoundaries();
  const [route, setRoute] = useState<LngLat[] | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [dismissedArrival, setDismissedArrival] = useState<string | null>(null);
  const [demoOpen, setDemoOpen] = useState(false);
  const [demoTip, setDemoTip] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pressMenu, setPressMenu] = useState<MapLongPress | null>(null);
  // Truthy while founding; holds the park when it started from that park's sheet.
  const [founding, setFounding] = useState<{ parkId: string | null } | null>(null);
  const [downloadingMaps, setDownloadingMaps] = useState(false);
  const downloadReturn = useRef<Screen | null>(null);
  const downloadCamera = useRef<{
    center: LngLat;
    zoom: number;
    bearing: number;
    pitch: number;
    padding: { top: number; right: number; bottom: number; left: number };
  } | null>(null);
  const [selectedEntryPoint, setSelectedEntryPoint] = useState<"map" | "nearby" | "collection">("map");
  const tripStart = useRef<{ from: LngLat; total: number } | null>(null);
  // Without a location inside a province, frame the province nearest the last one, or BC.
  const [initialView] = useState(() => startingMapView(TRACKS_REAL_LOCATION, state.user, readLastLocation()));

  const game = useGame();
  const visit = useVisit();
  const crew = useCrew();
  const runtime = useContentRuntime();
  const { user, selectedId, tripId, located } = state;
  // Every park in the catalogue can carry a flag, with or without badge art.
  const parks = useMemo(() => content?.parks ?? [], [content?.parks]);
  const flags = game.flags?.byPark ?? null;
  // Flag ages are counted against the server's clock as of the last flag read.
  const flagsNow = useMemo(() => game.serverNow(), [game.flags]);
  const flagDays = useCallback((parkId: string) => {
    const flag = flags?.get(parkId);
    return flag ? flagAgeDays(flag.since, flagsNow) : 0;
  }, [flags, flagsNow]);
  const flagAge = useCallback((parkId: string) => {
    const flag = flags?.get(parkId);
    return flag ? flagAgeMs(flag.since, flagsNow) : 0;
  }, [flags, flagsNow]);
  const visibleFc = useMemo(() => {
    if (!bounds) return undefined;
    const ids = new Set(parks.map((park) => park.id));
    return { ...bounds.fc, features: bounds.fc.features.filter((feature) => ids.has(feature.properties.id)) };
  }, [bounds, parks]);
  const selected = selectedId ? content?.parkById.get(selectedId) : undefined;
  const trip = tripId ? content?.parkById.get(tripId) : undefined;
  const hasUsableGpsFix = state.locationError !== "denied" && isUsableGpsAccuracy(state.accuracy);
  const here = useMemo(() => parkContaining(user, parks, bounds?.byId, hasUsableGpsFix ? state.accuracy ?? 0 : 0), [user, parks, bounds, state.accuracy, hasUsableGpsFix]);
  const arrivedId = here ? here.id : null;
  const showArrival = !!arrivedId && arrivedId !== dismissedArrival && !selected && !simulating;
  const player = game.me?.player ?? null;
  // A score that went up since the last read floats a "+N" off the score chip.
  const lastScore = useRef<number | null>(null);
  const [scoreBump, setScoreBump] = useState<{ key: number; delta: number } | null>(null);
  useEffect(() => {
    const score = player ? game.me?.score ?? null : null;
    if (score === null) {
      lastScore.current = null;
      return;
    }
    if (lastScore.current !== null && score > lastScore.current) setScoreBump({ key: Date.now(), delta: score - lastScore.current });
    lastScore.current = score;
  }, [player, game.me?.score]);

  // Straight-line distance ranks every park, including ones without a drive estimate.
  const listItem = useCallback((p: (typeof parks)[number]) => ({ park: p, km: distanceKm(user, [p.lng, p.lat]), holder: visit.holderOf(p.id), days: flagDays(p.id), ageMs: flagAge(p.id) }), [user, visit.holderOf, flagDays, flagAge]);
  // "Parks near you" stays within NEARBY_LIST_KM of the player; search still covers every park.
  const nearby = useMemo(() => nearestParks(parks, user, { limit: NEARBY_LIST_SIZE, maxKm: NEARBY_LIST_KM }), [parks, user]);
  const nearbyItems = useMemo(() => nearby.map(({ p }) => listItem(p)), [nearby, listItem]);
  const searchItems = useMemo(() => parks.map(listItem), [parks, listItem]);

  // Arrival moment: celebrate once each time the visitor crosses into a park.
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
    const map = mapRef.current;
    if (!map) return;
    // The map already opened on the last known location; only move if the visitor is
    // somewhere else, so a cold start does not animate away from tiles already drawn.
    const center = map.getCenter();
    if (distanceKm([center.lng, center.lat], user) < 0.5 && Math.abs(map.getZoom() - USER_ZOOM) < 0.5) return;
    map.flyTo({ center: user, zoom: USER_ZOOM, duration: 1200, padding: { top: 0, bottom: 200, left: 0, right: 0 } });
  }, [hasUsableGpsFix, state.accuracy, user]);

  // The account screen can ask to open Download maps.
  useEffect(() => {
    const open = () => {
      const request = consumeDownloadMapsRequest();
      if (!request) return;
      downloadReturn.current = request.returnTo;
      const map = mapRef.current;
      if (map) {
        const center = map.getCenter();
        const padding = map.getPadding();
        const camera: NonNullable<typeof downloadCamera.current> = {
          center: [center.lng, center.lat],
          zoom: map.getZoom(),
          bearing: map.getBearing(),
          pitch: map.getPitch(),
          padding: {
            top: padding.top ?? 0,
            right: padding.right ?? 0,
            bottom: padding.bottom ?? 0,
            left: padding.left ?? 0,
          },
        };
        downloadCamera.current = camera;
        map.jumpTo({ center: camera.center, zoom: 6.8, bearing: camera.bearing, pitch: camera.pitch, padding: { top: 0, right: 0, bottom: 0, left: 0 } });
      }
      select(null);
      setFounding(null);
      setPressMenu(null);
      setDownloadingMaps(true);
    };
    open();
    return subscribeDownloadMapsRequest(open);
  }, []);

  // The map menu closes on a tap anywhere else or on Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest(".map-menu, .map-top__tools")) setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  const pendingFocus = useRef<string | null>(null);
  useEffect(() => {
    const id = pendingFocus.current;
    if (!id || !content?.parkById.has(id)) return;
    pendingFocus.current = null;
    dispatch({ type: "focus", id });
  }, [content?.parkById]);

  // The "focus" request comes from the collection screen or deep links.
  useEffect(() => {
    if (state.focusId && content) {
      // A park opened from elsewhere, such as after a visit, does not need the arrival card again.
      setDismissedArrival(state.focusId);
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
    const map = mapRef.current;
    const boundary = bounds?.byId.get(p.id);
    // From a zoomed-out view, frame the whole park instead of stopping at town level.
    if (map && boundary && map.getZoom() < FAR_ZOOM) {
      const height = map.getContainer().clientHeight;
      map.fitBounds(ringBounds(boundary), { padding: { ...SHEET_PAD, bottom: Math.min(SHEET_PAD.bottom, height * 0.55) }, maxZoom: 15, duration: 1100, essential: true });
    }
    else map?.flyTo({ center: [p.lng, p.lat], zoom: Math.max(map.getZoom(), 11.5), padding: SHEET_PAD, duration: 900, essential: true });
  }

  function startTrip() {
    if (!selected) return;
    const tripEstimate = estimateTrip(user, selected, content?.drive);
    if (tripEstimate.mode === "unknown") {
      tripStart.current = null;
      setRoute(null);
      sfx.pop();
      // No road route to draw, so frame the park itself for the trip panel.
      mapRef.current?.flyTo({ center: [selected.lng, selected.lat], zoom: Math.max(mapRef.current.getZoom(), 14), padding: TRIP_PAD, duration: 1100, essential: true });
    } else {
      if (!bounds) return;
      const target: LngLat = selected.trailheadLat != null && selected.trailheadLng != null
        ? [selected.trailheadLng, selected.trailheadLat]
        : arrivalPoint(bounds.byId.get(selected.id)!, user);
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
    if (!DEMO_TOOLS || !route || simulating) return;
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
    if (!DEMO_TOOLS || !bounds) return;
    const target = nearestParks(parks, user, { limit: 1 })[0]?.p;
    if (!target) return;
    const point = arrivalPoint(bounds.byId.get(target.id)!, user);
    setDemoOpen(false);
    dispatch({ type: "select", id: null });
    dispatch({ type: "trip", id: target.id });
    dispatch({ type: "move", user: point, accuracy: null });
  }

  // Checking in inside a boundary is now a flag visit: plant, take or visit. Older claim
  // screens stay in the app for history, but the check-in no longer routes into them.
  function checkIn(id: string) {
    if (!content?.parkById.get(id)) return;
    sfx.tap();
    visit.start(id);
  }

  // Founding needs an account and a handle, like planting a flag.
  function startFounding(parkId: string | null) {
    setMenuOpen(false);
    const open = () => {
      dispatch({ type: "select", id: null });
      setFounding({ parkId });
    };
    const step = nextVisitStep(visit.signedIn, game.me);
    if (step === "sign-in") {
      dispatch({ type: "select", id: null });
      dispatch({ type: "go", screen: "account" });
    } else if (step === "pick-handle") {
      game.openHandleSheet({ onDone: open });
    } else {
      open();
    }
  }

  function finishFounding(showParkId?: string) {
    setFounding(null);
    if (!showParkId) return;
    // A park that was new a moment ago may still be on its way in the content update.
    if (content?.parkById.has(showParkId)) dispatch({ type: "focus", id: showParkId });
    else pendingFocus.current = showParkId;
  }

  function openPressMenu(press: MapLongPress) {
    setMenuOpen(false);
    setDemoOpen(false);
    setPressMenu(press);
    buzz(20);
  }

  function recenter(center: LngLat = user) {
    sfx.tap();
    mapRef.current?.flyTo({ center, zoom: USER_ZOOM, duration: 900, padding: { top: 0, bottom: 200, left: 0, right: 0 } });
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
      flags={flags}
      flagsNow={flagsNow}
      selectedId={content ? selectedId : null}
      tripId={content ? tripId : null}
      arrivedId={content ? arrivedId : null}
      route={content ? route : null}
      onSelect={content && !founding && !downloadingMaps ? select : () => {}}
      onLongPress={content && !founding && !downloadingMaps && !selected && !simulating ? openPressMenu : undefined}
      visible={state.screen === "map"}
    />
  );

  if (!content) {
    // Parks load and download in the background over a live map. A card appears only
    // when there is nothing to show: offline with nothing saved, or an error.
    const blocked = contentStatus.phase === "offline" || (contentStatus.phase !== "starting" && !!contentStatus.error);
    return (
      <div className="screen map-screen">
        {mapView}
        {blocked && <ContentGate overMap />}
      </div>
    );
  }

  if (downloadingMaps) {
    return (
      <div className="screen map-screen">
        {mapView}
        <DownloadMaps
          mapRef={mapRef}
          user={user}
          hasFix={hasUsableGpsFix}
          onClose={() => {
            setDownloadingMaps(false);
            const camera = downloadCamera.current;
            downloadCamera.current = null;
            if (camera) mapRef.current?.jumpTo(camera);
            const returnTo = downloadReturn.current;
            downloadReturn.current = null;
            if (returnTo) dispatch({ type: "go", screen: returnTo });
          }}
        />
      </div>
    );
  }

  if (founding) {
    const target = founding.parkId ? content.parkById.get(founding.parkId) ?? null : null;
    return (
      <div className="screen map-screen">
        {mapView}
        <FoundPark
          mapRef={mapRef}
          park={target}
          boundary={target ? bounds?.byId.get(target.id) : undefined}
          user={user}
          hasFix={hasUsableGpsFix}
          onLocated={(fix) => {
            // Builds without live tracking still show the dot where the scan happened.
            if (!TRACKS_REAL_LOCATION) dispatch({ type: "move", user: fix.point, accuracy: fix.accuracy });
          }}
          onSignIn={() => {
            setFounding(null);
            dispatch({ type: "go", screen: "account" });
          }}
          onFounded={() => {
            // The new park, its founder and today's flag arrive through the normal refreshes.
            forgetSummaries();
            void runtime.retry().catch(() => {});
            void game.refresh();
            void game.refreshFlags();
          }}
          onClose={finishFounding}
        />
      </div>
    );
  }

  return (
    <div className="screen map-screen">
      {mapView}

      <div className="map-top">
        <motion.button
          className="counter card"
          onClick={() => {
            // The score opens My Dex on the flags that earn it (#174).
            openDexOn("flags");
            dispatch({ type: "go", screen: "parks" });
          }}
          initial={{ y: -80 }}
          animate={{ y: 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 22, delay: 0.3 }}
          whileTap={{ scale: 0.95 }}
          aria-label={player ? `@${player.handle}, ${game.me?.score ?? 0} points. Open your flags in My Dex` : "My Dex"}
        >
          <span className={player ? "counter__kip counter__kip--flag" : "counter__kip"}>
            {player ? <span className="score-chip__flag"><Flag seed={player.flagSeed} size={46} className="is-waving" /></span> : <Kip pose="avatar" size={48} />}
          </span>
          <span className="counter__text">
            {player && game.me ? (
              <>
                <strong>
                  <RollingNumber value={game.me.score} />
                  <em> {game.me.score === 1 ? "point" : "points"}</em>
                </strong>
                <span>@{player.handle} · {game.me.parks.length} {game.me.parks.length === 1 ? "park" : "parks"}</span>
              </>
            ) : (
              <>
                <strong>Plant your flag</strong>
                <span>{visit.signedIn ? (game.me ? "Pick a handle to start" : "Go to any park") : "Sign in to play"}</span>
              </>
            )}
          </span>
          <AnimatePresence>
            {scoreBump && (
              <motion.span
                key={scoreBump.key}
                className="score-chip__bump"
                initial={{ y: 6, opacity: 0, scale: 0.6 }}
                animate={{ y: -26, opacity: [0, 1, 1, 0], scale: 1 }}
                transition={{ duration: 1.6, times: [0, 0.15, 0.7, 1] }}
                onAnimationComplete={() => setScoreBump(null)}
              >
                +{scoreBump.delta}
              </motion.span>
            )}
          </AnimatePresence>
        </motion.button>
        <motion.div className="map-top__tools" initial={{ y: -80 }} animate={{ y: 0 }} transition={{ type: "spring", stiffness: 300, damping: 22, delay: 0.4 }}>
          <button
            className={`tool card ${menuOpen ? "tool--open" : ""}`}
            onClick={() => {
              sfx.tap();
              setDemoOpen(false);
              setPressMenu(null);
              setMenuOpen((open) => !open);
            }}
            aria-label="Menu"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title="Menu"
          >
            <Icon name={menuOpen ? "close" : "menu"} size={22} />
          </button>
        </motion.div>
        <ContentSyncStatus />
      </div>

      <AnimatePresence>
        {(game.flagsStatus === "offline" || game.flagsStatus === "error") && !selected && (
          <motion.button
            key="flags-note"
            className="flags-note card"
            onClick={() => void game.refreshFlags()}
            initial={{ y: -20, opacity: 0, x: "-50%" }}
            animate={{ y: 0, opacity: 1, x: "-50%" }}
            exit={{ y: -20, opacity: 0, x: "-50%" }}
            transition={{ type: "spring", stiffness: 420, damping: 28 }}
            whileTap={{ scale: 0.95, x: "-50%" }}
          >
            <Icon name="refresh" size={14} /> {game.flagsStatus === "offline" ? "Flags need a connection" : "Flags didn't load. Tap to retry"}
          </motion.button>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {menuOpen && (
          <motion.div
            className="map-menu card"
            role="menu"
            aria-label="Map menu"
            initial={{ opacity: 0, scale: 0.6, y: -20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.7, y: -10 }}
            transition={{ type: "spring", stiffness: 500, damping: 30 }}
          >
            <button role="menuitem" onClick={() => { setMenuOpen(false); dispatch({ type: "feedback", open: true }); }}>
              <Icon name="feedback" size={20} /> Send feedback
            </button>
            {isFeatureEnabled("parkProposals") && (
              <button role="menuitem" onClick={() => { select(null); startFounding(null); }}>
                <Icon name="flagPlus" size={20} /> Become a founder
              </button>
            )}
            {DEMO_TOOLS && (
              <button role="menuitem" onClick={() => { setMenuOpen(false); setDemoOpen(true); }}>
                <Icon name="wand" size={20} /> Demo controls
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {pressMenu && (
          <PressMenu
            key={`${pressMenu.point.x},${pressMenu.point.y}`}
            mapRef={mapRef}
            point={pressMenu.point}
            onClose={() => setPressMenu(null)}
            onFeedback={() => {
              setPressMenu(null);
              dispatch({ type: "feedback", open: true });
            }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {DEMO_TOOLS && demoOpen && (
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
            {located && (
              <button
                onClick={() => {
                  setDemoOpen(false);
                  endTrip();
                  dispatch({ type: "move", user: located, accuracy: null });
                  recenter(located);
                }}
              >
                <Icon name="locate" size={18} /> Back to my location
              </button>
            )}
            <button
              onClick={() => {
                if (confirm("Reset the mockup and replay onboarding?")) dispatch({ type: "reset" });
              }}
            >
              <Icon name="refresh" size={18} /> Reset and replay onboarding
            </button>
            <button
              onClick={() => {
                setDemoOpen(false);
                const id = KIP_TIP_IDS[demoTip % KIP_TIP_IDS.length];
                setDemoTip((n) => n + 1);
                requestKipTip(id, { force: true });
              }}
            >
              <Icon name="bulb" size={18} /> Show Kip's Tip: {KIP_TIP_IDS[demoTip % KIP_TIP_IDS.length]}
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <motion.button
        className="locate card"
        // Recenter as soon as a finger lands, so a tap or a press and hold both work; keyboard
        // activation still arrives as a click with no pointer detail.
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          recenter();
        }}
        onClick={(event) => {
          if (event.detail === 0) recenter();
        }}
        onContextMenu={(event) => event.preventDefault()}
        aria-label="Center on me"
        style={{ pointerEvents: selected || showArrival ? "none" : "auto" }}
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
            <NearbyPanel nearby={nearbyItems} all={searchItems} onSelect={(id) => select(id, "nearby")} />
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {trip && !showArrival && !selected && (
          <TripPanel
            key="trip"
            park={trip}
            holder={visit.holderOf(trip.id)}
            flagDays={flagDays(trip.id)}
            flagAgeMs={flagAge(trip.id)}
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
            holder={visit.holderOf(here.id)}
            flagDays={flagDays(here.id)}
            visitLabel={visit.labelFor(here.id)}
            visited={visit.visitedToday(here.id)}
            crew={visit.crewOf(here.id)}
            now={game.serverNow()}
            onCheckIn={() => checkIn(here.id)}
            onScanCrew={crew.enabled ? () => crew.openScanner(here.id) : undefined}
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
              claim={state.claims[selected.id]}
              inside={here?.id === selected.id}
              holder={visit.holderOf(selected.id)}
              flagDays={flagDays(selected.id)}
              visitLabel={visit.labelFor(selected.id)}
              signedIn={visit.signedIn}
              insideForFounding={insidePark(user, bounds?.byId.get(selected.id), hasUsableGpsFix ? state.accuracy ?? 0 : 0)}
              canFound={isFeatureEnabled("parkProposals")}
              onFound={() => startFounding(selected.id)}
              onClose={() => select(null)}
              onGo={startTrip}
              onCheckIn={() => checkIn(selected.id)}
              onFeedback={() => dispatch({ type: "feedback", open: true, parkId: selected.id })}
            />
          </>
        )}
      </AnimatePresence>

      {FIELD && !hasUsableGpsFix && !state.locationError && <div className="finding card">Finding you…</div>}
    </div>
  );
}
