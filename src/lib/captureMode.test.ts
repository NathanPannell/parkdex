import { afterEach, describe, expect, it, vi } from "vitest";
import { captureMode, isMobileUserAgent, openBrowserCamera, startPhotoCapture, takeStartedCapture, usesCameraApp, type CaptureEnv } from "./captureMode";

const ANDROID_CHROME = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36";
const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPAD_SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const DESKTOP_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

const desktop: CaptureEnv = { native: false, coarsePointer: false, mobileUserAgent: false, liveCameraApi: true };
const phone: CaptureEnv = { native: false, coarsePointer: true, mobileUserAgent: true, liveCameraApi: true };

describe("captureMode", () => {
  it("opens the camera app in a phone browser, the installed web app included", () => {
    expect(captureMode(phone)).toBe("browser-camera");
  });

  it("treats any one phone signal as a phone", () => {
    expect(captureMode({ ...desktop, coarsePointer: true })).toBe("browser-camera");
    expect(captureMode({ ...desktop, mobileUserAgent: true })).toBe("browser-camera");
  });

  it("uses the browser's capture when there is no camera stream", () => {
    expect(captureMode({ ...desktop, liveCameraApi: false })).toBe("browser-camera");
  });

  it("keeps the live preview on a desktop browser", () => {
    expect(captureMode(desktop)).toBe("live-preview");
    expect(usesCameraApp("live-preview")).toBe(false);
  });

  it("leaves the Android build on its native camera app", () => {
    expect(captureMode({ ...phone, native: true })).toBe("native-camera");
    expect(captureMode({ ...desktop, native: true })).toBe("native-camera");
    expect(usesCameraApp("native-camera")).toBe(true);
    expect(usesCameraApp("browser-camera")).toBe(true);
  });
});

describe("isMobileUserAgent", () => {
  it("recognises Android, iPhone and iPad browsers", () => {
    expect(isMobileUserAgent(ANDROID_CHROME, 5)).toBe(true);
    expect(isMobileUserAgent(IPHONE_SAFARI, 5)).toBe(true);
    expect(isMobileUserAgent(IPAD_SAFARI, 5)).toBe(true);
  });

  it("leaves desktops and Macs out", () => {
    expect(isMobileUserAgent(DESKTOP_CHROME, 0)).toBe(false);
    expect(isMobileUserAgent(IPAD_SAFARI, 0)).toBe(false);
  });

  it("trusts client hints when the browser reports mobile", () => {
    expect(isMobileUserAgent(DESKTOP_CHROME, 0, true)).toBe(true);
  });
});

type FakeInput = {
  type: string;
  accept: string;
  tabIndex: number;
  style: { cssText: string };
  files: File[] | null;
  attributes: Record<string, string>;
  setAttribute: (name: string, value: string) => void;
  addEventListener: (type: string, listener: () => void) => void;
  click: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  fire: (type: string) => void;
};

function installDocument() {
  const inputs: FakeInput[] = [];
  const appended: FakeInput[] = [];
  vi.stubGlobal("document", {
    createElement: vi.fn(() => {
      const listeners: Record<string, Array<() => void>> = {};
      const input: FakeInput = {
        type: "",
        accept: "",
        tabIndex: 0,
        style: { cssText: "" },
        files: null,
        attributes: {},
        setAttribute: (name, value) => { input.attributes[name] = value; },
        addEventListener: (type, listener) => { (listeners[type] ??= []).push(listener); },
        click: vi.fn(),
        remove: vi.fn(),
        fire: (type) => listeners[type]?.forEach((listener) => listener()),
      };
      inputs.push(input);
      return input;
    }),
    body: { appendChild: (input: FakeInput) => appended.push(input) },
  });
  return { inputs, appended };
}

describe("openBrowserCamera", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks for the rear camera and opens it inside the tap", () => {
    const { inputs, appended } = installDocument();
    void openBrowserCamera();
    const [input] = inputs;
    expect(input.type).toBe("file");
    expect(input.accept).toBe("image/*");
    expect(input.attributes.capture).toBe("environment");
    // Synchronously, before any await, so the tap still counts as the gesture.
    expect(appended).toEqual([input]);
    expect(input.click).toHaveBeenCalledTimes(1);
  });

  it("resolves with the photo and removes the input", async () => {
    const { inputs } = installDocument();
    const shot = openBrowserCamera();
    const file = new File(["jpeg"], "photo.jpg", { type: "image/jpeg" });
    inputs[0].files = [file];
    inputs[0].fire("change");
    await expect(shot).resolves.toBe(file);
    expect(inputs[0].remove).toHaveBeenCalled();
  });

  it("resolves null when the player backs out of the camera", async () => {
    const { inputs } = installDocument();
    const shot = openBrowserCamera();
    inputs[0].fire("cancel");
    await expect(shot).resolves.toBeNull();
    expect(inputs[0].remove).toHaveBeenCalled();
  });

  it("replaces a capture that never heard back, for browsers without the cancel event", async () => {
    const { inputs } = installDocument();
    const first = openBrowserCamera();
    const second = openBrowserCamera();
    await expect(first).resolves.toBeNull();
    expect(inputs[0].remove).toHaveBeenCalled();
    const file = new File(["jpeg"], "photo.jpg", { type: "image/jpeg" });
    inputs[0].files = [file];
    inputs[0].fire("change");
    inputs[1].files = [file];
    inputs[1].fire("change");
    await expect(second).resolves.toBe(file);
  });
});

describe("started captures", () => {
  afterEach(() => {
    takeStartedCapture();
    vi.unstubAllGlobals();
  });

  it("opens the camera from the tap in a phone browser and hands the photo to the screen once", async () => {
    const { inputs } = installDocument();
    startPhotoCapture("browser-camera", 1000);
    expect(inputs[0].click).toHaveBeenCalledTimes(1);
    const shot = takeStartedCapture(1050);
    expect(shot).not.toBeNull();
    expect(takeStartedCapture(1060)).toBeNull();
    inputs[0].fire("cancel");
    await expect(shot).resolves.toBeNull();
  });

  it("opens nothing from the tap on Android or a desktop", () => {
    const { inputs } = installDocument();
    startPhotoCapture("native-camera", 1000);
    startPhotoCapture("live-preview", 1000);
    expect(inputs).toHaveLength(0);
    expect(takeStartedCapture(1000)).toBeNull();
  });

  it("drops a capture no photo screen collected in time", () => {
    installDocument();
    startPhotoCapture("browser-camera", 1000);
    expect(takeStartedCapture(4000)).toBeNull();
  });
});
