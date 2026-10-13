import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import jsQR from "jsqr";

const mocks = vi.hoisted(() => ({
  native: false,
  listeners: [] as Array<(event: { url: string }) => void>,
  launchUrl: null as string | null,
  removed: 0,
}));

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => mocks.native } }));
vi.mock("@capacitor/app", () => ({
  App: {
    addListener: vi.fn(async (_name: string, listener: (event: { url: string }) => void) => {
      mocks.listeners.push(listener);
      return { remove: async () => { mocks.removed += 1; } };
    }),
    getLaunchUrl: vi.fn(async () => (mocks.launchUrl ? { url: mocks.launchUrl } : undefined)),
  },
}));

import { SOCIAL_CODE_ALPHABET as SERVER_ALPHABET, normalizeSocialCode as serverNormalize } from "../../../worker/socialCodes";
import { qrMatrix } from "../../components/QrCode";
import { cleanSocialCodeInput, FRIEND_CODE_LENGTH, formatSocialCode, normalizeSocialCode, SOCIAL_CODE_ALPHABET } from "./codes";
import { isParkdexLinkHost, listenForAppLinks, parseAppLink, resetAppLinksForTests } from "./links";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("social codes", () => {
  it("match the server's alphabet and rules", () => {
    expect(SOCIAL_CODE_ALPHABET).toBe(SERVER_ALPHABET);
    expect(SOCIAL_CODE_ALPHABET).toHaveLength(31);
    for (const input of ["abcd-2345", " ABCD 2345 ", "ABCD234O", "ABCD2341", "ABC", "x".repeat(80)]) {
      expect(normalizeSocialCode(input, FRIEND_CODE_LENGTH)).toBe(serverNormalize(input, FRIEND_CODE_LENGTH));
    }
    expect(normalizeSocialCode("abcd-2345", FRIEND_CODE_LENGTH)).toBe("ABCD2345");
    expect(normalizeSocialCode("abc234", 6)).toBe("ABC234");
  });

  it("formats codes in two halves and cleans typed input", () => {
    expect(formatSocialCode("ABCD2345")).toBe("ABCD-2345");
    expect(formatSocialCode("ABC234")).toBe("ABC-234");
    expect(formatSocialCode("ABC")).toBe("ABC");
    expect(cleanSocialCodeInput("ab-cd 1o2345678", FRIEND_CODE_LENGTH)).toBe("ABCD2345");
  });
});

describe("QR drawing", () => {
  it("draws a code that a scanner reads back", () => {
    const value = "https://staging.web.parkdex.app/friend/ABCD2345";
    const { size, path } = qrMatrix(value);
    const scale = 6;
    const width = size * scale;
    const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
    for (const [, x, y, w] of path.matchAll(/M(\d+) (\d+)h(\d+)/g)) {
      for (let row = Number(y) * scale; row < (Number(y) + 1) * scale; row += 1) {
        for (let column = Number(x) * scale; column < (Number(x) + Number(w)) * scale; column += 1) {
          const offset = (row * width + column) * 4;
          pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 0;
        }
      }
    }
    expect(jsQR(pixels, width, width)?.data).toBe(value);
  });
});

describe("app links", () => {
  beforeEach(() => {
    mocks.native = false;
    mocks.listeners = [];
    mocks.launchUrl = null;
    mocks.removed = 0;
    resetAppLinksForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts Parkdex hosts only", () => {
    for (const url of ["https://web.parkdex.app/x", "https://staging.web.parkdex.app/x", "https://parkdex-kip-git-feat-x.vercel.app/x", "http://localhost:5190/x", "http://127.0.0.1:8787/x"]) {
      expect(isParkdexLinkHost(new URL(url)), url).toBe(true);
    }
    for (const url of ["http://web.parkdex.app/x", "https://parkdex.app.evil.test/x", "https://evilparkdex.app/x", "https://other.vercel.app/x", "javascript:alert(1)"]) {
      expect(isParkdexLinkHost(new URL(url)), url).toBe(false);
    }
  });

  it("routes several prefixes to the segment after them", () => {
    const prefixes = ["/friend/", "/crew/"];
    expect(parseAppLink("https://web.parkdex.app/friend/ABCD2345", prefixes)).toMatchObject({ prefix: "/friend/", value: "ABCD2345" });
    expect(parseAppLink("https://web.parkdex.app/crew/ABC234/", prefixes)).toMatchObject({ prefix: "/crew/", value: "ABC234" });
    expect(parseAppLink("https://web.parkdex.app/friend/", prefixes)).toBeNull();
    expect(parseAppLink("https://web.parkdex.app/friend/a/b", prefixes)).toBeNull();
    expect(parseAppLink("https://web.parkdex.app/account", prefixes)).toBeNull();
    expect(parseAppLink("https://user:pass@web.parkdex.app/friend/ABCD2345", prefixes)).toBeNull();
    expect(parseAppLink("https://evil.test/friend/ABCD2345", prefixes)).toBeNull();
    expect(parseAppLink("ABCD2345", prefixes)).toBeNull();
    expect(parseAppLink("https://web.parkdex.app/friend/%E0%A4%A", prefixes)).toBeNull();
  });

  it("takes a web page's own link once and clears the address", () => {
    const replaceState = vi.fn();
    vi.stubGlobal("window", { location: { href: "https://web.parkdex.app/friend/ABCD2345" } });
    vi.stubGlobal("history", { state: null, replaceState });
    const friend = vi.fn();
    const stop = listenForAppLinks({ "/friend/": friend });
    expect(friend).toHaveBeenCalledWith("ABCD2345", expect.any(URL));
    expect(replaceState).toHaveBeenCalledWith(null, "", "/");
    stop();
  });

  it("leaves other web addresses alone", () => {
    const replaceState = vi.fn();
    vi.stubGlobal("window", { location: { href: "https://web.parkdex.app/" } });
    vi.stubGlobal("history", { state: null, replaceState });
    const friend = vi.fn();
    listenForAppLinks({ "/friend/": friend })();
    expect(friend).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("forwards the launch link once per app process and later App Links each time", async () => {
    mocks.native = true;
    mocks.launchUrl = "https://web.parkdex.app/friend/ABCD2345";
    const friend = vi.fn();
    const crew = vi.fn();
    const stop = listenForAppLinks({ "/friend/": friend, "/crew/": crew });
    await settle();
    expect(friend).toHaveBeenCalledTimes(1);
    // The same launch event delivered again right away is the same tap.
    mocks.listeners[0]({ url: "https://web.parkdex.app/friend/ABCD2345" });
    expect(friend).toHaveBeenCalledTimes(1);
    mocks.listeners[0]({ url: "https://web.parkdex.app/crew/ABC234" });
    expect(crew).toHaveBeenCalledWith("ABC234", expect.any(URL));
    mocks.listeners[0]({ url: "https://web.parkdex.app/account#verificationToken=x" });
    expect(friend).toHaveBeenCalledTimes(1);
    stop();
    expect(mocks.removed).toBe(1);

    // Listening again (a remount) does not replay the launch link.
    const again = vi.fn();
    const stopAgain = listenForAppLinks({ "/friend/": again });
    await settle();
    expect(again).not.toHaveBeenCalled();
    stopAgain();
  });
});
