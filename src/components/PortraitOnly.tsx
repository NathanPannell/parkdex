import { motion } from "motion/react";
import { Kip } from "./Kip";
import { QrCode } from "./QrCode";
import type { PortraitPanel } from "../lib/webApp";
import "../web-app.css";

/**
 * Covers the app on the web while the screen is wider than it is tall. The app stays mounted
 * behind it, so turning the phone back restores exactly what was there.
 */
export function PortraitOnly({ panel }: { panel: PortraitPanel }) {
  if (!panel) return null;
  return (
    <div className="portrait-only" role="dialog" aria-modal="true" aria-labelledby="portrait-only-title">
      {panel === "desktop" ? <DesktopPanel /> : <SidewaysPanel />}
    </div>
  );
}

function DesktopPanel() {
  const url = typeof location === "undefined" ? "https://web.parkdex.app/" : location.href;
  return (
    <div className="portrait-only__card portrait-only__card--desktop">
      <div className="portrait-only__intro">
        <Kip pose="wave" size={150} />
        <span className="eyebrow">Parkdex</span>
        <h1 id="portrait-only-title">Parkdex is made for phones held upright</h1>
        <p>Plant your flag in real parks. Open Parkdex on your phone to play where you are.</p>
      </div>
      <figure className="portrait-only__qr">
        <QrCode value={url} size={200} label="QR code that opens Parkdex on your phone" />
        <figcaption>Scan to open on your phone</figcaption>
      </figure>
    </div>
  );
}

function SidewaysPanel() {
  return (
    <div className="portrait-only__card portrait-only__card--sideways">
      {/* A square slot, so the phone can turn without overlapping the text. */}
      <div className="portrait-only__turn" aria-hidden="true">
        <motion.div
          className="portrait-only__phone"
          initial={{ rotate: -90 }}
          animate={{ rotate: [-90, -90, 0, 0, -90] }}
          transition={{ duration: 3.6, times: [0, 0.2, 0.45, 0.85, 1], repeat: Infinity, ease: "easeInOut" }}
        >
          <Kip pose="point" size={84} />
        </motion.div>
      </div>
      <div className="portrait-only__text">
        <h1 id="portrait-only-title">Turn your phone upright</h1>
        <p>Parkdex is made for phones held upright.</p>
      </div>
    </div>
  );
}
