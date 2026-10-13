import { useMemo } from "react";
import { qrPath } from "../lib/qr";

/** A QR code drawn as SVG: dark ink modules on white, so phone cameras read it easily. */
export function QrCode({ value, size = 180, label }: { value: string; size?: number; label: string }) {
  const qr = useMemo(() => qrPath(value), [value]);
  return (
    <svg className="qr-code" viewBox={`0 0 ${qr.size} ${qr.size}`} width={size} height={size} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={qr.size} height={qr.size} fill="#fff" />
      <path d={qr.d} fill="#14231c" />
    </svg>
  );
}
