// Stills of the selection tools mid-gesture for the printed manual (manual/img/*-use.png).
//   (dev server running)  node tests/ui/record-manual-stills.mjs [lasso|brush|polygon …]
// Like record-help-gifs.mjs, but at 2× pixel density and captured before the mouse is
// released, so the loop / stroke / open polygon is still on screen. A drawn cursor stands in
// for the real pointer.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { APP, ROOT, installShim, newDemoSession, pickTool, pinsOf, ringOf, startTileServer } from "./harness.mjs";
import { cursorScript, motion } from "./media-kit.mjs";

const OUT = path.join(ROOT, "manual/img");
const WORK = path.join(APP, "tests/.out/manual-stills");
fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const only = process.argv.slice(2);

const tiles = await startTileServer();
const W = 1280, H = 800;
// harness.launch() fixes deviceScaleFactor at 1: set up the same context at 2×
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
await installShim(context);
await context.addInitScript(cursorScript);
const page = await context.newPage();
const dialog = (...a) => page.evaluate((q) => window.__dialogQueue.push(...q), a);
await newDemoSession(page, dialog, { save: path.join(WORK, "demo.msgrade") });

const { glide, key, wait } = motion(page, { x: W / 2, y: H / 2 });
const tool = (name) => pickTool(page, name);
const focusCluster = () => key("f", 900);

/** press and drag through points, but keep the button down */
async function press(points, button = "right", stepMs = 30) {
  await glide(points[0][0], points[0][1]);
  await page.mouse.down({ button });
  for (const [x, y] of points.slice(1)) {
    await page.mouse.move(x, y, { steps: 3 });
    await wait(stepMs);
  }
}

/** crop rectangle (16:10, CSS px) around the current cluster, kept clear of the side panel, toolbar and the viewer's corner badges */
async function cropAround(c, { w = 700, dx = 0, dy = 0 } = {}) {
  const rp = await page.locator(".right").boundingBox();
  const tb = await page.locator(".vtool").boundingBox();
  const v = await page.locator(".viewer-overlay").boundingBox();
  const bottom = Math.min(tb.y - 6, v.y + v.height - 60); // the scale bar is drawn in the bottom corner
  const cw = Math.round(Math.min(rp.x - 20, w)), ch = Math.round((cw * 10) / 16);
  const x = Math.round(Math.max(0, Math.min(rp.x - 40 - cw, c.x - cw / 2 + dx)));
  const y = Math.round(Math.max(56, Math.min(bottom - ch, c.y - ch / 2 + dy)));
  return { x, y, width: cw, height: ch };
}

/** empty the selection (the cluster starts selected): a small lasso loop on bare slide */
async function deselect(c) {
  const ps = await pinsOf(page);
  const v = await page.locator(".viewer-overlay").boundingBox();
  let spot = null;
  for (let a = 0; a < 16 && !spot; a++) {
    const t = (a / 16) * Math.PI * 2;
    const x = c.x + Math.cos(t) * c.r * 1.6, y = c.y + Math.sin(t) * c.r * 1.6;
    if (x < v.x + 30 || y < v.y + 30 || x > v.x + v.width - 30 || y > v.y + v.height - 30) continue;
    if (ps.every((p) => Math.hypot(p.x - x, p.y - y) > 60)) spot = [x, y];
  }
  if (!spot) throw new Error("no bare spot to deselect on");
  await tool("Lasso");
  await page.mouse.move(spot[0] + 25, spot[1]);
  await page.mouse.down({ button: "right" });
  for (let i = 1; i <= 12; i++) await page.mouse.move(spot[0] + 25 * Math.cos((i / 12) * 2 * Math.PI), spot[1] + 25 * Math.sin((i / 12) * 2 * Math.PI));
  await page.mouse.up({ button: "right" });
  await wait(300);
  await key("Escape", 300);
}

/** frame the cluster: zoom to it, then a couple of scroll steps closer, with nothing selected */
async function frame(zoomSteps) {
  await focusCluster();
  let c = await ringOf(page);
  await page.mouse.move(c.x, c.y);
  for (let i = 0; i < zoomSteps; i++) (await page.mouse.wheel(0, -100), await wait(250));
  await wait(1500); // tiles settle
  c = await ringOf(page);
  await deselect(c);
  await wait(300);
  return ringOf(page);
}

async function still(name, fn, { zoomSteps = 2, ...crop } = {}) {
  if (only.length && !only.includes(name)) return;
  const c = await frame(zoomSteps);
  console.log(name, "ring", c);
  await fn({ c });
  await wait(250);
  const file = path.join(OUT, `${name}-use.png`);
  await page.screenshot({ path: file, clip: await cropAround(c, crop) });
  console.log(`${path.relative(ROOT, file)}`);
}

// ---- the stills (Q1, cluster A) ----
await page.evaluate(() => (window.__noKeys = true)); // no key badges in stills
await key("m", 200); // minimap off: it would sit in the crop
await focusCluster();

await still("lasso", async ({ c }) => {
  await tool("Lasso");
  const r = c.r * 0.75;
  // ~80 % of a loop around the left part of the cluster, button still down
  const loop = Array.from({ length: 22 }, (_, i) => {
    const a = (i / 25) * Math.PI * 2 - Math.PI / 2;
    return [c.x - r * 0.25 + r * Math.cos(a) * (1 + 0.08 * Math.sin(3 * a)), c.y + r * 0.8 * Math.sin(a)];
  });
  await press(loop);
}, { w: 640 });
await page.mouse.up({ button: "right" });
await wait(400);
await key("Escape", 300);

await still("brush", async ({ c }) => {
  await tool("Brush");
  await glide(c.x - c.r * 0.9, c.y - c.r * 0.2);
  await wait(300);
  await press(Array.from({ length: 11 }, (_, i) => [c.x - c.r * 0.9 + (i * c.r * 1.3) / 13, c.y - c.r * 0.2 + Math.sin(i / 2) * c.r * 0.15]));
}, { w: 640 });
await page.mouse.up({ button: "right" });
await wait(400);
await key("Escape", 300);

await still("polygon", async ({ c }) => {
  await tool("Polygon");
  const r = c.r * 0.7;
  const corners = [[-1, -0.8], [0.2, -1], [0.9, -0.2], [0.4, 0.7]].map(([a, b]) => [c.x + a * r, c.y + b * r]);
  for (const [x, y] of corners) {
    await glide(x, y, 380);
    await page.mouse.click(x, y, { button: "right" });
    await wait(250);
  }
  // heading for the next corner: the rubber-band edge follows the pointer
  await glide(c.x - 0.7 * r, c.y + 0.8 * r, 380);
}, { w: 640, dx: -24 });
await key("Escape", 300);
await tool("Lasso");

await context.close();
await browser.close();
tiles.stop();
