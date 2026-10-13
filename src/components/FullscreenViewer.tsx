import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type PointerEvent, type ReactNode, type WheelEvent } from "react";
import { createPortal } from "react-dom";
import { useBackHandler } from "../lib/backStack";
import {
  clampTransform, doubleTap, dragDownOpacity, fitInside, IDENTITY, isDoubleTap, isZoomed, panBy, releaseAction, TAP_SLOP_PX, viewerKeyAction, viewerReducer, zoomAround,
  type Point, type Size, type ViewerTransform,
} from "../lib/viewer";
import { usePhotoUrl } from "./DexPhoto";
import { Icon } from "./Icon";
import "../fullscreen-viewer.css";

export type ViewerSlide = {
  key: string;
  /** Read out for the slide, and the image's `alt`. */
  alt: string;
  /** An image URL, or a saved photo, shown whole and fitted to the screen. */
  src?: string | null;
  blob?: Blob | null;
  /** Anything else to show big, such as a flag drawn as SVG. It is given the stage's size. */
  render?: (stage: Size) => ReactNode;
  /** A line under the slide, such as a date or an @handle. */
  caption?: ReactNode;
};

type Props = {
  slides: readonly ViewerSlide[];
  /** The open slide, or null when the viewer is closed. */
  index: number | null;
  onStep?: (delta: number) => void;
  onClose: () => void;
  /** The dialog's name, such as "Photos of Paterson Park". */
  label: string;
  /** Buttons under the slide, such as "Make cover". */
  actions?: (slide: ViewerSlide, index: number) => ReactNode;
};

/** Opens, steps and closes a viewer over `count` slides. Pass its `index`, `step` and `close` to FullscreenViewer. */
export function useViewer(count: number) {
  const [state, dispatch] = useReducer(viewerReducer, { index: null });
  const countRef = useRef(count);
  countRef.current = count;
  const open = useCallback((index = 0) => dispatch({ type: "open", index, count: countRef.current }), []);
  const close = useCallback(() => dispatch({ type: "close" }), []);
  const step = useCallback((delta: number) => dispatch({ type: "step", delta, count: countRef.current }), []);
  // A slide that went away (a photo removed) never leaves the viewer pointing past the end.
  const index = state.index === null || count < 1 ? null : Math.min(state.index, count - 1);
  return { index, open, close, step };
}

/**
 * A photo or a flag, full screen (operator request, 2026-10-13): a black backdrop with the slide
 * centred. Pinch or double-tap to zoom, drag when zoomed, swipe sideways between slides, and close
 * with the ✕, a swipe down, Android back or Escape. It sits above the bottom bar and any sheet.
 */
export function FullscreenViewer(props: Props) {
  const open = props.index !== null && props.slides.length > 0;
  return createPortal(
    <AnimatePresence>{open && <ViewerLayer key="viewer" {...props} index={Math.min(props.index ?? 0, props.slides.length - 1)} />}</AnimatePresence>,
    document.querySelector(".device") ?? document.body,
  );
}

type Gesture = {
  start: Point;
  last: Point;
  lastAt: number;
  vx: number;
  vy: number;
  moved: boolean;
  /** Two fingers touched during this gesture: lifting never pages or closes. */
  multi: boolean;
  axis: "x" | "y" | null;
};

function ViewerLayer({ slides, index, onStep, onClose, label, actions }: Props & { index: number }) {
  const stage = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLElement | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [box, setBox] = useState<Size>({ width: 360, height: 640 });
  const [transform, setTransform] = useState<ViewerTransform>(IDENTITY);
  const [drag, setDrag] = useState<Point>({ x: 0, y: 0 });
  const [active, setActive] = useState(false);
  const [direction, setDirection] = useState(0);
  const latest = useRef(transform);
  latest.current = transform;
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const lastTap = useRef<{ at: number; point: Point } | null>(null);
  const slide = slides[index];
  const count = slides.length;

  const update = (next: ViewerTransform) => {
    latest.current = next;
    setTransform(next);
  };

  const step = (delta: number) => {
    const next = index + delta;
    if (next < 0 || next >= count) return;
    setDirection(delta);
    onStep?.(delta);
  };

  useBackHandler(onClose);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const action = viewerKeyAction(event.key);
      if (!action) return;
      // The viewer is on top, so it takes these keys before any screen underneath sees them.
      event.preventDefault();
      event.stopPropagation();
      if (action === "close") onClose();
      else step(action === "next" ? 1 : -1);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  // Focus moves into the viewer and returns to whatever opened it.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus({ preventScroll: true });
    return () => opener?.focus({ preventScroll: true });
  }, []);

  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    const measure = () => setBox({ width: element.clientWidth, height: element.clientHeight });
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Each slide opens fitted and centred.
  useLayoutEffect(() => {
    update(IDENTITY);
    setDrag({ x: 0, y: 0 });
    lastTap.current = null;
  }, [index]);

  // The slide sliding away unmounts after the new one mounts, so only a new element is kept.
  const holdContent = (element: HTMLElement | null) => {
    if (element) content.current = element;
  };
  const contentSize = (): Size => ({ width: content.current?.offsetWidth ?? 0, height: content.current?.offsetHeight ?? 0 });

  /** A point on screen, from the stage's centre. */
  const fromCentre = (point: Point): Point => {
    const rect = stage.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: point.x - (rect.left + rect.width / 2), y: point.y - (rect.top + rect.height / 2) };
  };

  const down = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const point = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, point);
    setActive(true);
    if (pointers.current.size === 1) {
      gesture.current = { start: point, last: point, lastAt: event.timeStamp, vx: 0, vy: 0, moved: false, multi: false, axis: null };
    } else if (gesture.current) {
      gesture.current.multi = true;
      gesture.current.moved = true;
      setDrag({ x: 0, y: 0 });
    }
  };

  const move = (event: PointerEvent<HTMLDivElement>) => {
    const known = pointers.current;
    const before = known.get(event.pointerId);
    const current = gesture.current;
    if (!before || !current) return;
    const after = { x: event.clientX, y: event.clientY };
    known.set(event.pointerId, after);
    const others = [...known.entries()].filter(([id]) => id !== event.pointerId).map(([, point]) => point);
    const size = contentSize();
    if (others.length > 0) {
      // Pinch with the first other finger: zoom around the old midpoint, then follow the midpoint.
      const other = others[0];
      const spanBefore = Math.hypot(before.x - other.x, before.y - other.y);
      const spanAfter = Math.hypot(after.x - other.x, after.y - other.y);
      const midBefore = { x: (before.x + other.x) / 2, y: (before.y + other.y) / 2 };
      const midAfter = { x: (after.x + other.x) / 2, y: (after.y + other.y) / 2 };
      let next = latest.current;
      if (spanBefore > 4) next = zoomAround(next, spanAfter / spanBefore, fromCentre(midBefore), box, size);
      update(panBy(next, midAfter.x - midBefore.x, midAfter.y - midBefore.y, box, size));
      return;
    }
    const elapsed = Math.max(1, event.timeStamp - current.lastAt);
    current.vx = (after.x - current.last.x) / elapsed;
    current.vy = (after.y - current.last.y) / elapsed;
    current.last = after;
    current.lastAt = event.timeStamp;
    const dx = after.x - current.start.x;
    const dy = after.y - current.start.y;
    if (!current.moved && Math.hypot(dx, dy) > TAP_SLOP_PX) current.moved = true;
    if (!current.moved) return;
    if (isZoomed(latest.current)) {
      update(panBy(latest.current, after.x - before.x, after.y - before.y, box, size));
      return;
    }
    if (current.multi) return;
    // At the fitted size one finger either pages sideways or pulls down to close, never both.
    if (!current.axis) current.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
    setDrag(current.axis === "x" ? { x: count > 1 ? dx : dx * 0.25, y: 0 } : { x: 0, y: Math.max(0, dy) + Math.min(0, dy) * 0.2 });
  };

  const up = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(event.pointerId)) return;
    const current = gesture.current;
    if (pointers.current.size > 0) {
      // Back to one finger after a pinch: it pans from here.
      const [remaining] = [...pointers.current.values()];
      if (current) {
        current.start = remaining;
        current.last = remaining;
      }
      return;
    }
    setActive(false);
    gesture.current = null;
    if (!current) return;
    const point = { x: event.clientX, y: event.clientY };
    if (!current.moved) {
      if (isDoubleTap(lastTap.current, event.timeStamp, point)) {
        lastTap.current = null;
        update(doubleTap(latest.current, fromCentre(point), box, contentSize()));
      } else {
        lastTap.current = { at: event.timeStamp, point };
      }
      return;
    }
    lastTap.current = null;
    const outcome = current.multi ? "stay" : releaseAction({
      dx: point.x - current.start.x,
      dy: point.y - current.start.y,
      vx: current.vx,
      vy: current.vy,
      transform: latest.current,
      index,
      count,
      box,
    });
    if (outcome === "close") {
      onClose();
      return;
    }
    if (outcome === "next") step(1);
    else if (outcome === "prev") step(-1);
    setDrag({ x: 0, y: 0 });
  };

  const wheel = (event: WheelEvent<HTMLDivElement>) => {
    update(zoomAround(latest.current, Math.exp(-event.deltaY * 0.0015), fromCentre({ x: event.clientX, y: event.clientY }), box, contentSize()));
  };

  const shown = clampTransform(transform, box, contentSize());
  const style = {
    transform: `translate3d(${shown.x + drag.x}px, ${shown.y + drag.y}px, 0) scale(${shown.scale})`,
  };

  return (
    <motion.div
      className="fullscreen-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.18 } }}
      transition={{ duration: 0.2 }}
      // Rendered through a portal, so React would still bubble these to the sheet that opened it.
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="fullscreen-viewer__backdrop" style={{ opacity: dragDownOpacity(drag.y) }} aria-hidden="true" />
      <div className="fullscreen-viewer__top">
        {count > 1 ? <span className="fullscreen-viewer__count" aria-live="polite">{index + 1} / {count}</span> : <span />}
        <button ref={closeButton} className="fullscreen-viewer__close" onClick={onClose} aria-label="Close">
          <Icon name="close" size={20} stroke={2.8} />
        </button>
      </div>

      <div
        ref={stage}
        className={`fullscreen-viewer__stage${active ? " is-active" : ""}${isZoomed(shown) ? " is-zoomed" : ""}`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onWheel={wheel}
      >
        <AnimatePresence initial={false} custom={direction}>
          <motion.div
            key={slide.key}
            className="fullscreen-viewer__slide"
            custom={direction}
            initial={{ x: `${direction * 100}%`, opacity: 0.6 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: `${direction * -100}%`, opacity: 0.6 }}
            transition={{ type: "spring", stiffness: 380, damping: 38 }}
          >
            {slide.render ? (
              <div ref={holdContent} className="fullscreen-viewer__content" style={style} role="img" aria-label={slide.alt}>
                {slide.render(box)}
              </div>
            ) : (
              <ViewerImage slide={slide} box={box} style={style} imageRef={holdContent} />
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      {(slide.caption || actions) && (
        <div className="fullscreen-viewer__bottom">
          {slide.caption && <div className="fullscreen-viewer__caption">{slide.caption}</div>}
          {actions?.(slide, index)}
        </div>
      )}
    </motion.div>
  );
}

/** A photo, fitted inside the stage at its own shape once it has loaded. */
function ViewerImage({ slide, box, style, imageRef }: { slide: ViewerSlide; box: Size; style: { transform: string }; imageRef: (element: HTMLImageElement | null) => void }) {
  const fromBlob = usePhotoUrl(slide.blob ?? null);
  const src = slide.src ?? fromBlob;
  const [natural, setNatural] = useState<Size | null>(null);
  const fitted = natural ? fitInside(natural, box) : null;
  if (!src) return null;
  return (
    <img
      ref={imageRef}
      className="fullscreen-viewer__image"
      src={src}
      alt={slide.alt}
      draggable={false}
      onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
      style={fitted ? { ...style, width: fitted.width, height: fitted.height } : { ...style, visibility: "hidden" }}
    />
  );
}
