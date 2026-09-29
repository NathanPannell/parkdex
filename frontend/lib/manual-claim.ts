import type { LocationSample, PhotoAsset } from "./native-capabilities";

export const MANUAL_CLAIM_PLACE_ID = "regional-englishman-river-regional-park";

// This point is inside the published Englishman River Regional Park boundary.
// It is only offered by the staging-only settings control.
export function manualClaimLocation(): LocationSample {
  return { latitude: 49.287303, longitude: -124.286889, accuracyMeters: 6, capturedAtEpochMs: Date.now() };
}

/** Make a fresh, plainly artificial JPEG so the normal private upload path is exercised. */
export async function manualClaimPhoto(): Promise<PhotoAsset> {
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 800;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser could not create the test photo.");

  const palettes = [
    { sky: "#9bd5d6", hill: "#315f53", river: "#458b99" },
    { sky: "#c6d9bf", hill: "#426345", river: "#5a9baa" },
    { sky: "#e4caab", hill: "#356255", river: "#5d91a3" },
  ];
  const palette = palettes[Math.floor(Math.random() * palettes.length)];
  context.fillStyle = palette.sky;
  context.fillRect(0, 0, 1200, 800);
  context.fillStyle = palette.hill;
  context.beginPath();
  context.moveTo(0, 420);
  context.bezierCurveTo(290, 220, 480, 510, 750, 360);
  context.bezierCurveTo(940, 260, 1090, 340, 1200, 300);
  context.lineTo(1200, 800);
  context.lineTo(0, 800);
  context.fill();
  context.fillStyle = palette.river;
  context.beginPath();
  context.moveTo(0, 670);
  context.bezierCurveTo(330, 510, 570, 610, 1200, 480);
  context.lineTo(1200, 800);
  context.lineTo(0, 800);
  context.fill();
  context.fillStyle = "#f6f0dc";
  context.fillRect(420, 50, 360, 135);
  context.fillStyle = "#173d32";
  context.font = "bold 38px sans-serif";
  context.textAlign = "center";
  context.fillText("STAGING", 600, 106);
  context.fillText("TEST PHOTO", 600, 153);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.8));
  canvas.width = 1;
  canvas.height = 1;
  if (!blob) throw new Error("This browser could not save the test photo.");
  return {
    file: new File([blob], `parkdex-test-${Date.now()}.jpg`, { type: "image/jpeg" }),
    mimeType: "image/jpeg",
    processingState: "prepared",
  };
}
