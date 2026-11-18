// Screenshots and short GIFs for the help wiki (docs/help/img), taken from the demo class.
//   (dev server running)  node tests/ui/record-wiki-media.mjs [file …]   (only those files, e.g. disagreements.png)
// The selection-tool clips come from record-help-gifs.mjs.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { APP, ROOT, startTileServer, installShim } from "./harness.mjs";
import { cursorScript, recordGif } from "./media-kit.mjs";

const OUT = path.join(ROOT, "docs/help/img");
const WORK = path.join(APP, "tests/.out/wiki-media");
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const tiles = await startTileServer();
const W = 1440, H = 900;
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: W, height: H } });
await installShim(context);
await context.addInitScript(cursorScript);
const page = await context.newPage();
const wait = (ms) => page.waitForTimeout(ms);
const dialog = (...a) => page.evaluate((x) => window.__dialogQueue.push(...x), a);
const made = [];
const ONLY = process.argv.slice(2);
const wanted = (name) => !ONLY.length || ONLY.includes(name);
const cursor = (on) => page.evaluate((v) => document.getElementById("__cur") && (document.getElementById("__cur").style.display = v ? "" : "none"), on);
const pad = (b, p, bounds = { width: W, height: H }) => {
  const x = Math.max(0, b.x - p), y = Math.max(0, b.y - p);
  return { x, y, width: Math.min(bounds.width - x, b.width + 2 * p), height: Math.min(bounds.height - y, b.height + 2 * p) };
};
/** published images must not show this machine's paths: rewrite them in the page before each capture */
const mask = () =>
  page.evaluate((root) => {
    const home = root.split("/").slice(0, 3).join("/");
    const fix = (t) =>
      t
        .replaceAll(`${root}/app/tests/.out/wiki-media`, "~/Practicals/Practical 2")
        .replaceAll(`${root}/demo/submissions`, "~/Practicals/Practical 2/submissions")
        .replaceAll(`${root}/demo/exam.json`, "~/Practicals/Practical 2/exam.json")
        .replaceAll(`${root}/app/tests/.out/wiki-media/slides`, "~/Practicals/Slides")
        .replaceAll(`${root}/images`, "~/Practicals/Slides")
        .replaceAll(root, "~/Practicals")
        .replaceAll(home, "~")
        .replace(/~\/…\/wiki-media\//g, "~/…/Practical 2/");
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (n.nodeValue && n.nodeValue !== fix(n.nodeValue)) n.nodeValue = fix(n.nodeValue);
    for (const el of document.querySelectorAll("input")) if (el.value !== fix(el.value)) el.value = fix(el.value);
  }, ROOT);
async function shot(name, target, { pad: p = 0, jpeg = name.endsWith(".jpg") } = {}) {
  if (!wanted(name)) return;
  await cursor(false);
  await mask();
  const file = path.join(OUT, name);
  const opts = { path: file, ...(jpeg ? { type: "jpeg", quality: 82 } : {}) };
  if (!target) await page.screenshot(opts);
  else if (typeof target === "string") {
    if (p) await page.screenshot({ ...opts, clip: pad(await page.locator(target).first().boundingBox(), p) });
    else await page.locator(target).first().screenshot(opts);
  } else await page.screenshot({ ...opts, clip: target });
  await cursor(true);
  made.push(`${name} ${(fs.statSync(file).size / 1e3).toFixed(0)} kB`);
  console.log("made", made.at(-1));
}
/** record a GIF, or (when it isn't wanted this run) just do the actions */
async function maybeGif(name, opts, fn) {
  if (wanted(name)) return recordGif(context, page, opts, fn);
  await fn();
  return { kb: 0, frames: 0 };
}
let mx = W / 2, my = H / 2;
async function glide(x, y, ms = 500) {
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
const key = async (k, after = 450) => (await page.keyboard.press(k), wait(after));
async function typeSlow(t) {
  for (const ch of t) await page.keyboard.type(ch), await wait(55);
}

// ---- set up a session: this is also the "New grading session" screenshot ----
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
// a slides folder with just the exam's slides keeps the screenshot readable
const SLIDES = path.join(WORK, "slides");
fs.mkdirSync(SLIDES, { recursive: true });
for (const f of fs.readdirSync(path.join(ROOT, "images")))
  if (/VMS(109|133)\b/.test(f)) fs.symlinkSync(path.join(ROOT, "images", f), path.join(SLIDES, f));
await dialog(SLIDES);
await page.locator(".step").nth(2).getByRole("button").click();
await wait(600);
await dialog(path.join(WORK, "Practical 2.msgrade"));
await page.locator(".step").nth(3).getByRole("button").click();
await wait(300);
await shot("new-session.png", ".startup-card");
await page.getByText("Start grading →").click();
await page.locator(".topbar").waitFor();
await wait(2500);

// ---- grade a few clusters by hand so the screen shows correct, wrong and ungraded pins ----
await key("c", 900);
await key("w", 300);
await typeSlow("Neutrophil");
await key("Enter", 900);
await key("c", 900);
await key("w", 300);
await typeSlow("Lymphocyte");
await key("Enter", 900);
await page.evaluate(() => (window.__noKeys = true));
await key("h", 1500);
await shot("grading-overview.jpg");
await key("f", 1200);

// the grade menu, beside the current cluster
await key("Enter", 500);
const menu = await page.locator(".ctx-menu").boundingBox();
await shot("grade-menu.jpg", pad(menu, 90));
// the reason box with remembered reasons
await key("w", 500);
await shot("reason-box.jpg", pad(await page.locator(".ctx-menu").boundingBox(), 60));
await key("Escape", 200);
await key("Escape", 300);
// shortcuts sheet
await key("?", 500);
await shot("shortcuts.jpg", ".keysheet", { pad: 12 });
await key("?", 300);
// ledger
await page.locator(".ledger").getByText("All images", { exact: true }).click();
await wait(300);
await shot("ledger.png", ".ledger");
await page.locator(".ledger").getByText("All images", { exact: true }).click();
await page.evaluate(() => (window.__noKeys = false));

// ---- GIF: grade a cluster correct, the next one wrong with a reason ----
{
  const right = await page.locator(".right").boundingBox();
  const tb = await page.locator(".vtool").boundingBox();
  const crop = { x: 0, y: 44, width: right.x - 8, height: tb.y + tb.height + 8 - 44 };
  await page.evaluate((a) => (window.__keyAt = a), { x: 40, y: crop.y + crop.height - 120 });
  await glide(crop.width / 2 + 160, crop.height / 2 + 120, 200);
  const r = await maybeGif("grade-cluster.gif", { file: path.join(OUT, "grade-cluster.gif"), crop, work: WORK, width: 720 }, async () => {
    await wait(700);
    await key("c", 1500);
    await key("w", 600);
    await typeSlow("Eosinophil");
    await wait(400);
    await key("Enter", 1600);
    await key("c", 1400);
  });
  console.log("gif grade-cluster", r);
  made.push(`grade-cluster.gif ${r.kb} kB, ${r.frames} frames`);
  await page.evaluate(() => (window.__keyAt = undefined));
}

// ---- hand off: three people, then a drag ----
await page.getByRole("button", { name: "Hand off" }).click();
await page.locator(".handoff-modal").waitFor();
await page.locator(".ho-name").first().fill("Jamie");
await page.getByRole("button", { name: "+ Add grader" }).click();
await page.locator(".ho-name").nth(1).fill("Sam");
await page.getByRole("button", { name: "Split evenly" }).click();
await wait(400);
await page.mouse.move(5, 5);
await shot("handoff.png", ".handoff-modal");
await page.locator(".ho-twice-l input").check();
await wait(300);
await page.mouse.move(5, 5);
await shot("handoff-twice.png", ".handoff-modal");
await page.locator(".ho-twice-l input").uncheck();
{
  const m = await page.locator(".handoff-modal").boundingBox();
  const src = await page.locator('.ho-col[data-col="0"] .ho-card').first().boundingBox();
  const dst = await page.locator('.ho-col[data-col="1"]').boundingBox();
  mx = src.x + 40;
  my = src.y + 60;
  await page.mouse.move(mx, my);
  const r = await maybeGif("handoff-drag.gif", { file: path.join(OUT, "handoff-drag.gif"), crop: m, work: WORK, width: 640 }, async () => {
    await glide(src.x + 60, src.y + src.height / 2, 600);
    await wait(300);
    await page.mouse.down();
    await glide(src.x + 90, src.y + src.height / 2 + 8, 150);
    await glide(dst.x + dst.width / 2, dst.y + dst.height - 24, 900);
    await wait(250);
    await page.mouse.up();
    await wait(700);
  });
  made.push(`handoff-drag.gif ${r.kb} kB, ${r.frames} frames`);
}
await page.locator(".handoff-modal").getByRole("button", { name: "Close", exact: true }).click();

// ---- preferences: grading text (the in-page fallback of the Preferences window) ----
await page.locator('button[title="Preferences (⌘,)"]').click();
await wait(500);
await page.getByRole("button", { name: "Grading text" }).click();
await wait(400);
await page.mouse.move(5, 5);
await shot("prefs-text.png", ".modal-backdrop .modal");
await key("Escape", 400);

// ---- grade the rest (mostly correct, some wrong) so Export has real numbers ----
for (let i = 0; i < 2500; i++) {
  if (await page.locator(".done-banner").count()) break;
  if (await page.getByText("Nothing left on this image").count()) {
    await page.keyboard.press("Meta+ArrowRight");
    await wait(500);
    continue;
  }
  if (i % 5 === 3) {
    await page.keyboard.press("w");
    await wait(80);
    await page.keyboard.type(["Neutrophil", "Lymphocyte", "Fibroblast"][i % 3]);
    await page.keyboard.press("Enter");
  } else await page.keyboard.press("c");
  await wait(70);
}

// ---- export ----
await page.getByRole("button", { name: "Export" }).first().click();
await page.locator(".modal").waitFor();
await wait(500);
await page.mouse.move(5, 5);
await shot("export-csv.png", ".modal-backdrop .modal");
await page.getByRole("button", { name: "Statistics" }).click();
await wait(400);
await shot("export-stats.png", ".modal-backdrop .modal");
await key("Escape", 300);
if (await page.locator(".modal-backdrop").count()) await page.getByRole("button", { name: "Close", exact: true }).click();

// ---- disagreements: write a few into the session file, reopen, and show the window ----
await page.locator('button[title="Save and close session"]').click();
await page.locator(".startup").waitFor();
{
  const file = path.join(WORK, "Practical 2.msgrade");
  const s = JSON.parse(fs.readFileSync(file, "utf8"));
  const g = s.grades;
  const pick = (taskId, n) => Object.values(g.groups).filter((x) => x.taskId === taskId).flatMap((x) => x.pinIds).slice(0, n);
  const now = Date.now();
  const add = (ids, taskId, a, b) => {
    for (const id of ids) {
      const gid = g.pinGroup[id];
      delete g.pinGroup[id];
      if (gid && g.groups[gid]) {
        g.groups[gid].pinIds = g.groups[gid].pinIds.filter((x) => x !== id);
        if (!g.groups[gid].pinIds.length) delete g.groups[gid];
      }
      g.checks ??= {};
      g.checks[id] = { taskId, graders: [a.by, b.by], verdicts: [{ ...a, at: now }, { ...b, at: now }], state: "conflict" };
    }
  };
  const tasks = [...new Set(Object.values(g.groups).map((x) => x.taskId))];
  add(pick(tasks[0], 12), tasks[0], { by: "Jamie", status: "correct", text: "" }, { by: "Sam", status: "wrong", text: "Neutrophil" });
  add(pick(tasks[1], 4), tasks[1], { by: "Jamie", status: "wrong", text: "Lymphocyte" }, { by: "Sam", status: "wrong", text: "Plasma cell" });
  add(pick(tasks[2], 2), tasks[2], { by: "@host", status: "correct", text: "" }, { by: "Jamie", status: "wrong", text: "Mast cell" });
  // some agreements too, so the agreement table has numbers
  for (const id of pick(tasks[3], 30)) g.checks[id] = { taskId: tasks[3], graders: ["Jamie", "Sam"], verdicts: [{ by: "Jamie", status: "correct", text: "", at: now }, { by: "Sam", status: "correct", text: "", at: now }], state: "agreed" };
  for (const id of pick(tasks[4], 20)) g.checks[id] = { taskId: tasks[4], graders: ["@host", "Jamie"], verdicts: [{ by: "@host", status: "correct", text: "", at: now }, { by: "Jamie", status: "correct", text: "", at: now }], state: "agreed" };
  fs.writeFileSync(file, JSON.stringify(s));
}
await dialog(path.join(WORK, "Practical 2.msgrade"));
await page.getByRole("button", { name: "Open session…" }).click();
await page.locator(".topbar").waitFor();
await wait(1500);
await page.locator(".conflicts-btn").click();
await page.locator(".conflicts-modal").waitFor();
await wait(300);
await page.mouse.move(5, 5);
await shot("disagreements.png", ".conflicts-modal");
await page.getByRole("button", { name: "Done" }).click();
await page.locator('button[title="Save and close session"]').click();
await page.locator(".startup").waitFor();

// ---- start screen with the session under Resume ----
await wait(500);
await shot("start.png", ".startup-card");

console.log(made.join("\n"));
await browser.close();
tiles.stop();
process.exit(0);
