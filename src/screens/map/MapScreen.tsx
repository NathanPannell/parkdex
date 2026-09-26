import type { Map as MLMap } from "maplibre-gl";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "../../components/Badge";
import { Icon } from "../../components/Icon";
import { Kip } from "../../components/Kip";
import { RollingNumber } from "../../components/Motion";
import { parkContaining, useBoundaries } from "../../lib/boundaries";
import { burst } from "../../lib/confetti";
import { buzz, sfx } from "../../lib/feedback";
import { arcPath, arrivalPoint, distanceKm, formatDistance, ringBounds, type LngLat } from "../../lib/geo";
import { PARK_BY_ID, PARKS, RARITY, TOTAL_BADGES } from "../../lib/parks";
import { useStore } from "../../lib/store";
import { MapView } from "./MapView";
import { ParkSheet } from "./ParkSheet";
import { ArrivalCard, TripPanel } from "./TripPanel";

const SHEET_PAD = { top: 80, bottom: 460, left: 40, right: 40 };
const TRIP_PAD = { top: 120, bottom: 300, left: 60, right: 60 };

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export function MapScreen() {
  const { state, dispatch } = useStore();
  const mapRef = useRef<MLMap | null>(null);
  const bounds = useBoundaries();
  const [route, setRoute] = useState<LngLat[] | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [dismissedArrival, setDismissedArrival] = useState<string | null>(null);
  const [demoOpen, setDemoOpen] = useState(false);
  const tripStart = useRef<{ from: LngLat; total: number } | null>(null);

  const { user, claims, selectedId, tripId } = state;
  const selected = selectedId ? PARK_BY_ID.get(selectedId) : undefined;
  const trip = tripId ? PARK_BY_ID.get(tripId) : undefined;
  const here = useMemo(() => parkContaining(user, bounds?.byId), [user, bounds]);
  const arrivedId = here && !claims[here.id] ? here.id : null;
  const showArrival = !!arrivedId && arrivedId !== dismissedArrival && !selected && !simulating;
  const claimedCount = Object.keys(claims).length;

  const nearby = useMemo(
    () =>
      PARKS.filter((p) => !claims[p.id])
        .map((p) => ({ p, km: distanceKm(user, [p.lng, p.lat]) }))
        .sort((a, b) => a.km - b.km)
        .slice(0, 8),
    [user, claims],
  );

  // Arrival moment: celebrate once each time the visitor crosses into an unclaimed park.
  const lastArrived = useRef<string | null>(null);
  useEffect(() => {
    if (arrivedId && arrivedId !== lastArrived.current) {
      sfx.arrive();
      buzz([30, 60, 30]);
      burst({ x: 0.5, y: 0.55 }, 0.7);
      const b = bounds?.byId.get(arrivedId);
      if (b) mapRef.current?.fitBounds(ringBounds(b), { padding: { top: 120, bottom: 420, left: 50, right: 50 }, maxZoom: 15, duration: 1400 });
      setRoute(null);
    }
    lastArrived.current = arrivedId;
  }, [arrivedId]);

  // The "focus" request comes from the collection screen or deep links.
  useEffect(() => {
    if (state.focusId) {
      select(state.focusId);
      dispatch({ type: "focus", id: null });
    }
  }, [state.focusId]);

  function select(id: string | null) {
    if (simulating) return;
    dispatch({ type: "select", id });
    if (!id) return;
    sfx.pop();
    buzz(10);
    const p = PARK_BY_ID.get(id)!;
    mapRef.current?.flyTo({ center: [p.lng, p.lat], zoom: Math.max(mapRef.current.getZoom(), 11.5), padding: SHEET_PAD, duration: 900, essential: true });
  }

  function startTrip() {
    if (!selected || !bounds) return;
    const target = arrivalPoint(bounds.byId.get(selected.id)!, user);
    const path = arcPath(user, target);
    tripStart.current = { from: user, total: distanceKm(user, target) };
    setRoute(path);
    sfx.whoosh();
    buzz(15);
    dispatch({ type: "trip", id: selected.id });
    dispatch({ type: "select", id: null });
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
        dispatch({ type: "move", user: route[idx] });
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
    dispatch({ type: "move", user: point });
  }

  function checkIn(id: string) {
    dispatch({ type: "trip", id });
    dispatch({ type: "select", id: null });
    dispatch({ type: "go", screen: "camera" });
    sfx.tap();
  }

  function recenter() {
    sfx.tap();
    mapRef.current?.flyTo({ center: user, zoom: 12.5, duration: 900, padding: { top: 0, bottom: 200, left: 0, right: 0 } });
  }

  const remaining = trip && bounds ? distanceKm(user, arrivalPoint(bounds.byId.get(trip.id)!, tripStart.current?.from ?? user)) : 0;

  return (
    <div className="screen map-screen">
      <MapView
        mapRef={mapRef}
        user={user}
        fc={bounds?.fc}
        claims={claims}
        selectedId={selectedId}
        tripId={tripId}
        arrivedId={arrivedId}
        route={route}
        onSelect={select}
      />

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
            <Kip size={40} />
          </span>
          <span className="counter__text">
            <strong>
              <RollingNumber value={claimedCount} />
              <em> / {TOTAL_BADGES.toLocaleString("en-CA")}</em>
            </strong>
            <span>badges collected</span>
          </span>
        </motion.button>
        <motion.div className="map-top__tools" initial={{ y: -80 }} animate={{ y: 0 }} transition={{ type: "spring", stiffness: 300, damping: 22, delay: 0.4 }}>
          <button className="tool card" onClick={() => dispatch({ type: "mute" })} aria-label="Toggle sound">
            <Icon name={state.muted ? "mute" : "sound"} size={20} />
          </button>
          <button className="tool card" onClick={() => setDemoOpen((v) => !v)} aria-label="Demo controls">
            <Icon name="wand" size={20} />
          </button>
        </motion.div>
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
                dispatch({ type: "move", user: [-123.3656, 48.4284] });
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
              {nearby.map(({ p, km }, i) => (
                <motion.button
                  key={p.id}
                  className="nearby__card card"
                  onClick={() => select(p.id)}
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
                    {formatDistance(km)}
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
            remainingKm={here?.id === trip.id ? 0 : remaining}
            totalKm={tripStart.current?.total ?? remaining}
            simulating={simulating}
            onSimulate={simulate}
            onEnd={endTrip}
            onOpen={() => select(trip.id)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showArrival && here && (
          <ArrivalCard
            key={here.id}
            park={here}
            onCheckIn={() => checkIn(here.id)}
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
              user={user}
              claim={claims[selected.id]}
              inside={here?.id === selected.id}
              onClose={() => select(null)}
              onGo={startTrip}
              onCheckIn={() => checkIn(selected.id)}
              onViewCase={() => {
                dispatch({ type: "select", id: null });
                dispatch({ type: "go", screen: "collection" });
              }}
            />
          </>
        )}
      </AnimatePresence>

      {!bounds && <div className="map-loading">Loading parks…</div>}
    </div>
  );
}
