import { motion } from "motion/react";
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from "react";
import { Icon } from "./Icon";
import { clampCrop, largestCrop, panCrop, roundCrop, zoomCrop, type PhotoCrop } from "../lib/photoCrop";
import type { OriginalPhoto } from "../lib/photoEncode";

type Props = {
  photo: OriginalPhoto;
  caption: string;
  busy: boolean;
  error: string | null;
  onRetake: () => void;
  onUse: (crop: PhotoCrop) => void;
};

type Point = { x: number; y: number };

/** Room left around the frame inside the stage, in pixels. */
const STAGE_GUTTER = 28;
const KEY_PAN = 0.05;
const KEY_ZOOM = 1.15;

function frameSize(stageWidth: number, stageHeight: number): { width: number; height: number } {
  const width = Math.max(120, Math.min(stageWidth - STAGE_GUTTER * 2, ((stageHeight - STAGE_GUTTER * 2) * 3) / 4));
  return { width, height: (width * 4) / 3 };
}

/**
 * The manual crop after each capture (#173): a fixed 3:4 frame over the photo. One finger drags
 * the photo, two fingers pinch to zoom, and it starts centred at the largest fit. A mouse wheel
 * and the arrow, plus and minus keys do the same on the web. Give each photo its own `key`, so a
 * retake starts again from the largest fit.
 */
export function PhotoCropper({ photo, caption, busy, error, onRetake, onUse }: Props) {
  const [crop, setCrop] = useState<PhotoCrop>(() => largestCrop(photo.width, photo.height));
  const [frame, setFrame] = useState({ width: 270, height: 360 });
  const stage = useRef<HTMLDivElement>(null);
  const frameEl = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, Point>());
  const latest = useRef(crop);
  latest.current = crop;

  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    const measure = () => setFrame(frameSize(element.clientWidth, element.clientHeight));
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const update = (next: PhotoCrop) => {
    latest.current = next;
    setCrop(next);
  };

  /** A point on screen as 0–1 of the frame, so zooming keeps it under the fingers. */
  const inFrame = (point: Point): Point => {
    const box = frameEl.current?.getBoundingClientRect();
    if (!box || !box.width || !box.height) return { x: 0.5, y: 0.5 };
    return { x: Math.min(1, Math.max(0, (point.x - box.left) / box.width)), y: Math.min(1, Math.max(0, (point.y - box.top) / box.height)) };
  };

  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (busy) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
  };

  const move = (event: PointerEvent<HTMLDivElement>) => {
    const known = pointers.current;
    const before = known.get(event.pointerId);
    if (!before) return;
    const others = [...known.entries()].filter(([id]) => id !== event.pointerId).map(([, point]) => point);
    const after = { x: event.clientX, y: event.clientY };
    known.set(event.pointerId, after);
    let next = latest.current;
    if (others.length === 0) {
      next = panCrop(next, (after.x - before.x) / frame.width, (after.y - before.y) / frame.height, photo.width, photo.height);
    } else {
      // Pinch with the first other finger: zoom around the old midpoint, then follow the midpoint.
      const other = others[0];
      const spanBefore = Math.hypot(before.x - other.x, before.y - other.y);
      const spanAfter = Math.hypot(after.x - other.x, after.y - other.y);
      const midBefore = { x: (before.x + other.x) / 2, y: (before.y + other.y) / 2 };
      const midAfter = { x: (after.x + other.x) / 2, y: (after.y + other.y) / 2 };
      if (spanBefore > 4) next = zoomCrop(next, spanAfter / spanBefore, inFrame(midBefore), photo.width, photo.height);
      next = panCrop(next, (midAfter.x - midBefore.x) / frame.width, (midAfter.y - midBefore.y) / frame.height, photo.width, photo.height);
    }
    update(next);
  };

  const up = (event: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
  };

  const wheel = (event: WheelEvent<HTMLDivElement>) => {
    if (busy) return;
    update(zoomCrop(latest.current, Math.exp(-event.deltaY * 0.0015), inFrame({ x: event.clientX, y: event.clientY }), photo.width, photo.height));
  };

  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    if (busy) return;
    const centre = { x: 0.5, y: 0.5 };
    const moves: Record<string, () => PhotoCrop> = {
      ArrowLeft: () => panCrop(latest.current, KEY_PAN, 0, photo.width, photo.height),
      ArrowRight: () => panCrop(latest.current, -KEY_PAN, 0, photo.width, photo.height),
      ArrowUp: () => panCrop(latest.current, 0, KEY_PAN, photo.width, photo.height),
      ArrowDown: () => panCrop(latest.current, 0, -KEY_PAN, photo.width, photo.height),
      "+": () => zoomCrop(latest.current, KEY_ZOOM, centre, photo.width, photo.height),
      "=": () => zoomCrop(latest.current, KEY_ZOOM, centre, photo.width, photo.height),
      "-": () => zoomCrop(latest.current, 1 / KEY_ZOOM, centre, photo.width, photo.height),
    };
    const action = moves[event.key];
    if (!action) return;
    event.preventDefault();
    update(action());
  };

  const shown = clampCrop(crop, photo.width, photo.height);
  const imageWidth = frame.width / shown.width;
  const imageHeight = frame.height / shown.height;

  return (
    <motion.div className="cropper" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="cropper__title">Crop your photo</div>
      <div
        ref={stage}
        className="cropper__stage"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onWheel={wheel}
        onKeyDown={key}
        tabIndex={0}
        role="application"
        aria-label="Photo crop. Drag to move, pinch or use plus and minus to zoom."
      >
        <div ref={frameEl} className="cropper__frame" style={{ width: frame.width, height: frame.height }}>
          <img
            className="cropper__image"
            src={photo.dataUrl}
            alt="Your photo"
            draggable={false}
            style={{ width: imageWidth, height: imageHeight, transform: `translate3d(${-shown.x * imageWidth}px, ${-shown.y * imageHeight}px, 0)` }}
          />
          <div className="cropper__window" aria-hidden="true" />
        </div>
      </div>
      <div className="cropper__bottom">
        <span className="cropper__caption">{caption}</span>
        <div className="cropper__hint" role={error ? "alert" : undefined}>{error ?? (busy ? "Getting your photo ready…" : "Pinch to zoom. Drag to move.")}</div>
        <div className="review__actions">
          <button className="btn btn--paper" onClick={onRetake} disabled={busy}>
            <Icon name="refresh" size={18} /> Retake
          </button>
          <button className="btn btn--glow" onClick={() => onUse(roundCrop(shown))} disabled={busy}>
            Use photo <Icon name="next" />
          </button>
        </div>
      </div>
    </motion.div>
  );
}
