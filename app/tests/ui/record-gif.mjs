// Records docs/demo.gif: a short grading run on the demo class.
//   (dev server running)  node tests/ui/record-gif.mjs
//   GIF_WIDTH / GIF_FPS change the output size and frame rate.
import fs from "node:fs";
import path from "node:path";
import { APP, ROOT, launch, newDemoSession, startTileServer } from "./harness.mjs";
import { recordGif } from "./media-kit.mjs";

const OUT = path.join(ROOT, "docs");
const WORK = path.join(APP, "tests/.out/gif");
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

const tiles = await startTileServer();
const { browser, context, page, dialog } = await launch({ browser: "chromium", viewport: { width: 1280, height: 800 } });
const wait = (ms) => page.waitForTimeout(ms);
await newDemoSession(page, dialog, { save: path.join(WORK, "demo.msgrade") });

const gif = path.join(OUT, "demo.gif");
const r = await recordGif(
  context,
  page,
  { file: gif, work: WORK, width: Number(process.env.GIF_WIDTH ?? 1000), fps: Number(process.env.GIF_FPS ?? 12), colors: 256, lead: 0, tail: 0 },
  async () => {
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
  },
);
await browser.close();
tiles.stop();
console.log(`${gif} ${(r.kb / 1000).toFixed(1)} MB, ${r.frames} frames, ${r.secs.toFixed(1)} s`);
