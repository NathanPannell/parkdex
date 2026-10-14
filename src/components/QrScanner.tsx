import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useBackHandler } from "../lib/backStack";
import { useLiveCamera } from "../lib/camera";
import { buzz, sfx } from "../lib/feedback";
import { press } from "../lib/motion";
import { cleanSocialCodeInput, formatSocialCode } from "../lib/social/codes";
import { Icon } from "./Icon";
import "../social.css";

/**
 * A live in-app QR scanner with a "Type code instead" fallback, for friend codes (#64) and crew
 * codes (#170). It reads frames from the back camera with jsQR, which loads only when a scanner
 * opens. Callers decide what a code means: `onCode` returns an error to show (and the scanner
 * keeps going) or null when the code was taken.
 */

export type QrScannerSource = "scan" | "typed";

export type QrScannerProps = {
  title: string;
  /** One line under the viewfinder, such as "Point at a friend's Parkdex code". */
  hint: string;
  /** Length of a typed code; typed input keeps only characters from the shared code alphabet. */
  codeLength: number;
  typeLabel?: string;
  onCode(text: string, source: QrScannerSource): string | null | Promise<string | null>;
  onClose(): void;
};

type Decoder = (data: Uint8ClampedArray, width: number, height: number, options?: { inversionAttempts?: "dontInvert" | "onlyInvert" | "attemptBoth" | "invertFirst" }) => { data: string } | null;

const SCAN_EVERY_MS = 160;
const MAX_SCAN_WIDTH = 640;
// The same rejected code stays on screen; scanning it again within this window says nothing new.
const REPEAT_MS = 2500;

let decoderPromise: Promise<Decoder> | null = null;
function loadDecoder(): Promise<Decoder> {
  decoderPromise ??= import("jsqr").then((module) => module.default as Decoder).catch((error) => {
    decoderPromise = null;
    throw error;
  });
  return decoderPromise;
}

export function QrScanner({ title, hint, codeLength, typeLabel = "Type code instead", onCode, onClose }: QrScannerProps) {
  const [mode, setMode] = useState<QrScannerSource>("scan");
  const { video, live } = useLiveCamera("environment", 960);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState("");
  const busyRef = useRef(false);
  const lastRejected = useRef<{ text: string; at: number } | null>(null);
  const latestOnCode = useRef(onCode);
  latestOnCode.current = onCode;
  const cameraOff = live === "off";

  useBackHandler(onClose);

  const submit = useCallback(async (text: string, source: QrScannerSource) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const problem = await latestOnCode.current(text, source);
      if (problem) {
        lastRejected.current = { text, at: Date.now() };
        setError(problem);
        buzz([20, 30, 20]);
      } else {
        setError(null);
        sfx.pop();
        buzz(18);
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  // Read frames while the camera is live and the scanner is showing.
  useEffect(() => {
    if (mode !== "scan" || live !== "on") return;
    let stopped = false;
    let decode: Decoder | null = null;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    void loadDecoder().then((loaded) => { decode = loaded; }).catch(() => {
      if (!stopped) setError("The scanner couldn't start. Type the code instead.");
    });
    const timer = window.setInterval(() => {
      const frame = video.current;
      if (stopped || !decode || !context || !frame || busyRef.current || frame.readyState < 2 || !frame.videoWidth) return;
      const scale = Math.min(1, MAX_SCAN_WIDTH / frame.videoWidth);
      canvas.width = Math.round(frame.videoWidth * scale);
      canvas.height = Math.round(frame.videoHeight * scale);
      context.drawImage(frame, 0, 0, canvas.width, canvas.height);
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      const found = decode(image.data, image.width, image.height, { inversionAttempts: "dontInvert" });
      if (!found?.data) return;
      const repeat = lastRejected.current;
      if (repeat && repeat.text === found.data && Date.now() - repeat.at < REPEAT_MS) return;
      void submit(found.data, "scan");
    }, SCAN_EVERY_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [live, mode, submit, video]);

  const showTyped = mode === "typed" || cameraOff;

  const submitTyped = (event: FormEvent) => {
    event.preventDefault();
    if (typed.length !== codeLength) {
      setError(`Codes have ${codeLength} letters and numbers.`);
      return;
    }
    void submit(typed, "typed");
  };

  return (
    <motion.div
      className="qr-scanner"
      role="dialog"
      aria-modal="true"
      aria-labelledby="qr-scanner-title"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <video ref={video} className={`qr-scanner__video ${live === "on" && !showTyped ? "is-live" : ""}`} playsInline muted autoPlay aria-hidden="true" />
      <header className="qr-scanner__head">
        <h2 id="qr-scanner-title">{title}</h2>
        <button type="button" className="btn btn--paper btn--icon" onClick={onClose} aria-label="Close scanner">
          <Icon name="close" size={20} stroke={3} />
        </button>
      </header>

      <AnimatePresence mode="wait" initial={false}>
        {showTyped ? (
          <motion.form
            key="typed"
            className="qr-scanner__card card"
            onSubmit={submitTyped}
            initial={{ y: 30, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 30, opacity: 0 }}
          >
            {cameraOff && <p className="qr-scanner__note">The camera isn't available, so type the code instead.</p>}
            <label className="fb-label" htmlFor="qr-scanner-code">Code</label>
            <input
              id="qr-scanner-code"
              className="fb-input qr-scanner__input"
              value={formatSocialCode(typed)}
              onChange={(event) => { setTyped(cleanSocialCodeInput(event.target.value, codeLength)); setError(null); }}
              autoComplete="off"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              inputMode="text"
              placeholder={formatSocialCode("X".repeat(codeLength))}
              aria-invalid={!!error}
              aria-describedby={error ? "qr-scanner-error" : undefined}
              autoFocus
            />
            {error && <p id="qr-scanner-error" className="qr-scanner__error" role="alert">{error}</p>}
            <motion.button whileTap={press} type="submit" className="btn btn--sun btn--block" disabled={busy || typed.length !== codeLength}>
              {busy ? "Checking…" : "Use this code"}
            </motion.button>
            {!cameraOff && (
              <button type="button" className="btn btn--paper btn--block" onClick={() => { setMode("scan"); setError(null); }}>
                <Icon name="camera" size={18} /> Scan instead
              </button>
            )}
          </motion.form>
        ) : (
          <motion.div key="scan" className="qr-scanner__scan" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className={`qr-scanner__frame ${busy ? "is-busy" : ""}`} aria-hidden="true">
              <span /><span /><span /><span />
            </div>
            <div className="qr-scanner__card card">
              <p className="qr-scanner__hint" aria-live="polite">{live === "pending" ? "Starting the camera…" : hint}</p>
              {error && <p className="qr-scanner__error" role="alert">{error}</p>}
              <button type="button" className="btn btn--paper btn--block" onClick={() => { setMode("typed"); setError(null); }}>
                {typeLabel}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
