// Records docs/demo.gif: a short grading run on the demo class.
//   (dev server running)  UI_BROWSER=chromium node tests/ui/record-gif.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { APP, ROOT, startTileServer } from "./harness.mjs";

const OUT = path.join(ROOT, "docs");
const WORK = path.join(APP, "tests/.out/gif");
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

// reuse the harness's Tauri stand-in, but with video recording on
const harness = await import("./harness.mjs");
const tiles = await startTileServer();
const W = 1280, H = 800;
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: WORK, size: { width: W, height: H } } });
await harness.installShim(context);
const page = await context.newPage();
const t0 = Date.now();
const wait = (ms) => page.waitForTimeout(ms);
const dialog = (...a) => page.evaluate((x) => window.__dialogQueue.push(...x), a);

await page.goto("http://localhost:1420/");
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.getByText("New grading session…").click();
await dialog(path.join(ROOT, "demo/exam.json"));
await page.getByText("Choose exam PDF / JSON…").click();
await wait(400);
await dialog(path.join(ROOT, "demo/submissions"));
await page.locator(".step").nth(1).getByRole("button").click();
await wait(600);
await dialog(path.join(ROOT, "images"));
await page.locator(".step").nth(2).getByRole("button").click();
await wait(600);
await dialog(path.join(WORK, "demo.msgrade"));
await page.locator(".step").nth(3).getByRole("button").click();
await page.getByText("Start grading →").click();
await page.locator(".topbar").waitFor();
await wait(2500); // tiles settle
const start = (Date.now() - t0) / 1000;

// --- the part that ends up in the GIF ---
await wait(900);
await page.keyboard.press("c"); // grade cluster A correct (button flashes)
await wait(1300);
await page.keyboard.press("]");
await wait(1100);
await page.keyboard.press("w");
await wait(500);
await page.keyboard.type("Eccrine sweat gland", { delay: 45 });
await wait(400);
await page.keyboard.press("Enter");
await wait(1200);
await page.keyboard.press("]");
await wait(900);
await page.keyboard.press("w");
await wait(700);
await page.keyboard.press("1"); // reuse the recent reason
await wait(1100);
// lasso a region
const rp = await page.locator(".right").boundingBox();
const tb = await page.locator(".vtool").boundingBox();
const cx = rp.x * 0.5, cy = (48 + tb.y) / 2, r = Math.min(rp.x, tb.y - 48) * 0.28;
await page.mouse.move(cx + r, cy);
await page.mouse.down({ button: "right" });
for (let i = 1; i <= 28; i++) {
  const a = (i / 28) * Math.PI * 2;
  await page.mouse.move(cx + r * Math.cos(a) * (1 + 0.15 * Math.sin(3 * a)), cy + r * Math.sin(a), { steps: 2 });
}
await page.mouse.up({ button: "right" });
await wait(1400);
await page.keyboard.press("Escape");
await wait(500);
await page.keyboard.press("s"); // jump to single pins
await wait(1300);
await page.keyboard.press("h"); // whole slide
await wait(1800);
await page.keyboard.press("Meta+ArrowRight"); // next image
await wait(2600);
const end = (Date.now() - t0) / 1000;

await context.close();
await browser.close();
tiles.stop();

const webm = fs.readdirSync(WORK).find((f) => f.endsWith(".webm"));
const gif = path.join(OUT, "demo.gif");
// 720 px / 8 fps / 96 colours keeps the README GIF around 6 MB
const vf = "fps=8,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle";
execFileSync("ffmpeg", ["-y", "-ss", String(start), "-to", String(end), "-i", path.join(WORK, webm), "-vf", vf, "-loop", "0", gif], { stdio: "ignore" });
console.log(`${gif} ${(fs.statSync(gif).size / 1e6).toFixed(1)} MB, ${(end - start).toFixed(1)} s`);
