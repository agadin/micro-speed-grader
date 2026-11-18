// Records the short looping demos shown in Preferences → Selection (docs/help/img/*.gif).
//   (dev server running)  node tests/ui/record-help-gifs.mjs [name …]
// Each clip is cropped around the current cluster. A drawn cursor and key badges stand in
// for the real pointer, which headless screen captures don't show.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { APP, ROOT, startTileServer } from "./harness.mjs";

const OUT = path.join(ROOT, "docs/help/img");
const WORK = path.join(APP, "tests/.out/help-gifs");
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const only = process.argv.slice(2);

const harness = await import("./harness.mjs");
const tiles = await startTileServer();
const W = 1280, H = 800;
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: W, height: H } });
await harness.installShim(context);
// drawn cursor + key badges
await context.addInitScript(() => {
  const css = `
    #__cur { position: fixed; left: 0; top: 0; z-index: 2147483647; pointer-events: none; will-change: transform; }
    #__cur svg { display: block; filter: drop-shadow(0 1px 2px rgba(0,0,0,.6)); }
    #__cur .btn { position: absolute; left: -9px; top: -9px; width: 18px; height: 18px; border-radius: 50%;
      border: 2px solid #ffd257; opacity: 0; transition: opacity .1s; }
    #__cur.down .btn { opacity: 1; }
    #__key { position: fixed; z-index: 2147483647; pointer-events: none; padding: 8px 16px; border-radius: 12px;
      background: rgba(20,20,22,.9); color: #fff; font: 700 26px -apple-system, sans-serif; min-width: 24px; text-align: center;
      box-shadow: 0 2px 10px rgba(0,0,0,.5); border: 1px solid rgba(255,255,255,.25); opacity: 0; transition: opacity .15s; }
    #__key.on { opacity: 1; }`;
  const names = { " ": "Space", Enter: "↵", Escape: "Esc", ArrowRight: "→", ArrowLeft: "←", Backspace: "⌫", Meta: "⌘", Shift: "⇧", Alt: "⌥" };
  let x = 0, y = 0, timer = 0;
  window.addEventListener("DOMContentLoaded", () => {
    const st = document.createElement("style");
    st.textContent = css;
    document.head.appendChild(st);
    const c = document.createElement("div");
    c.id = "__cur";
    c.innerHTML = `<div class="btn"></div><svg width="18" height="22" viewBox="0 0 18 22"><path d="M1 1v17l4.5-4.2 3 6.6 2.6-1.2-3-6.4H14Z" fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg>`;
    document.body.appendChild(c);
    const k = document.createElement("div");
    k.id = "__key";
    document.body.appendChild(k);
  });
  const move = (e) => {
    x = e.clientX;
    y = e.clientY;
    const c = document.getElementById("__cur");
    if (c) c.style.transform = `translate(${x}px, ${y}px)`;
  };
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerdown", (e) => (move(e), document.getElementById("__cur")?.classList.add("down")), true);
  window.addEventListener("pointerup", () => document.getElementById("__cur")?.classList.remove("down"), true);
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.repeat || ["Meta", "Shift", "Alt", "Control"].includes(e.key)) return;
      const k = document.getElementById("__key");
      if (!k || window.__noKeys) return;
      const mods = (e.metaKey ? "⌘" : "") + (e.shiftKey && e.key.length > 1 ? "⇧" : "");
      k.textContent = mods + (names[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key));
      const a = window.__keyAt ?? { x: x + 22, y: y + 18 };
      k.style.left = a.x + "px";
      k.style.top = a.y + "px";
      k.classList.add("on");
      clearTimeout(timer);
      timer = setTimeout(() => k.classList.remove("on"), 750);
    },
    true,
  );
});
const page = await context.newPage();
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
await wait(2500);

// ---- helpers ----
const viewer = () => page.locator(".viewer-overlay").boundingBox();
async function ring() {
  const v = await viewer();
  const r = (await page.locator(".viewer-overlay").getAttribute("data-cluster-ring")).split(",").map(Number);
  return { x: v.x + r[0], y: v.y + r[1], r: r[2] };
}
async function pins() {
  const v = await viewer();
  const s = (await page.locator(".viewer-overlay").getAttribute("data-pins")) || "";
  return s
    .split(";")
    .filter(Boolean)
    .map((p) => p.split(",").map(Number))
    .map(([x, y]) => ({ x: v.x + x, y: v.y + y }));
}
let mx = W / 2, my = H / 2;
async function glide(x, y, ms = 450) {
  const n = Math.max(2, Math.round(ms / 25));
  const x0 = mx, y0 = my;
  for (let i = 1; i <= n; i++) {
    const t = i / n, e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    await page.mouse.move(x0 + (x - x0) * e, y0 + (y - y0) * e);
    await wait(25);
  }
  mx = x;
  my = y;
}
async function drag(points, button = "right", stepMs = 30) {
  await glide(points[0][0], points[0][1]);
  await page.mouse.down({ button });
  for (const [x, y] of points.slice(1)) {
    await page.mouse.move(x, y, { steps: 3 });
    mx = x;
    my = y;
    await wait(stepMs);
  }
  await page.mouse.up({ button });
}
const key = async (k, after = 500) => (await page.keyboard.press(k), wait(after));
const tool = (name) => page.locator(".right .seg button", { hasText: name }).click();
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
async function focusCluster() {
  await key("f", 900);
}

// record one clip, cropped 16:9 around the current cluster
async function clip(name, fn, { zoom = 1, dx = 0 } = {}) {
  if (only.length && !only.includes(name)) return;
  const c = await ring();
  const rp = await page.locator(".right").boundingBox();
  const tb = await page.locator(".vtool").boundingBox();
  let cw = Math.round(Math.min(rp.x - 20, 760 * zoom)), ch = Math.round((cw * 9) / 16);
  let cx = Math.round(Math.max(0, Math.min(rp.x - 10 - cw, c.x - cw / 2 + dx)));
  let cy = Math.round(Math.max(56, Math.min(tb.y - 6 - ch, c.y - ch / 2 + 20)));
  await page.evaluate((a) => (window.__keyAt = a), { x: cx + 16, y: cy + ch - 64 });
  const frames = [];
  const cdp = await context.newCDPSession(page);
  cdp.on("Page.screencastFrame", (f) => {
    frames.push({ t: f.metadata.timestamp, data: f.data });
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "png", maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  await wait(600);
  await fn({ c });
  await wait(900);
  await cdp.send("Page.stopScreencast");
  await cdp.detach();
  const dir = path.join(WORK, name);
  fs.mkdirSync(dir, { recursive: true });
  const list = [];
  frames.forEach((f, i) => {
    const file = path.join(dir, `f${String(i).padStart(5, "0")}.png`);
    fs.writeFileSync(file, Buffer.from(f.data, "base64"));
    const dur = i + 1 < frames.length ? frames[i + 1].t - f.t : 1.2;
    list.push(`file '${file}'`, `duration ${dur.toFixed(3)}`);
  });
  list.push(list[list.length - 2]);
  fs.writeFileSync(path.join(dir, "frames.txt"), list.join("\n"));
  const gif = path.join(OUT, `${name}.gif`);
  const vf = `crop=${cw}:${ch}:${cx}:${cy},fps=10,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
  execFileSync("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", path.join(dir, "frames.txt"), "-vf", vf, "-loop", "0", gif], { stdio: "ignore" });
  console.log(`${name}.gif  ${(fs.statSync(gif).size / 1e3).toFixed(0)} kB, ${frames.length} frames`);
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
