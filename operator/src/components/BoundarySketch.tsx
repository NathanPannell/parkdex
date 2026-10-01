import { useId } from "react";

type Position = [number, number];

/** A north-up drawing of a park boundary (and optional pin), scaled to fit. Holes are cut out. */
export function BoundarySketch({ polygons, pin, width = 160, height = 148, label }: { polygons: Position[][][]; pin?: Position | null; width?: number; height?: number; label?: string }) {
  const gridId = `sketch-grid${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const points = [...polygons.flat(2), ...(pin ? [pin] : [])];
  const pad = 14;
  let body: { path: string; pinAt: Position | null } = { path: "", pinAt: null };
  if (points.length) {
    const midLat = points.reduce((sum, p) => sum + p[1], 0) / points.length;
    // Longitude degrees shrink toward the poles; scale them so the shape is not stretched.
    const scaleX = Math.cos((midLat * Math.PI) / 180);
    const xs = points.map((p) => p[0] * scaleX), ys = points.map((p) => -p[1]);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    const spanX = Math.max(...xs) - minX, spanY = Math.max(...ys) - minY;
    const scale = Math.min((width - pad * 2) / (spanX || 1), (height - pad * 2) / (spanY || 1));
    const offsetX = (width - spanX * scale) / 2, offsetY = (height - spanY * scale) / 2;
    const project = ([lng, lat]: Position): Position => [offsetX + (lng * scaleX - minX) * scale, offsetY + (-lat - minY) * scale];
    const ring = (positions: Position[]) => `M${positions.map((position) => project(position).map((value) => value.toFixed(1)).join(" ")).join("L")}Z`;
    body = { path: polygons.flatMap((polygon) => polygon.map(ring)).join(""), pinAt: pin ? (points.length === 1 ? [width / 2, height / 2] : project(pin)) : null };
  }
  return (
    <svg className="sketch" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label ?? (polygons.length ? "Boundary sketch" : "Pin only")}>
      <defs>
        <pattern id={gridId} width="16" height="16" patternUnits="userSpaceOnUse">
          <path d="M16 0H0V16" fill="none" className="sketch__grid" />
        </pattern>
      </defs>
      <rect width={width} height={height} fill={`url(#${gridId})`} />
      {body.path && <path className="sketch__shape" d={body.path} fillRule="evenodd" />}
      {body.pinAt && (
        <g transform={`translate(${body.pinAt[0]} ${body.pinAt[1]})`} className="sketch__pin">
          <path d="M0 0c-5-6-9-10-9-15a9 9 0 0 1 18 0c0 5-4 9-9 15z" />
          <circle cx="0" cy="-15" r="3.2" />
        </g>
      )}
    </svg>
  );
}
