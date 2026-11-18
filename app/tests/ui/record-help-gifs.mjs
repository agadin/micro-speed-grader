// Records the short looping demos of the selection tools (docs/help/img/*.gif), shown in
// Preferences ▸ Selection and in the help.
//   (dev server running)  node tests/ui/record-help-gifs.mjs [name …]
// Each clip is cropped around the current cluster. A drawn cursor and key badges stand in
// for the real pointer, which headless screen captures don't show.
import fs from "node:fs";
import path from "node:path";
import { APP, ROOT, launch, newDemoSession, pinsOf, pickTool, ringOf, startTileServer } from "./harness.mjs";
import { cursorScript, motion, recordGif } from "./media-kit.mjs";

const OUT = path.join(ROOT, "docs/help/img");
const WORK = path.join(APP, "tests/.out/help-gifs");
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const only = process.argv.slice(2);

const tiles = await startTileServer();
const W = 1280, H = 800;
const { browser, context, page, dialog } = await launch({ browser: "chromium", viewport: { width: W, height: H }, initScripts: [cursorScript] });
await newDemoSession(page, dialog, { save: path.join(WORK, "demo.msgrade") });

const { glide, drag, key, wait } = motion(page, { x: W / 2, y: H / 2 });
const ring = () => ringOf(page);
const pins = () => pinsOf(page);
const tool = (name) => pickTool(page, name);
async function setPrefs(patch) {
  // settings live in localStorage; reload the store the same way another window's change would
  await page.evaluate((p) => {
    const k = "msg.settings.v2";
    const s = JSON.parse(localStorage.getItem(k) || "{}");
    localStorage.setItem(k, JSON.stringify({ ...s, ...p }));
    window.dispatchEvent(new StorageEvent("storage", { key: k }));
  }, patch);
  await wait(200);
}
const focusCluster = () => key("f", 900);

// record one clip, cropped 16:9 around the current cluster
async function clip(name, fn, { zoom = 1, dx = 0 } = {}) {
  if (only.length && !only.includes(name)) return;
  const c = await ring();
  const rp = await page.locator(".right").boundingBox();
  const tb = await page.locator(".vtool").boundingBox();
  const cw = Math.round(Math.min(rp.x - 20, 760 * zoom)), ch = Math.round((cw * 9) / 16);
  const cx = Math.round(Math.max(0, Math.min(rp.x - 10 - cw, c.x - cw / 2 + dx)));
  const cy = Math.round(Math.max(56, Math.min(tb.y - 6 - ch, c.y - ch / 2 + 20)));
  await page.evaluate((a) => (window.__keyAt = a), { x: cx + 16, y: cy + ch - 64 });
  const r = await recordGif(
    context,
    page,
    { file: path.join(OUT, `${name}.gif`), crop: { x: cx, y: cy, width: cw, height: ch }, work: WORK, width: 480, fps: 10, colors: 128, lead: 600 },
    () => fn({ c }),
  );
  console.log(`${name}.gif  ${r.kb} kB, ${r.frames} frames`);
}

// ---- the clips (all on Q1, cluster A) ----
await page.evaluate(() => (window.__noKeys = true));
await key("m", 200); // minimap off: it would sit in the crop
await page.evaluate(() => (window.__noKeys = false));
await focusCluster();

await clip("lasso", async ({ c }) => {
  const r = c.r * 0.75;
  const loop = Array.from({ length: 26 }, (_, i) => {
    const a = (i / 25) * Math.PI * 2 - Math.PI / 2;
    return [c.x - r * 0.25 + r * Math.cos(a) * (1 + 0.08 * Math.sin(3 * a)), c.y + r * 0.8 * Math.sin(a)];
  });
  await drag(loop);
  await wait(2600);
  await key("Escape", 300);
  await focusCluster();
}, { zoom: 1.2, dx: 130 });

await clip("brush", async ({ c }) => {
  await tool("Brush");
  await glide(c.x - c.r * 0.9, c.y - c.r * 0.2);
  await wait(300);
  await drag(
    Array.from({ length: 14 }, (_, i) => [c.x - c.r * 0.9 + (i * c.r * 1.3) / 13, c.y - c.r * 0.2 + Math.sin(i / 2) * c.r * 0.15]),
  );
  await wait(2600);
  await key("Escape", 300);
  await tool("Lasso");
  await focusCluster();
}, { zoom: 1.2, dx: 130 });

await clip("polygon", async ({ c }) => {
  await tool("Polygon");
  const r = c.r * 0.7;
  const corners = [[-1, -0.8], [0.2, -1], [0.9, -0.2], [0.4, 0.7], [-0.7, 0.8]].map(([a, b]) => [c.x + a * r, c.y + b * r]);
  for (const [x, y] of corners) {
    await glide(x, y, 380);
    await page.mouse.click(x, y, { button: "right" });
    await wait(250);
  }
  await glide(corners[0][0], corners[0][1], 380);
  await page.mouse.click(corners[0][0], corners[0][1], { button: "right" });
  await wait(2600);
  await key("Escape", 300);
  await tool("Lasso");
  await focusCluster();
}, { zoom: 1.2, dx: 130 });

// keep the view put after grading so the green / red result stays on screen
await setPrefs({ autoZoomCluster: false });
await clip("hidden-paint", async ({ c }) => {
  await tool("Brush");
  await key(" ", 700);
  // paint the structure in two strokes
  await drag(Array.from({ length: 10 }, (_, i) => [c.x - c.r * 0.85 + (i * c.r * 0.9) / 9, c.y - c.r * 0.35]), "right", 45);
  await wait(250);
  await drag(Array.from({ length: 10 }, (_, i) => [c.x - c.r * 0.8 + (i * c.r * 0.85) / 9, c.y + c.r * 0.1]), "right", 45);
  await wait(500);
  await key(" ", 2000);
  await key("c", 700);
  await page.evaluate(() => (window.__noKeys = true));
  await page.keyboard.type("Dermal collagen", { delay: 55 });
  await wait(400);
  await page.evaluate(() => (window.__noKeys = false));
  await key("Enter", 2400);
  await key("Meta+z", 300);
  await tool("Lasso");
  await focusCluster();
}, { zoom: 1.2, dx: 130 });
await setPrefs({ autoZoomCluster: true });

await clip("pin-by-pin", async () => {
  await key("o", 1300);
  await key("c", 1000);
  await key("c", 1000);
  await key("ArrowRight", 900);
  await key("ArrowRight", 900);
  await key("o", 500);
  await key("Meta+z", 100);
  await key("Meta+z", 300);
  await focusCluster();
});

await setPrefs({ spotlight: true });
await clip("spotlight", async ({ c }) => {
  const ps = (await pins()).filter((p) => Math.hypot(p.x - c.x, p.y - c.y) < c.r).slice(0, 4);
  for (const p of ps) {
    await glide(p.x + 3, p.y - 2, 500);
    await wait(900);
  }
  await glide(c.x + c.r * 1.4, c.y + c.r * 0.3, 500);
});
await setPrefs({ spotlight: false });

await setPrefs({ shrinkPins: true, shrinkUmPerPx: 0.5 });
await clip("shrink", async ({ c }) => {
  await page.evaluate(() => (window.__noKeys = true));
  await glide(c.x, c.y, 300);
  for (let i = 0; i < 3; i++) (await page.mouse.wheel(0, 100), await wait(220));
  await wait(1100);
  for (let i = 0; i < 3; i++) (await page.mouse.wheel(0, -100), await wait(220));
  await wait(1300);
  await page.evaluate(() => (window.__noKeys = false));
});
await setPrefs({ shrinkPins: false });
await focusCluster();

await setPrefs({ clickToggle: true });
await clip("click-toggle", async ({ c }) => {
  await key("Escape", 200);
  const ps = (await pins()).filter((p) => Math.hypot(p.x - c.x, p.y - c.y) < c.r);
  // the cluster starts selected: clicks take pins out and put them back
  for (const p of [ps[0], ps[3], ps[6], ps[3]].filter(Boolean)) {
    await glide(p.x, p.y - 2, 450);
    await page.mouse.click(p.x, p.y - 2);
    await wait(650);
  }
});
await setPrefs({ clickToggle: false });

await context.close();
await browser.close();
tiles.stop();
