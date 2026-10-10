import { useEffect, useState } from "react";
import type { MultiPolygon, Position } from "./types";
import { Icon } from "../ui";
import { ParkMap, type Basemap } from "./ParkMap";

/**
 * A park map with editing tools: draw a boundary with left clicks, drop the pin with a right
 * click, and drag to pan. It can fill the screen for detailed drawing, switch between
 * satellite and street maps, and hide the player's sketch.
 */

type Props = {
  boundary: MultiPolygon | null;
  pin: Position;
  sketch?: Position[] | null;
  editable: boolean;
  /** Returns false when saving failed, so the drawing stays open. */
  onBoundary(geometry: MultiPolygon): Promise<boolean> | boolean;
  onPin(position: Position): void;
  /** Change to refit the map, for example after the park reloads. */
  fitKey?: string;
};

function round(position: Position): Position {
  return [Math.round(position[0] * 1e6) / 1e6, Math.round(position[1] * 1e6) / 1e6];
}

export function MapEditor({ boundary, pin, sketch, editable, onBoundary, onPin, fitKey = "initial" }: Props) {
  const [vertices, setVertices] = useState<Position[] | null>(null);
  const [full, setFull] = useState(false);
  const [basemap, setBasemap] = useState<Basemap>("satellite");
  const [showSketch, setShowSketch] = useState(true);
  const [refit, setRefit] = useState(0);
  const drawing = vertices !== null;

  async function finish() {
    if (!vertices || vertices.length < 3) return;
    if (await onBoundary({ type: "MultiPolygon", coordinates: [[[...vertices, vertices[0]]]] })) {
      setVertices(null);
      setRefit((value) => value + 1);
    }
  }

  // Keyboard shortcuts while drawing: Enter saves, Backspace undoes, Escape leaves.
  useEffect(() => {
    if (!drawing && !full) return;
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (event.key === "Escape") {
        if (drawing) setVertices(null);
        else setFull(false);
      } else if (drawing && event.key === "Enter") {
        void finish();
      } else if (drawing && event.key === "Backspace") {
        event.preventDefault();
        setVertices((current) => current?.slice(0, -1) ?? null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (!full) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [full]);

  return (
    <div className={`map-editor${full ? " map-editor--full" : ""}`}>
      <div className="map-frame map-frame--editor">
        <ParkMap
          boundary={boundary}
          pin={pin}
          sketch={showSketch ? sketch ?? null : null}
          drawing={vertices}
          onMapClick={drawing ? (position) => setVertices([...vertices, round(position)]) : undefined}
          onMapRightClick={editable ? (position) => onPin(round(position)) : undefined}
          crosshair={drawing}
          basemap={basemap}
          fitKey={`${fitKey}-${refit}`}
          pinZoom={15}
        />
        <div className="map-tools">
          {drawing ? (
            <>
              <span className="map-tools__hint">Click to add corners ({vertices.length}). Drag to pan.</span>
              <button type="button" className="button button--ghost button--small" disabled={!vertices.length} onClick={() => setVertices(vertices.slice(0, -1))}>Undo</button>
              <button type="button" className="button button--ghost button--small" onClick={() => setVertices(null)}>Cancel</button>
              <button type="button" className="button button--primary button--small" disabled={vertices.length < 3} onClick={() => void finish()}><Icon name="check" size={15} /> Use boundary</button>
            </>
          ) : (
            <>
              {editable && <button type="button" className="button button--ghost button--small" onClick={() => setVertices([])}><Icon name="edit" size={15} /> {boundary ? "Redraw boundary" : "Draw boundary"}</button>}
              {editable && <span className="map-tools__hint map-tools__hint--quiet">Right-click to drop the pin</span>}
              <span className="map-tools__spacer" />
            </>
          )}
          <div className="map-tools__group">
            {sketch && (
              <button type="button" className={`chip-toggle${showSketch ? " is-on" : ""}`} aria-pressed={showSketch} onClick={() => setShowSketch(!showSketch)} title="Show the player's sketch">
                <span className="legend-sketch" /> Sketch
              </button>
            )}
            <button type="button" className="chip-toggle is-on" onClick={() => setBasemap(basemap === "satellite" ? "streets" : "satellite")} title="Switch the base map">
              <Icon name="layers" size={14} /> {basemap === "satellite" ? "Satellite" : "Map"}
            </button>
            <button type="button" className="icon-button icon-button--small map-tools__full" onClick={() => setFull(!full)} aria-label={full ? "Exit full screen" : "Full screen"} title={full ? "Exit full screen (Esc)" : "Full screen"}>
              <Icon name={full ? "close" : "expand"} size={15} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
