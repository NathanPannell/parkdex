import type { Map as MLMap } from "maplibre-gl";
import { motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Icon } from "../../components/Icon";
import { pressMenuPosition, type ScreenPoint } from "../../lib/longPress";

type Props = {
  mapRef: RefObject<MLMap | null>;
  point: ScreenPoint;
  canPropose: boolean;
  onClose: () => void;
  onFeedback: () => void;
  onPropose: () => void;
};

// Clears the map counter and menu button along the top of the screen.
const TOP_CONTROLS = 76;

/** "Should something be here?" menu opened by pressing and holding an empty part of the map. */
export function PressMenu({ mapRef, point, canPropose, onClose, onFeedback, onPropose }: Props) {
  const menu = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number; below: boolean } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const container = mapRef.current?.getContainer();
    const box = menu.current;
    if (!container || !box) return;
    setPlace(pressMenuPosition(
      point,
      { width: container.clientWidth, height: container.clientHeight },
      { width: box.offsetWidth, height: box.offsetHeight },
      TOP_CONTROLS,
    ));
  }, [mapRef, point]);

  // The pressed spot is fixed on screen, so the menu closes when the map moves or on any tap elsewhere.
  useEffect(() => {
    const map = mapRef.current;
    const close = () => closeRef.current();
    const closeOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Element && event.target.closest(".press-menu"))) close();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    map?.on("movestart", close);
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      map?.off("movestart", close);
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [mapRef]);

  useEffect(() => {
    if (place) menu.current?.querySelector("button")?.focus({ preventScroll: true });
  }, [place]);

  return (
    <>
      <span className="press-dot" style={{ left: point.x, top: point.y }} aria-hidden="true" />
      <motion.div
        ref={menu}
        className="press-menu card"
        role="menu"
        aria-labelledby="press-menu-title"
        style={{
          left: place?.left ?? point.x,
          top: place?.top ?? point.y,
          visibility: place ? "visible" : "hidden",
          transformOrigin: place?.below ? "top center" : "bottom center",
        }}
        initial={{ opacity: 0, scale: 0.7 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.8 }}
        transition={{ type: "spring", stiffness: 500, damping: 30 }}
      >
        <span className="eyebrow press-menu__title" id="press-menu-title">Should something be here?</span>
        <button role="menuitem" onClick={onFeedback}>
          <Icon name="feedback" size={20} /> Send feedback
        </button>
        {canPropose && (
          <button role="menuitem" onClick={onPropose}>
            <Icon name="pinPlus" size={20} /> Propose a park
          </button>
        )}
      </motion.div>
    </>
  );
}
