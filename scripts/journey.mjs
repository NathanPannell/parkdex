// Walks the whole core loop in headless Chrome at phone size and saves a
// screenshot per step to ./shots. Usage: npm run dev (in another shell), then
// node scripts/journey.mjs [baseUrl]
import { mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";

const BASE = process.argv[2] ?? "http://localhost:5190";
const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
mkdirSync("shots", { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required", "--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: false });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const shot = async (name) => {
  n += 1;
  await page.screenshot({ path: `shots/${String(n).padStart(2, "0")}-${name}.png` });
  console.log("shot", name);
};
const click = async (selector) => {
  await page.locator(selector).setTimeout(8000).click();
};
const text = (t) => `::-p-text(${t})`;

await page.goto(BASE);
await page.evaluate(() => localStorage.clear());
await page.reload();
await wait(1300);
await shot("splash");
await wait(2600);
await shot("onboarding-1");
await click(text("Next"));
await wait(2200);
await shot("onboarding-2");
await click(text("Next"));
await wait(2600);
await shot("onboarding-3");
await click(text("Let's go!"));
await wait(900);
await shot("permission");
await click(text("Use a demo spot"));
await wait(4500);
await shot("map");
await click(".nearby__card");
await wait(1800);
await shot("park-sheet");
await click(".park-sheet__cta .btn");
await wait(2200);
await shot("trip");
await click(".trip__sim");
await wait(1500);
await shot("travelling");
await wait(6000);
await shot("arrival");
await click(".arrival .btn");
await wait(2000);
await shot("camera");
await click(".shutter");
await wait(2200);
await shot("photo-review");
await click(text("Looks great"));
await wait(1800);
await shot("claim-ready");
const hold = await page.$(".hold__btn");
const box = await hold.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await wait(900);
await shot("claim-charging");
await wait(900);
await page.mouse.up();
await wait(250);
await shot("claim-burst");
await wait(2000);
await shot("claimed");
await click(text("Find next park"));
await wait(1800);
await shot("find-next-park");
await click(".nav__tab:last-child");
await wait(2200);
await shot("case");
await page.evaluate(() => document.querySelector(".fb-cta")?.scrollIntoView());
await wait(1200);
await shot("case-bottom");
await page.evaluate(() => document.querySelector(".collection")?.scrollTo(0, 0));
await click(".slot--filled");
await wait(1500);
await shot("badge-detail");
await click(".flip");
await wait(1500);
await shot("badge-detail-back");
await click(".detail__actions .btn--sun");
await wait(1800);
await shot("share");
await click(".seg__opt:last-child");
await wait(900);
await shot("share-badge-look");
await click(".share__top .btn");
await wait(1500);
await shot("map-after-share");

console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "no page errors");
await browser.close();
