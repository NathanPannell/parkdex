import { useMemo } from "react";
import { encode } from "uqr";

/**
 * A QR code drawn as one SVG path, for friend codes (#64) and crew codes (#170). Dark modules
 * are ink on a paper quiet zone, so phone cameras read it in sunlight and from a screen.
 */

export type QrMatrix = { size: number; path: string };

/** The modules of `value` as an SVG path in module units, with a quiet zone of `border` modules. */
export function qrMatrix(value: string, border = 2): QrMatrix {
  const { data, size } = encode(value, { ecc: "M", border });
  let path = "";
  data.forEach((row, y) => {
    let x = 0;
    while (x < size) {
      if (!row[x]) {
        x += 1;
        continue;
      }
      // One rectangle per run of dark modules keeps the path short.
      const start = x;
      while (x < size && row[x]) x += 1;
      path += `M${start} ${y}h${x - start}v1h${start - x}z`;
    }
  });
  return { size, path };
}

export function QrCode({ value, size = 220, label, className }: { value: string; size?: number; label: string; className?: string }) {
  const matrix = useMemo(() => qrMatrix(value), [value]);
  return (
    <svg
      className={className ? `qr-code ${className}` : "qr-code"}
      width={size}
      height={size}
      viewBox={`0 0 ${matrix.size} ${matrix.size}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect width={matrix.size} height={matrix.size} fill="#fffdf6" />
      <path d={matrix.path} fill="#14231c" />
    </svg>
  );
}
