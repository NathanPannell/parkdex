import { encode } from "uqr";

/** One SVG path for the dark modules of a QR code, plus its side length in modules (border included). */
export function qrPath(value: string, border = 2): { size: number; d: string } {
  const { data } = encode(value, { ecc: "M", border });
  let d = "";
  data.forEach((row, y) => row.forEach((dark, x) => {
    if (dark) d += `M${x} ${y}h1v1h-1z`;
  }));
  return { size: data.length, d };
}
