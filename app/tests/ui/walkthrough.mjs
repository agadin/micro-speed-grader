// Full click-through of the app against the demo class:
//   start-up wizard → grade clusters (keys, menu, lasso, brush) → undo/redo → next image
//   → preferences → export → autosave → resume after reload.
// Screenshots go to tests/.out/ui. Needs `npm run dev` (or `npm run tauri dev`) running.
//   node tests/ui/walkthrough.mjs
import fs from "node:fs";
import path from "node:path";
import { launch, startTileServer, closeSession, openSession, pickTool, ringOf, APP, APP_URL, ROOT, SLIDES } from "./harness.mjs";

const OUT = path.join(APP, "tests/.out/ui");
const WORK = path.join(APP, "tests/.out/ui-work");
fs.rmSync(OUT, { recursive: true, force: true });
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(WORK, { recursive: true });
const SESSION = path.join(WORK, "demo.msgrade");

const results = [];
let shot = 0;
const tiles = await startTileServer();
const { browser, context, page, issues, dialog, emit } = await launch();
const snap = async (name) => {
  const f = path.join(OUT, `${String(++shot).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: f });
  return f;
};
async function step(name, fn) {
  const n0 = issues.length;
  try {
    const note = await fn();
    results.push({ name, ok: true, note: note ?? "" });
  } catch (e) {
    results.push({ name, ok: false, note: String(e.message ?? e).split("\n")[0] });
    await snap(`FAIL-${name.replace(/\W+/g, "_")}`).catch(() => {});
  }
  if (issues.length > n0) results.at(-1).issues = issues.slice(n0);
}
const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
function parseCsv(t) {
  const rows = [[]];
  let f = "", q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"' && t[i + 1] === '"') (f += '"'), i++;
      else if (c === '"') q = false;
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") rows.at(-1).push(f), (f = "");
    else if (c === "\n") rows.at(-1).push(f.replace(/\r$/, "")), (f = ""), rows.push([]);
    else f += c;
  }
  rows.at(-1).push(f);
  return rows;
}
const session = () => JSON.parse(fs.readFileSync(SESSION, "utf8"));
const groups = () => Object.values(session().grades.groups);
const viewer = () => page.locator(".viewer-overlay").boundingBox();
/** wait until OSD has drawn real tiles (canvas not blank) */
async function waitTiles() {
  await page.waitForTimeout(400);
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(600);
}
async function rightDrag(points, mods = [], button = "right") {
  for (const m of mods) await page.keyboard.down(m);
  await page.mouse.move(points[0][0], points[0][1]);
  await page.mouse.down({ button });
  for (const [x, y] of points.slice(1)) await page.mouse.move(x, y, { steps: 4 });
  await page.mouse.up({ button });
  for (const m of mods) await page.keyboard.up(m);
}

await page.goto(APP_URL);
await page.evaluate(() => localStorage.clear());
await page.reload();

await step("start-up screen", async () => {
  await page.getByText("New grading session…").waitFor({ timeout: 10000 });
  await snap("startup");
});

await step("wizard: exam, folders, save path", async () => {
  await page.getByText("New grading session…").click();
  await dialog(path.join(ROOT, "demo/exam.json"));
  await page.getByText("Choose exam PDF / JSON…").click();
  await page.waitForTimeout(500);
  await dialog(path.join(ROOT, "demo/submissions"));
  await page.locator(".step").nth(1).getByRole("button").click();
  await page.waitForTimeout(800);
  await dialog(SLIDES);
  await page.locator(".step").nth(2).getByRole("button").click();
  await page.waitForTimeout(800);
  await dialog(SESSION);
  await page.locator(".step").nth(3).getByRole("button").click();
  await page.waitForTimeout(300);
  await snap("wizard-filled");
  const text = await page.locator(".startup").innerText();
  expect(/238/.test(text), "wizard does not show 238 students");
  return text.match(/\d+ students?[^\n]*/)?.[0];
});

await step("start grading → Q1 on VMS109", async () => {
  await page.getByText("Start grading →").click();
  await page.locator(".topbar").waitFor({ timeout: 30000 });
  await waitTiles();
  await snap("grader-q1");
  const top = await page.locator(".topbar").innerText();
  const right = await page.locator(".right").innerText();
  expect(/\bQ1\b/.test(right), "right panel not on Question 1");
  expect(fs.existsSync(SESSION), "session file not saved on start");
  return right.match(/Cluster [A-Z]+[^\n]*\n[^\n]*/)?.[0]?.replace("\n", " · ") + " | " + top.replace(/\n/g, " ").slice(0, 80);
});

await step("C grades the highlighted cluster correct", async () => {
  const sel = parseInt(await page.locator(".selcount b").innerText());
  expect(sel > 0, "nothing selected for cluster A");
  await page.keyboard.press("c");
  await page.waitForTimeout(1200); // autosave debounce
  await snap("after-correct");
  const g = groups();
  expect(g.length === 1 && g[0].status === "correct" && g[0].pinIds.length === sel, `expected 1 correct group of ${sel}, got ${JSON.stringify(g.map((x) => [x.status, x.pinIds.length]))}`);
  expect((await page.locator(".lrow").count()) >= 1, "ledger row missing");
  return `${sel} pins graded correct; ledger rows: ${await page.locator(".lrow").count()}`;
});

await step("W opens the wrong menu; reason typed + Enter", async () => {
  await page.keyboard.press("]");
  await page.waitForTimeout(500);
  await page.keyboard.press("w");
  await page.locator(".ctx-title").waitFor({ timeout: 3000 });
  await page.keyboard.type("Eccrine sweat gland");
  await snap("wrong-menu");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
  const g = groups().find((x) => x.status === "wrong");
  expect(g && g.text === "Eccrine sweat gland", "wrong group with reason not saved");
  return `${g.pinIds.length} pins wrong: "${g.text}"`;
});

await step("wrong without reason is refused (reason required)", async () => {
  await page.keyboard.press("]");
  await page.waitForTimeout(400);
  await page.keyboard.press("w");
  await page.locator(".ctx-title").waitFor({ timeout: 3000 });
  const before = groups().length;
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  const stillOpen = await page.locator(".ctx-title").isVisible();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(900);
  expect(stillOpen && groups().length === before, "empty wrong reason was accepted");
});

await step("recent reason suggested in menu (1–9)", async () => {
  await page.keyboard.press("w");
  await page.locator(".ctx-title").waitFor({ timeout: 3000 });
  const sug = await page.locator(".ctx-suggest").allInnerTexts();
  await snap("suggestions");
  expect(sug.some((s) => /Eccrine/.test(s)), `suggestions: ${sug.join(" | ")}`);
  await page.keyboard.press("1"); // picking a suggestion saves it
  await page.waitForTimeout(1200);
  const n = groups().filter((g) => g.text === "Eccrine sweat gland").length;
  expect(n === 2, `expected 2 groups with the reason, got ${n}`);
  return sug.join(" | ");
});

await step("undo / redo", async () => {
  const n = groups().length;
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(1200);
  const a = groups().length;
  await page.keyboard.press("Meta+Shift+z");
  await page.waitForTimeout(1200);
  const b = groups().length;
  expect(a === n - 1 && b === n, `groups ${n} → undo ${a} → redo ${b}`);
  return `${n} → ${a} → ${b}`;
});

await step("lasso (right-drag) opens menu; X inverts; Esc closes", async () => {
  await page.keyboard.press("h"); // whole slide
  await waitTiles();
  // the uncovered part of the slide: below the top bar, left of the inspector, above the toolbar
  const top = (await page.locator(".topbar").boundingBox()).height;
  const rp = await page.locator(".right").boundingBox();
  const tb = await page.locator(".vtool").boundingBox();
  const cx = rp.x / 2, cy = (top + tb.y) / 2, r = Math.min(rp.x, tb.y - top) * 0.4;
  const pts = Array.from({ length: 24 }, (_, i) => [cx + r * Math.cos((i / 24) * 2 * Math.PI), cy + r * Math.sin((i / 24) * 2 * Math.PI)]);
  await rightDrag(pts);
  await page.waitForTimeout(300);
  const title = await page.locator(".ctx-title").innerText({ timeout: 3000 });
  await snap("lasso-menu");
  await page.keyboard.press("x");
  await page.waitForTimeout(200);
  const inv = await page.locator(".ctx-title").innerText();
  await page.keyboard.press("Escape");
  return `${title.replace(/\n/g, " ")} → inverted: ${inv.replace(/\n/g, " ")}`;
});

await step("⌘ + lasso adds to the selection (no menu)", async () => {
  await page.keyboard.press("]");
  await page.waitForTimeout(800);
  const before = parseInt(await page.locator(".selcount b").innerText());
  const top = (await page.locator(".topbar").boundingBox()).height;
  const rp = await page.locator(".right").boundingBox();
  const tb = await page.locator(".vtool").boundingBox();
  // a box over the left half of the uncovered slide
  const x0 = 20, x1 = rp.x - 20, y0 = top + 20, y1 = tb.y - 20;
  await rightDrag([[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0 + 2]], ["Meta"]);
  await page.waitForTimeout(300);
  const menu = await page.locator(".ctx-title").isVisible();
  const after = parseInt(await page.locator(".selcount b").innerText());
  expect(!menu, "menu opened");
  expect(after > before, `selection did not grow ${before} → ${after}`);
  return `selected ${before} → ${after}`;
});

await step("brush (B) paints a selection and opens menu", async () => {
  await page.keyboard.press("b");
  await page.keyboard.press("=");
  await page.keyboard.press("=");
  const rp2 = await page.locator(".right").boundingBox();
  const tb2 = await page.locator(".vtool").boundingBox();
  const y = (44 + tb2.y) / 2;
  await rightDrag(Array.from({ length: 12 }, (_, i) => [rp2.x * (0.15 + i * 0.06), y]));
  await page.waitForTimeout(300);
  const ok = await page.locator(".ctx-title").isVisible();
  const title = ok ? await page.locator(".ctx-title").innerText() : "(no menu — brush found no pins on that stroke)";
  await snap("brush-menu");
  await page.keyboard.press("Escape");
  await page.locator(".right .seg button", { hasText: "Lasso" }).click(); // B cycles lasso → brush → polygon
  return title.replace(/\n/g, " ");
});

await step("swapped buttons: left-drag lassos, right-drag pans", async () => {
  await emit("menu", "preferences");
  await page.getByRole("button", { name: "Mouse & keys" }).click();
  await page.getByRole("button", { name: "Left selects" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await page.keyboard.press("h");
  await waitTiles();
  const top = (await page.locator(".topbar").boundingBox()).height;
  const rp = await page.locator(".right").boundingBox();
  const tb = await page.locator(".vtool").boundingBox();
  const cx = rp.x / 2, cy = (top + tb.y) / 2, r = Math.min(rp.x, tb.y - top) * 0.4;
  const ring = Array.from({ length: 24 }, (_, i) => [cx + r * Math.cos((i / 24) * 2 * Math.PI), cy + r * Math.sin((i / 24) * 2 * Math.PI)]);
  // right-drag: the slide moves, nothing gets selected
  const navBox = () => page.evaluate(() => {
    const d = document.querySelector(".displayregion");
    return d ? d.getAttribute("style") : "";
  });
  const before = await navBox();
  await rightDrag([[cx, cy], [cx + 120, cy + 60]], [], "right");
  await page.waitForTimeout(400);
  const panned = (await navBox()) !== before;
  const menuAfterPan = await page.locator(".ctx-title").isVisible();
  // left-drag: lasso + menu
  await rightDrag(ring, [], "left");
  await page.waitForTimeout(300);
  const title = await page.locator(".ctx-title").innerText({ timeout: 3000 });
  await page.keyboard.press("Escape");
  // back to the standard layout for the rest of the run
  await emit("menu", "preferences");
  await page.getByRole("button", { name: "Mouse & keys" }).click();
  await page.getByRole("button", { name: "Left pans" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  expect(panned, "right-drag did not pan");
  expect(!menuAfterPan, "right-drag opened a menu");
  return `right-drag panned; left-drag: ${title.replace(/\n/g, " ")}`;
});

await step("drag cluster label moves it; drag knob resizes (reselects pins)", async () => {
  await page.keyboard.press("]");
  await page.waitForTimeout(900);
  const v = await viewer();
  const attr = async (n) => (await page.locator(".viewer-overlay").getAttribute(n)).split(",").map(Number);
  const before = parseInt(await page.locator(".selcount b").innerText());
  const [kx, ky] = await attr("data-cluster-knob");
  await page.mouse.move(v.x + kx, v.y + ky);
  await page.mouse.down();
  await page.mouse.move(v.x + kx + 60, v.y + ky + 60, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const afterResize = parseInt(await page.locator(".selcount b").innerText());
  const [tx, ty] = await attr("data-cluster-tag");
  const [cx0] = await attr("data-cluster-ring");
  await page.mouse.move(v.x + tx, v.y + ty);
  await page.mouse.down();
  await page.mouse.move(v.x + tx + 120, v.y + ty + 40, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const afterMove = parseInt(await page.locator(".selcount b").innerText());
  const [cx1] = await attr("data-cluster-ring");
  // grabbing the ring between handles (45°) moves it too
  const [rx, ry, rr] = await attr("data-cluster-ring");
  const gx = v.x + rx - rr * Math.SQRT1_2, gy = v.y + ry + rr * Math.SQRT1_2;
  await page.mouse.move(gx, gy);
  await page.mouse.down();
  await page.mouse.move(gx - 50, gy + 30, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const [rx2, ry2, rr2] = await attr("data-cluster-ring");
  expect(Math.abs(rx2 - rx + 50) < 4 && Math.abs(ry2 - ry - 30) < 4 && Math.abs(rr2 - rr) < 2, `ring drag: (${rx},${ry},r${rr}) → (${rx2},${ry2},r${rr2})`);
  await snap("cluster-dragged");
  expect(Math.abs(cx1 - cx0 - 120) < 6, `tag drag moved the circle ${cx1 - cx0}px, expected 120`);
  expect(afterResize >= before, `resize grew selection? ${before} → ${afterResize}`);
  return `selected ${before} → resize ${afterResize} → move ${afterMove}`;
});

await step("S switches between clusters and single pins", async () => {
  const a = await page.locator(".cnav .cur").innerText();
  await page.keyboard.press("s");
  await page.waitForTimeout(600);
  const b = await page.locator(".cnav .cur").innerText();
  await snap("singles");
  await page.keyboard.press("s");
  await page.waitForTimeout(600);
  const c = await page.locator(".cnav .cur").innerText();
  expect(/Single pin/.test(b) && /Cluster/.test(c), `${a} → ${b} → ${c}`);
  return `${a.replace(/\n/g, " ")} → ${b.replace(/\n/g, " ")} → ${c.replace(/\n/g, " ")}`;
});

const ring = () => ringOf(page);
const tool = (name) => pickTool(page, name);
/** a second grader: open a hand-off pack from the start screen with the demo slides */
async function openPack(pack, saveAs) {
  await dialog(pack, SLIDES, saveAs);
  await page.getByRole("button", { name: "Got work from another grader?" }).click();
  await page.locator(".topbar").waitFor({ timeout: 30000 });
}

await step("polygon: right-click corners, Enter closes → grade menu", async () => {
  await page.keyboard.press("f");
  await page.waitForTimeout(900);
  await tool("Polygon");
  const c = await ring();
  const d = c.r * 1.3;
  for (const [dx, dy] of [[-d, -d], [d, -d], [d, d], [-d, d]]) {
    await page.mouse.click(c.x + dx, c.y + dy, { button: "right" });
    await page.waitForTimeout(80);
  }
  await snap("polygon-open");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  const title = await page.locator(".ctx-title").innerText({ timeout: 3000 });
  await snap("polygon-menu");
  await page.keyboard.press("Escape");
  await tool("Lasso");
  return title.replace(/\n/g, " ");
});

await step("paint with pins hidden: Space, brush, Space → C grades painted ✓ / rest ✗ (one undo)", async () => {
  const cur0 = await page.locator(".cnav .cur").innerText();
  await tool("Brush");
  const c = await ring(); // the ring isn't drawn while pins are hidden
  await page.keyboard.press(" ");
  await page.waitForTimeout(150);
  const hiddenHint = await page.locator(".paint-hint").innerText();
  // paint across the left half of the cluster
  await rightDrag(Array.from({ length: 8 }, (_, i) => [c.x - c.r + (i * c.r) / 7, c.y]));
  await page.waitForTimeout(150);
  await snap("paint-hidden");
  await page.keyboard.press(" ");
  await page.waitForTimeout(200);
  const hint = await page.locator(".paint-hint").innerText();
  const [painted, rest] = (hint.match(/\d+/g) ?? []).map(Number);
  await snap("paint-shown");
  await page.keyboard.press("c");
  await page.waitForTimeout(300);
  const reasonBox = await page.locator(".ctx-entry input").isVisible();
  const leaked = await page.locator(".ctx-entry input").inputValue();
  await snap("paint-reason");
  await page.keyboard.type("Dermal collagen");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  const hintGone = !(await page.locator(".paint-hint").isVisible());
  const cur1 = await page.locator(".cnav .cur").innerText();
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(400);
  const cur2 = await page.locator(".cnav .cur").innerText();
  await tool("Lasso");
  expect(/paint the structure/.test(hiddenHint), `hidden hint: ${hiddenHint}`);
  expect(painted + rest > 0, `hint after showing: ${hint}`);
  expect(reasonBox, "C should open a reason box for the rest of the cluster");
  expect(leaked === "", `reason box starts with "${leaked}"`);
    expect(hintGone && cur1 !== cur0, `C did not grade (${cur0} → ${cur1})`);
  expect(cur2 === cur0, `one undo should restore the cluster: ${cur0} vs ${cur2}`);
  return `${painted} painted ✓, ${rest} rest ✗; undo restored "${cur0.replace(/\n/g, " ")}"`;
});

await step("pin by pin: O shows one pin; C grades it and advances", async () => {
  await page.keyboard.press("o");
  await page.waitForTimeout(500);
  const a = await page.locator(".cnav .cur").innerText();
  const sel = await page.locator(".selcount b").innerText();
  await snap("pin-by-pin");
  await page.keyboard.press("c");
  await page.waitForTimeout(400);
  const b = await page.locator(".cnav .cur").innerText();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(200);
  const c = await page.locator(".cnav .cur").innerText();
  await page.keyboard.press("Meta+z");
  await page.keyboard.press("o");
  await page.waitForTimeout(400);
  const n = (t) => Number(t.match(/(\d+) left/)?.[1]);
  expect(/^Pin \d+ of \d+/.test(a) && sel === "1", `pin mode: ${a} / ${sel} selected`);
  expect(n(b) === n(a) - 1, `C should advance: ${a} → ${b}`);
  expect(c !== b, `→ should step: ${b} → ${c}`);
  return [a, b, c].map((t) => t.replace(/\n/g, " ")).join(" → ");
});

await step("Preferences → Selection: list switches toggle tools", async () => {
  await emit("menu", "preferences");
  await page.getByRole("button", { name: "Selection" }).click();
  const cards = await page.locator(".sel-row").count();
  await page.waitForTimeout(600); // let the demos load
  await snap("prefs-selection");
  await page.locator(".sel-row", { hasText: "Polygon" }).click();
  await page.locator(".sel-row", { hasText: "Polygon" }).locator("input.switch").uncheck();
  await page.getByRole("button", { name: "Done" }).click();
  const hasPoly = await page.locator(".right .seg button", { hasText: "Polygon" }).count();
  await emit("menu", "preferences");
  await page.getByRole("button", { name: "Selection" }).click();
  await page.locator(".sel-row", { hasText: "Polygon" }).locator("input.switch").check();
  await page.getByRole("button", { name: "Done" }).click();
  expect(cards === 9, `${cards} method rows`);
  expect(hasPoly === 0, "disabled Polygon still in the tool switcher");
  return `${cards} rows; polygon toggled off and on`;
});

await step("Not sure (host): off by default; turned on, it sets pins aside until the end of the image", async () => {
  const notSure = page.locator(".vgrade").getByRole("button", { name: /Not sure/ });
  expect((await notSure.count()) === 0, "Not sure button shows for the host by default");
  expect((await page.locator(".vgrade .btn.bad").innerText()).trim().startsWith("Wrong") && !(await page.locator(".vgrade .btn.bad").innerText()).includes("…"), "Wrong button still has dots");
  await emit("menu", "preferences");
  await page.getByRole("button", { name: "Selection" }).click();
  await page.locator(".sel-row", { hasText: "Not sure button" }).click();
  await page.locator(".sel-row", { hasText: "Not sure button" }).locator("input.switch").check();
  await page.waitForTimeout(200);
  await snap("prefs-not-sure");
  await page.getByRole("button", { name: "Done" }).click();
  const before = await page.locator(".cnav .cur").innerText();
  const n = Number(await page.locator(".selcount b").innerText());
  await notSure.click();
  await page.waitForTimeout(400);
  const banner = await page.locator(".handoff-banner").innerText();
  const after = await page.locator(".cnav .cur").innerText();
  await snap("not-sure-host");
  expect(/set aside/.test(banner) && banner.includes(String(n)), `banner: ${banner}`);
  expect(after !== before, `the set-aside cluster is still current: ${before} → ${after}`);
  await page.getByRole("button", { name: "Bring back now" }).click();
  await page.waitForTimeout(300);
  expect((await page.locator(".handoff-banner").count()) === 0, "Bring back now left the banner");
  await emit("menu", "preferences");
  await page.getByRole("button", { name: "Selection" }).click();
  await page.locator(".sel-row", { hasText: "Not sure button" }).locator("input.switch").uncheck();
  await page.getByRole("button", { name: "Done" }).click();
  return `${n} pins set aside (${before.replace(/\n/g, " ")} → ${after.replace(/\n/g, " ")}), brought back`;
});

await step("key hints collapsed by default; ? expands", async () => {
  const collapsed = !(await page.locator(".keysheet").isVisible());
  await page.keyboard.press("?");
  await page.waitForTimeout(200);
  const open = await page.locator(".keysheet").isVisible();
  await snap("key-hints-open");
  await page.locator(".keys-toggle").click();
  expect(collapsed && open, `collapsed=${collapsed} open=${open}`);
});

await step("Space hides pins, M toggles minimap", async () => {
  await page.keyboard.press("Space");
  await page.waitForTimeout(300);
  await snap("pins-hidden");
  const hidden = !(await page.locator(".right input[type=checkbox]").first().isChecked());
  await page.keyboard.press("Space");
  await page.keyboard.press("m");
  await page.waitForTimeout(300);
  const mini = await page.locator(".right input[type=checkbox]").nth(1).isChecked();
  await page.keyboard.press("m");
  expect(hidden, "Space did not hide pins");
  return `pins hidden: ${hidden}; minimap after M: ${mini}`;
});

await step("pin text: student names", async () => {
  await page.locator(".right .seg button", { hasText: "Student" }).click();
  await page.keyboard.press("]");
  await page.waitForTimeout(800);
  await snap("labels-student");
  await page.locator(".right .seg button", { hasText: "Hidden" }).click();
});

await step("next image ⌘→ goes to Q2", async () => {
  await page.keyboard.press("Meta+ArrowRight");
  await waitTiles();
  await snap("grader-q2");
  const right = await page.locator(".right").innerText();
  expect(/\bQ2\b/.test(right), "not on Question 2");
  return right.match(/Cluster [A-Z]+[^\n]*\n[^\n]*/)?.[0]?.replace("\n", " · ");
});

await step("Q3 / Q4 / Q5 on VMS133 load", async () => {
  const notes = [];
  for (const q of [3, 4, 5]) {
    await page.keyboard.press("Meta+ArrowRight");
    await waitTiles();
    await snap(`grader-q${q}`);
    const right = await page.locator(".right").innerText();
    expect(new RegExp(`\\bQ${q}\\b`).test(right), `not on Question ${q}`);
    notes.push(`Q${q}: ${right.match(/\d+ clusters · \d+ single pins left/)?.[0]}`);
  }
  return notes.join("; ");
});

await step("Preferences from the app menu", async () => {
  await emit("menu", "preferences");
  await page.getByText("Preferences").first().waitFor({ timeout: 3000 });
  await snap("preferences");
  await page.getByRole("button", { name: "Done" }).click();
});

await step("export grades.csv (item columns) + feedback; statistics tab saves item-stats.csv", async () => {
  await page.getByRole("button", { name: /^Export/ }).first().click();
  await page.waitForTimeout(400);
  await snap("export-dialog");
  const exp = path.join(WORK, "export");
  await dialog(exp);
  await page.locator(".modal").getByRole("button", { name: "Choose…" }).click();
  await page.waitForTimeout(300);
  await page.locator(".modal").getByRole("button", { name: "Export grades.csv" }).click();
  await page.waitForTimeout(1500);
  await snap("export-done");
  await page.locator(".modal").getByRole("button", { name: "Statistics" }).click();
  await page.waitForTimeout(200);
  await page.locator(".modal").getByRole("button", { name: "Count ungraded as wrong" }).click();
  await page.waitForTimeout(200);
  await snap("export-stats");
  const kr = await page.locator(".kr.big b").innerText();
  await page.locator(".modal").getByRole("button", { name: "Save item-stats.csv" }).click();
  await page.waitForTimeout(500);
  const statsCsv = fs.readFileSync(path.join(exp, "item-stats.csv"), "utf8");
  expect(/KR-20,/.test(statsCsv) && /^Q1,/m.test(statsCsv), "item-stats.csv has KR-20 and per-question rows");
  expect(/Discrimination \(D\)/.test(statsCsv) && /SEM \(points\)/.test(statsCsv) && /^Question,Grade,Feedback,Students/m.test(statsCsv), "item-stats.csv has D, SEM and feedback");
  expect((await page.locator(".qsum tbody tr").count()) > 0, "answers and feedback table shown");
  expect(/^-?\d\.\d\d$/.test(kr), `provisional KR-20 shown: ${kr}`);
  const csv = fs.readFileSync(path.join(exp, "grades.csv"), "utf8");
  const fb = fs.readdirSync(path.join(exp, "feedback"));
  const lines = parseCsv(csv.replace(/^\uFEFF/, "").trim()).map((r) => r.map((c) => c.replace(/\n/g, " / ")).join(","));
  expect(lines.length === 239, `csv has ${lines.length} records`);
  expect(/^UID,Surname,First_name,Number_of_correct_answers,Total_questions_asked,Comment,Q\d/.test(lines[0]), `header: ${lines[0]}`);
  const graded = groups()[0].pinIds;
  const s = session();
  const stu = s.students.find((x) => x.id === s.pins.find((p) => p.id === graded[0]).studentId);
  const one = fs.readFileSync(path.join(exp, "feedback", fb.find((f) => f.includes(stu.name ?? stu.folder?.split(" - ")[1] ?? "")) ?? fb[0]), "utf8");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Close" }).click().catch(() => {});
  return `${lines.length - 1} rows, ${fb.length} feedback files. Header: ${lines[0]} | e.g. ${lines[1]}\n      feedback: ${one.replace(/\n/g, " / ")}`;
});

await step("autosave + resume after reload", async () => {
  const before = groups().length;
  await page.reload();
  await page.locator(".startup").waitFor({ timeout: 10000 });
  await snap("startup-recent");
  await page.locator(".startup button.link").first().click();
  await page.locator(".topbar").waitFor({ timeout: 30000 });
  await waitTiles();
  await snap("resumed");
  const rows = await page.locator(".lrow").count();
  await page.locator(".ledger .phead input[type=checkbox]").check().catch(() => {});
  await page.waitForTimeout(300);
  const all = await page.locator(".lrow").count();
  expect(all >= before, `ledger shows ${all} rows after resume, session has ${before} groups`);
  return `${before} groups in file; ledger (all images) shows ${all}`;
});


await step("hand off: host splits work, guest grades the pack, host merges results", async () => {
  const PACK = path.join(WORK, "jamie.msgpack");
  const GUEST = path.join(WORK, "jamie.msgrade");
  const RESULT = path.join(WORK, "jamie.msgresult");
  page.on("dialog", (d) => d.accept().catch(() => {}));
  // host: split
  await page.getByRole("button", { name: "Hand off" }).click();
  await page.locator(".handoff-modal").waitFor();
  await page.locator(".ho-name").first().fill("Jamie");
  // more graders: add one, split three ways, check, then help, then back to one grader
  await page.getByRole("button", { name: "+ Add grader" }).click();
  await page.locator(".ho-name").nth(1).fill("Sam");
  await page.getByRole("button", { name: "Split evenly" }).click();
  const colCounts = await page.locator(".ho-col").evaluateAll((cs) => cs.map((c) => c.querySelectorAll(".ho-card").length));
  const createLabel = await page.getByRole("button", { name: /Create/ }).innerText();
  await snap("handoff-three-way");
  expect(colCounts.length === 3 && colCounts.every((n) => n > 0) && /Create 2 packs/.test(createLabel), `three-way split: ${colCounts} / ${createLabel}`);
  // drag a card from You onto Sam's column
  const before = colCounts;
  const src = await page.locator('.ho-col[data-col="0"] .ho-card').first().boundingBox();
  const dst = await page.locator('.ho-col[data-col="2"]').boundingBox();
  await page.mouse.move(src.x + 20, src.y + 10);
  await page.mouse.down();
  await page.mouse.move(src.x + 60, src.y + 20, { steps: 4 });
  await page.mouse.move(dst.x + dst.width / 2, dst.y + dst.height - 10, { steps: 8 });
  await page.mouse.up();
  const afterDrag = await page.locator(".ho-col").evaluateAll((cs) => cs.map((c) => c.querySelectorAll(".ho-card").length));
  expect(afterDrag[0] === before[0] - 1 && afterDrag[2] === before[2] + 1, `drag didn't move the card: ${before} → ${afterDrag}`);
  await page.locator(".ho-help").click();
  await page.locator(".help-panel").waitFor();
  await page.waitForTimeout(400);
  await snap("handoff-help");
  expect((await page.locator(".help-panel").innerText()).includes("Add grader"), "help panel missing hand-off topic");
  await page.keyboard.press("Escape");
  expect((await page.locator(".help-panel").count()) === 0, "Esc didn't close help");
  // percentages: give yourself 0% → your column empties, and the other two shares rise to 100 between them
  await page.locator(".ho-chip.you .ho-pct input").fill("0");
  await page.waitForTimeout(200);
  const mine = await page.locator('.ho-col[data-col="0"] .ho-card').count();
  const pcts = await page.locator(".ho-pct input").evaluateAll((xs) => xs.map((x) => Number(x.value)));
  expect(mine === 0 && pcts[0] === 0 && pcts[1] + pcts[2] === 100, `0% for you: ${mine} cards left, shares ${pcts}`);
  await page.locator(".ho-chip.you .ho-pct input").fill("34");
  await page.getByRole("button", { name: "Remove Sam" }).click();
  await page.getByRole("button", { name: "Keep all" }).click();
  const card = page.locator(".ho-col.you .ho-card").last();
  const cardLabel = await card.locator(".ho-l").innerText();
  await card.click();
  await page.waitForTimeout(250);
  await snap("handoff-split");
  const n = parseInt(await page.locator('.ho-col[data-col="1"] .ho-card .ho-n').first().innerText());
  await dialog(PACK);
  await page.getByRole("button", { name: /Create pack/ }).click();
  await page.locator(".handoff-modal .ok-text").waitFor({ timeout: 5000 });
  await page.waitForTimeout(900);
  expect(fs.existsSync(PACK), "pack file not written");
  const hs = session().handoffs ?? [];
  expect(hs.length === 1 && hs[0].status === "out" && hs[0].pinIds.length === n, `handoff not recorded: ${JSON.stringify(hs.map((h) => [h.status, h.pinIds.length]))}`);
  await page.locator(".handoff-modal").getByRole("button", { name: "Close", exact: true }).click();
  const opts = await page.locator(".topbar select option").allInnerTexts();
  expect(opts.some((o) => o.includes("→ Jamie")), "task list doesn't show the handed-off image");

  // guest: open the pack, grade everything, send results
  await closeSession(page);
  await openPack(PACK, GUEST);
  await waitTiles();
  const gopts = await page.locator(".topbar select option").allInnerTexts();
  expect(gopts.length === 1 && cardLabel.startsWith(gopts[0].split(" (")[0].trim()), `guest sees ${gopts.join(" | ")} (expected ${cardLabel})`);
  const sendBtn = page.getByRole("button", { name: /Send results/ }).first();
  expect((await sendBtn.innerText()).includes(`0/${n}`), `guest progress: ${await sendBtn.innerText()}`);
  // not sure: leave the cluster for the host from the grade menu, then take it back
  await page.keyboard.press("Enter");
  await page.locator(".ctx-menu").waitFor();
  await page.waitForTimeout(200);
  await snap("handoff-guest-leave-menu");
  const leaveItem = page.locator(".ctx-menu").getByText("Not sure: leave for host");
  expect((await leaveItem.count()) === 1, "no 'Not sure: leave for host' in the guest's grade menu");
  await leaveItem.click();
  await page.waitForTimeout(300);
  const leftN = parseInt((await sendBtn.innerText()).match(/(\d+)\//)[1]);
  await snap("handoff-guest-left");
  expect(leftN > 0 && (await page.locator(".handoff-banner").innerText()).includes("left for the host"), `leaving pins for the host: ${await sendBtn.innerText()}`);
  await page.getByRole("button", { name: "Take back" }).click();
  await page.waitForTimeout(300);
  expect((await sendBtn.innerText()).includes(`0/${n}`), `take back: ${await sendBtn.innerText()}`);
  // the same from the toolbar button between Correct and Wrong, undone with ⌘Z
  const notSure = page.locator(".vgrade").getByRole("button", { name: /Not sure/ });
  await notSure.click();
  await page.waitForTimeout(300);
  await snap("handoff-guest-not-sure-button");
  expect(!(await sendBtn.innerText()).includes(`0/${n}`), `toolbar Not sure did nothing: ${await sendBtn.innerText()}`);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  await page.waitForTimeout(300);
  expect((await sendBtn.innerText()).includes(`0/${n}`), `undo after Not sure: ${await sendBtn.innerText()}`);
  for (let i = 0; i < 400 && !(await sendBtn.innerText()).includes(`${n}/${n}`); i++) {
    await page.keyboard.press("c");
    await page.waitForTimeout(120);
  }
  await snap("handoff-guest-done");
  expect((await sendBtn.innerText()).includes(`${n}/${n}`), `guest couldn't finish: ${await sendBtn.innerText()}`);
  await dialog(RESULT);
  await sendBtn.click();
  await page.waitForTimeout(800);
  expect(fs.existsSync(RESULT), "results file not written");

  // host: reopen and merge
  await closeSession(page);
  await openSession(page, dialog, SESSION);
  await page.getByRole("button", { name: "Hand off" }).click();
  await dialog(RESULT);
  await page.getByRole("button", { name: "Import results…" }).click();
  await page.locator(".handoff-modal .ok-text").waitFor({ timeout: 5000 });
  const msg = await page.locator(".handoff-modal .ok-text").innerText();
  await snap("handoff-merged");
  await page.waitForTimeout(900);
  const after = session();
  const pack = after.handoffs[0];
  expect(pack.status === "returned" && pack.pinIds.every((id) => after.grades.pinGroup[id]), "pack pins not merged into host grades");
  await page.locator(".handoff-modal").getByRole("button", { name: "Close", exact: true }).click();
  return `${cardLabel}: ${n} pins handed to Jamie, graded, merged — "${msg}"`;
});

await step("grade twice: blind overlap with a guest, disagreements settled", async () => {
  const PACK = path.join(WORK, "kim.msgpack");
  const GUEST = path.join(WORK, "kim.msgrade");
  const RESULT = path.join(WORK, "kim.msgresult");
  const nothingLeft = () => page.getByText("Nothing left on this image").count();
  // host: one image to Kim, 15% of pins graded twice, host included
  await page.getByRole("button", { name: "Hand off" }).click();
  await page.locator(".handoff-modal").waitFor();
  await page.locator(".ho-name").first().fill("Kim");
  await page.getByRole("button", { name: "Keep all" }).click();
  const card = page.locator('.ho-col[data-col="0"] .ho-card').last();
  const label = (await card.locator(".ho-l").innerText()).trim();
  await card.click();
  await page.locator(".ho-twice-l input").check();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(600);
  await snap("twice-plan");
  await dialog(PACK);
  await page.getByRole("button", { name: /Create pack/ }).click();
  await page.locator(".handoff-modal .ok-text").waitFor({ timeout: 5000 });
  await page.waitForTimeout(900);
  const checks = Object.values(session().grades.checks ?? {});
  expect(checks.length > 0 && checks.every((c) => c.graders.includes("@host") && c.graders.includes("Kim") && c.state === "waiting"), `checks: ${checks.length}`);
  await page.locator(".handoff-modal").getByRole("button", { name: "Close", exact: true }).click();

  // host: on Kim's image only the overlap pins are open to the host; mark them all wrong
  const opts = await page.locator(".topbar select option").allInnerTexts();
  const idx = opts.findIndex((o) => o.startsWith(label));
  await page.locator(".topbar select").selectOption({ index: idx });
  await waitTiles();
  await page.keyboard.press("h");
  await page.waitForTimeout(900);
  await snap("twice-host-blind");
  await page.keyboard.press("f");
  await page.waitForTimeout(600);
  let hostGraded = 0;
  for (let i = 0; i < 80 && !(await nothingLeft()); i++) {
    const n = parseInt((await page.locator(".vtool").innerText()).match(/(\d+)\s*selected/)?.[1] ?? "0");
    await page.keyboard.press("w");
    await page.waitForTimeout(80);
    await page.keyboard.type("Neutrophil");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    hostGraded += n;
  }
  await page.waitForTimeout(900);
  const onKim = checks.filter((c) => c.taskId === session().handoffs.at(-1).taskIds[0]).length;
  expect(hostGraded > 0, `host graded ${hostGraded} overlap pins on ${label} (${onKim} planned there)`);

  // guest: grade everything correct, send results
  await closeSession(page);
  await openPack(PACK, GUEST);
  await waitTiles();
  const sendBtn = page.getByRole("button", { name: /Send results/ }).first();
  const total = (await sendBtn.innerText()).match(/\/(\d+)/)[1];
  for (let i = 0; i < 600 && !(await sendBtn.innerText()).includes(`${total}/${total}`); i++) {
    if (await nothingLeft()) await page.keyboard.press("Meta+ArrowRight"), await page.waitForTimeout(400);
    else await page.keyboard.press("c"), await page.waitForTimeout(110);
  }
  expect((await sendBtn.innerText()).includes(`${total}/${total}`), `guest couldn't finish: ${await sendBtn.innerText()}`);
  await dialog(RESULT);
  await sendBtn.click();
  await page.waitForTimeout(800);

  // host: import → disagreements → settle with Kim's grades
  await closeSession(page);
  await openSession(page, dialog, SESSION);
  await page.getByRole("button", { name: "Hand off" }).click();
  await dialog(RESULT);
  await page.getByRole("button", { name: "Import results…" }).click();
  await page.locator(".handoff-modal p.warn, .handoff-modal .ok-text").first().waitFor({ timeout: 5000 });
  const msg = await page.locator(".handoff-modal p.warn, .handoff-modal .ok-text").first().innerText();
  await snap("twice-imported");
  await page.locator(".handoff-modal").getByRole("button", { name: "Close", exact: true }).click();
  // show the flagged pins on Kim's image
  {
    const o = await page.locator(".topbar select option").allInnerTexts();
    await page.locator(".topbar select").selectOption({ index: o.findIndex((x) => x.startsWith(label)) });
    await waitTiles();
    await page.keyboard.press("h");
    await page.waitForTimeout(900);
    await snap("twice-flagged");
  }
  const btn = page.locator(".conflicts-btn");
  await btn.waitFor({ timeout: 3000 });
  const nConf = parseInt(await btn.locator("b").innerText());
  expect(nConf === hostGraded && /disagreement/.test(msg), `${nConf} disagreements for ${hostGraded} host-graded overlap pins; "${msg}"`);
  await btn.click();
  await page.locator(".conflicts-modal").waitFor();
  await snap("twice-disagreements");
  const stats = await page.locator(".cf-stats").innerText();
  // "Grade myself": the pins are shown selected on the slide
  await page.getByRole("button", { name: "Grade myself" }).first().click();
  await page.waitForTimeout(1200);
  await snap("twice-grade-myself");
  expect((await page.locator(".vtool").innerText()).includes(`${nConf} selected`), "Grade myself didn't select the pins");
  await page.locator(".conflicts-btn").click();
  await page.locator(".conflicts-modal").waitFor();
  for (let i = 0; i < 20 && (await page.locator(".cf-v", { hasText: "Kim" }).count()); i++) await page.locator(".cf-v", { hasText: "Kim" }).first().click();
  await page.getByRole("button", { name: "Done" }).click();
  await page.waitForTimeout(900);
  await page.locator(".ledger").getByText("All images", { exact: true }).click();
  await page.waitForTimeout(300);
  await snap("twice-settled");
  await page.locator(".ledger").getByText("All images", { exact: true }).click();
  const left = Object.values(session().grades.checks).filter((c) => c.state === "conflict").length;
  expect(left === 0 && (await btn.count()) === 0, `${left} disagreements left after settling`);
  return `${checks.length} pins graded twice; host marked ${hostGraded} wrong on ${label}, Kim correct → ${nConf} disagreements, settled. ${stats.split("\n").slice(-1)[0]}`;
});

await step("answer key: paint a correct and a wrong area, apply to ungraded, hand off only the rest", async () => {
  const KEYFILE = path.join(WORK, "practical.msgkey");
  await page.locator(".topbar select").selectOption({ index: 0 });
  await waitTiles();
  const before = session();
  const ungradedHere = (sess) => sess.pins.filter((p) => p.slide === "VMS109" && (p.q === 1 || p.candidates.includes(1)) && !sess.grades.pinGroup[p.id]).length;
  const u0 = ungradedHere(before);
  // open the editor, lasso the current cluster as the right answer
  await page.getByRole("button", { name: /Answer key/ }).click();
  await page.locator(".key-panel").waitFor();
  await tool("Lasso");
  await page.keyboard.press("f");
  await page.waitForTimeout(900);
  const loop = (c, k = 1.25) => Array.from({ length: 25 }, (_, i) => [c.x + c.r * k * Math.cos((i / 24) * 2 * Math.PI), c.y + c.r * k * Math.sin((i / 24) * 2 * Math.PI)]);
  let c = await ring();
  await rightDrag(loop(c));
  await page.waitForTimeout(300);
  const inside = parseInt(await page.locator(".key-new-n b").innerText());
  expect(inside > 0, `painted area has ${inside} pins`);
  await snap("key-paint");
  await page.keyboard.press("c");
  await page.waitForTimeout(300);
  // next cluster: a common wrong answer with a reason
  await page.keyboard.press("]");
  await page.waitForTimeout(900);
  c = await ring();
  await rightDrag(loop(c));
  await page.waitForTimeout(300);
  await page.keyboard.press("w");
  await page.keyboard.type("Eccrine sweat gland");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  const marks = await page.locator(".key-list li").count();
  expect(marks === 2, `${marks} areas on this image`);
  await snap("key-editor");
  // Done → what should it apply to? default: ungraded pins
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.locator(".key-apply-modal").waitFor();
  await snap("key-apply");
  const chosen = await page.locator(".ka-choice.on b").innerText();
  const btn = await page.locator(".key-apply-modal .primary").innerText();
  await page.locator(".key-apply-modal .primary").click();
  await page.waitForTimeout(900);
  const after = session();
  const byKey = Object.values(after.grades.groups).filter((g) => g.by === "@key");
  const keyed = byKey.reduce((a, g) => a + g.pinIds.length, 0);
  expect(chosen === "Ungraded pins" && keyed > 0 && byKey.some((g) => g.status === "wrong" && g.text === "Eccrine sweat gland"), `"${chosen}" → ${btn}: ${keyed} pins graded by the key`);
  expect(ungradedHere(after) === u0 - keyed, `ungraded here ${u0} → ${ungradedHere(after)} (key graded ${keyed})`);
  const ledger = await page.locator(".ledger").innerText();
  expect(ledger.includes("Answer key"), "ledger doesn't show Answer key");

  // hand off: this image only offers what the key didn't grade
  await page.getByRole("button", { name: "Hand off" }).click();
  await page.locator(".handoff-modal").waitFor();
  const card = page.locator(".ho-card", { hasText: "Q1 · VMS109" });
  const offered = (await card.count()) ? parseInt(await card.locator(".ho-n").innerText()) : 0;
  await page.locator(".handoff-modal").getByRole("button", { name: "Close", exact: true }).click();
  expect(offered > 0 && offered <= u0 - keyed, `hand-off offers ${offered} of the ${u0 - keyed} pins the key left`);

  // export the key, then rescan (nothing changed on disk)
  await page.getByRole("button", { name: /Answer key/ }).click();
  await dialog(KEYFILE);
  await page.getByRole("button", { name: "Export key…" }).click();
  await page.waitForTimeout(500);
  const kf = JSON.parse(fs.readFileSync(KEYFILE, "utf8"));
  expect(kf.kind === "msg-key" && kf.marks.length === 2, `key file has ${kf.marks?.length} areas`);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Not now" }).click();
  await page.locator(".right .rescan").click();
  await page.locator(".notice-banner").filter({ hasText: "Rescan" }).waitFor({ timeout: 15000 });
  const note = await page.locator(".notice-banner").innerText();
  // on screen, not hidden under the top bar
  const nb = await page.locator(".notice-banner").boundingBox();
  const tb = await page.locator(".topbar").boundingBox();
  expect(nb.y >= tb.y + tb.height, `notice at y=${nb.y} is under the top bar (ends ${tb.y + tb.height})`);
  expect(/no new or changed submissions/.test(note), `rescan said: ${note}`);
  return `${inside} pins in the first area; key graded ${keyed} (${byKey.length} groups); hand-off offers ${offered}; rescan: "${note.split("\n")[0]}"`;
});

await step("rescan a changed folder: late student, moved pin, removed pin → Changed submissions review", async () => {
  // work on a copy of the submissions (demo/ is shared): reopen the session pointed at the copy
  const SUBS = path.join(WORK, "submissions");
  fs.cpSync(path.join(ROOT, "demo/submissions"), SUBS, { recursive: true });
  await page.waitForTimeout(1500); // let the last autosave land
  await page.reload();
  await page.locator(".startup").waitFor({ timeout: 10000 });
  const s0 = session();
  fs.writeFileSync(SESSION, JSON.stringify({ ...s0, submissionsDir: SUBS }));
  await page.locator(".startup button.link").first().click();
  await page.locator(".topbar").waitFor({ timeout: 30000 });
  await waitTiles();

  // two students whose one Q1 pin on VMS109 you graded: one moves it, one takes it out
  const g = s0.grades;
  const folderOf = new Map(s0.students.map((x) => [x.id, x.folder]));
  const q1 = s0.pins.filter((p) => p.slide === "VMS109" && (p.q ?? g.assign[p.id]) === 1);
  const count = new Map();
  for (const p of q1) count.set(p.studentId, (count.get(p.studentId) ?? 0) + 1);
  const mine = q1.filter((p) => count.get(p.studentId) === 1 && g.pinGroup[p.id] && !g.groups[g.pinGroup[p.id]].by);
  expect(mine.length >= 2, `${mine.length} pins you graded to change`);
  const [moved, removed] = mine;
  const fileOf = (p) => path.join(SUBS, folderOf.get(p.studentId), "VMS109.ndpi.ndpa");
  const edit = (p, fn) => {
    const f = fileOf(p);
    const parts = fs.readFileSync(f, "utf8").split(/(?=<ndpviewstate)/);
    const i = parts.findIndex((b) => b.includes(`<x>${p.xNm}</x>`) && b.includes(`<title>${p.rawTitle}</title>`));
    expect(i > 0, `pin ${p.id} not found in ${f}`);
    parts[i] = fn(parts[i]);
    fs.writeFileSync(f, parts.join(""));
  };
  edit(moved, (b) => b.replaceAll(`<x>${moved.xNm}</x>`, `<x>${moved.xNm + 400000}</x>`));
  edit(removed, (b) => (b.trimEnd().endsWith("</annotations>") ? "</annotations>\n" : ""));
  const lateFrom = folderOf.get(s0.pins[0].studentId);
  fs.cpSync(path.join(SUBS, lateFrom), path.join(SUBS, "9999999 - Late, Lou"), { recursive: true });

  await page.locator(".right .rescan").click();
  await page.locator(".notice-banner").filter({ hasText: "Rescan:" }).waitFor({ timeout: 15000 });
  const note = (await page.locator(".notice-banner").innerText()).split("\n")[0];
  expect(/1 new student/.test(note) && /1 changed/.test(note) && /1 removed/.test(note), `rescan said: ${note}`);
  await page.waitForTimeout(1200); // autosave
  const s1 = session();
  const retired = new Map((s1.retired ?? []).map((r) => [r.pin.id, r]));
  expect(retired.has(moved.id) && retired.has(removed.id) && !s1.pins.some((p) => p.id === moved.id || p.id === removed.id), "old pins not retired");
  const repl = retired.get(moved.id).replacedBy;
  expect(repl && s1.pins.some((p) => p.id === repl) && !retired.get(removed.id).replacedBy, "moved pin not linked to its new pin");
  expect(retired.get(moved.id).grade?.status === g.groups[g.pinGroup[moved.id]].status, "retired pin lost its grade");
  const btn = page.locator(".topbar .changes-btn");
  expect((await btn.innerText()).includes("2"), `top bar: ${await btn.innerText()}`);

  // Review → the dialog, grouped by question
  await page.locator(".notice-banner").getByRole("button", { name: "Review" }).click();
  await page.locator(".changes-modal").waitFor();
  const shotPath = await snap("changed-submissions");
  const rows = page.locator(".changes-modal .ch-row");
  expect((await rows.count()) === 2, `${await rows.count()} rows`);
  const dlg = await page.locator(".changes-modal").innerText();
  expect(/Q1/.test(dlg) && /was/i.test(dlg) && /no longer in the files/.test(dlg), `dialog: ${dlg.slice(0, 200)}`);

  // Grade myself: jumps to the new pin, selected (with its ↻ badge)
  await page.locator(`.ch-row[data-pin="${repl}"]`).getByRole("button", { name: "Grade myself" }).click();
  await page.waitForTimeout(900);
  const sel = await page.evaluate(() => document.querySelector(".changes-modal") === null);
  expect(sel, "dialog didn't close");
  await snap("changed-new-pin");

  // carry the grade over, restore the removed pin; both rows go, then undo the restore
  await btn.click();
  await page.locator(".changes-modal").waitFor();
  await page.locator(`.ch-row[data-pin="${repl}"]`).getByRole("button", { name: "Carry grade over" }).click();
  await page.locator(`.ch-row[data-pin="${removed.id}"]`).getByRole("button", { name: "Restore" }).click();
  await page.locator(".changes-modal .ex-empty").waitFor({ timeout: 3000 });
  await page.locator(".changes-modal").getByRole("button", { name: "Done" }).click();
  await page.waitForTimeout(1200);
  const s2 = session();
  const ng = s2.grades.groups[s2.grades.pinGroup[repl]];
  const og = g.groups[g.pinGroup[moved.id]];
  expect(ng && ng.status === og.status && ng.text === og.text, "grade not carried over");
  expect(s2.pins.some((p) => p.id === removed.id && p.restored) && s2.grades.pinGroup[removed.id], "removed pin not restored with its grade");
  expect((await btn.count()) === 0, "Changed submissions button still showing");
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(1200);
  const s3 = session();
  expect(!s3.pins.some((p) => p.id === removed.id) && (await btn.count()) === 1, "undo didn't bring the removed pin's row back");
  return `${note} · screenshot ${path.basename(shotPath)}`;
});

await step("ruler: R, drag a distance, click an outline; nothing is graded", async () => {
  const before = JSON.stringify(session().grades);
  await page.keyboard.press("r");
  await page.locator(".ruler-box.on").waitFor({ timeout: 2000 });
  const v = await viewer();
  const cx = v.x + v.width * 0.45, cy = v.y + v.height * 0.45;
  // a distance: drag with the selecting button
  await rightDrag([[cx - 120, cy], [cx + 120, cy]]);
  await page.waitForTimeout(200);
  expect((await page.locator(".ruler-n").innerText()) === "1", "no distance measured");
  // an area: click four corners, then the first again
  const click = async (x, y) => {
    await page.mouse.move(x, y);
    await page.mouse.down({ button: "right" });
    await page.mouse.up({ button: "right" });
    await page.waitForTimeout(400); // not a double-click
  };
  for (const [x, y] of [[cx - 60, cy + 40], [cx + 60, cy + 40], [cx + 60, cy + 140], [cx - 60, cy + 140], [cx - 60, cy + 40]]) await click(x, y);
  expect((await page.locator(".ruler-n").innerText()) === "2", `outline not measured: ${await page.locator(".ruler-n").innerText()}`);
  await page.mouse.move(cx, cy - 150);
  await snap("ruler");
  expect(JSON.stringify(session().grades) === before && !(await page.locator(".ctx-menu").count()), "measuring changed grades or opened the grade menu");
  await page.keyboard.press("Backspace");
  expect((await page.locator(".ruler-n").innerText()) === "1", "⌫ didn't remove the last measurement");
  await page.keyboard.press("Escape");
  expect((await page.locator(".ruler-n").count()) === 0, "Esc didn't clear");
  await page.keyboard.press("Escape");
  expect((await page.locator(".ruler-box.on").count()) === 0, "Esc didn't switch the ruler off");
  return "distance + outline measured, ⌫ / Esc / Esc";
});

await step("help: styled tooltip → ? → article; help search; preferences search and About", async () => {
  // hover a control: the app's own tooltip (not the native one) with a ? to its article
  const exportBtn = page.locator(".topbar").getByRole("button", { name: "Export" });
  await exportBtn.hover();
  await page.locator(".tip").waitFor({ timeout: 3000 });
  const tipText = await page.locator(".tip-text").innerText();
  expect(/grades\.csv/.test(tipText), `tooltip text: ${tipText}`);
  expect((await exportBtn.getAttribute("title")) === null, "native title not suppressed while hovering");
  await snap("help-tooltip");
  // travel to the ? like a person: from the button, across whatever lies between, at a normal speed
  const from = await exportBtn.boundingBox();
  const q = await page.locator(".tip-help").boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  const steps = 14;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await page.mouse.move(from.x + from.width / 2 + (q.x + q.width / 2 - from.x - from.width / 2) * t, from.y + from.height / 2 + (q.y + q.height / 2 - from.y - from.height / 2) * t);
    await page.waitForTimeout(25);
  }
  expect((await page.locator(".tip-help").count()) === 1, "tooltip closed on the way to its ?");
  await page.mouse.down();
  await page.mouse.up();
  await page.locator(".help-panel").waitFor({ timeout: 3000 });
  const art = await page.locator(".help-panel .hp-article").innerText();
  expect(art.startsWith("Exporting grades"), `? opened: ${art.slice(0, 40)}`);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(500);
  expect((await exportBtn.getAttribute("title")) !== null, "title not restored after hover");
  // search the wiki
  await page.locator(".help-panel .hp-search input").fill("kr-20");
  const hits = await page.locator(".help-panel .hp-hit").allInnerTexts();
  expect(hits.some((h) => h.includes("Exporting grades")), `search hits: ${hits.join(" | ")}`);
  await page.locator(".help-panel .hp-search input").fill("");
  await page.locator(".help-panel").getByRole("button", { name: "Help home" }).click();
  const topics = await page.locator(".help-panel .hp-topics button").count();
  await snap("help-home");
  expect(topics >= 9, `home lists ${topics} topics`);
  await page.locator(".help-panel").getByRole("button", { name: "Close help" }).click();

  // preferences: search a setting, land on its pane; About shows the version
  await page.locator('button[title="Preferences (⌘,)"]').click();
  await page.locator(".prefs-search input").waitFor();
  await page.locator(".prefs-search input").fill("radius");
  await page.locator(".prefs-results button", { hasText: "Cluster radius" }).click();
  const h2 = await page.locator(".prefs-content h2").innerText();
  expect(h2 === "Clusters & zoom", `search went to ${h2}`);
  // Reading submissions: changing a rule while the session is open reads the submissions again
  await page.locator(".prefs-nav button", { hasText: "Reading submissions" }).click();
  await snap("prefs-reading");
  const unl = page.locator(".prefs-content select").nth(2);
  await unl.selectOption("first");
  await page.locator(".notice-banner").filter({ hasText: "Submissions read again" }).waitFor({ timeout: 15000 });
  const reread = await page.locator(".notice-banner").innerText();
  expect(/before reading rules/.test(reread), `notice: ${reread}`);
  await unl.selectOption("all");
  await page.locator(".notice-banner").filter({ hasText: "Submissions read again" }).waitFor({ timeout: 15000 });
  await page.locator(".prefs-nav button", { hasText: "About" }).click();
  const about = await page.locator(".about").innerText();
  await snap("prefs-about");
  expect(/Version \d+\.\d+\.\d+/.test(about), `about: ${about.slice(0, 80)}`);
  await page.keyboard.press("Escape");
  return `tooltip "${tipText}" → ${art.split("\n")[0]}; ${hits.length} hits for kr-20; ${topics} topics`;
});

await step("ledger search + wrong only; student panel from a chip; regrade an answer; / finds a student", async () => {
  const ledger = page.locator(".ledger");
  await ledger.locator(".phead input[type=checkbox]").check();
  const total = await ledger.locator(".lrow").count();
  // search a wrong reason that's in the session
  const wrongs = groups().filter((g) => g.status === "wrong" && g.text.length > 3);
  expect(wrongs.length > 0, "no wrong grades with a reason to search for");
  const word = wrongs[0].text.slice(0, 4).toLowerCase();
  await ledger.locator(".lsearch input").fill(word);
  await ledger.locator(".lstatus button", { hasText: "Wrong only" }).click();
  await page.waitForTimeout(300);
  const shown = await ledger.locator(".lrow").count();
  const meta = await ledger.locator(".lmeta").innerText();
  expect(shown > 0 && shown < total, `filter shows ${shown} of ${total} rows`);
  expect(new RegExp(`^${shown} of ${total} groups`).test(meta), `header: ${meta}`);
  expect((await ledger.locator(".lrow .badge.ok").count()) === 0, "a correct row shows with Wrong only");
  const reasons = await ledger.locator(".lrow .reason").allInnerTexts();
  expect(reasons.every((r) => r.toLowerCase().includes(word)), `rows not matching "${word}": ${reasons.join(" | ")}`);
  await snap("ledger-filtered");

  // a student chip opens their answers at that question
  await ledger.locator(".lrow .caret").first().click();
  const chip = ledger.locator(".chip > span").first();
  const name = await chip.innerText();
  await chip.click();
  const panel = page.locator(".student-panel");
  await panel.waitFor({ timeout: 3000 });
  const card = panel.locator(".sv-q.focus");
  const q = Number(await card.getAttribute("data-q"));
  expect((await card.locator(".sv-label").innerText()) === "Wrong", `Q${q} card: ${await card.innerText()}`);
  const s0 = session();
  const stu = s0.students.find((s) => s.name === name);
  const pin = s0.pins.find((p) => p.studentId === stu.id && (p.q ?? s0.grades.assign[p.id]) === q);
  const before = s0.grades.groups[s0.grades.pinGroup[pin.id]];
  expect(before?.status === "wrong", `pin was ${before?.status}`);
  // Show lands on the pin
  await card.getByRole("button", { name: "Show" }).first().click();
  await page.waitForTimeout(800);
  expect((await page.locator(".vtool .selcount").innerText()).startsWith("1"), "Show didn't select the pin");
  // regrade correct: one undo step, saved to the session file
  await card.getByRole("button", { name: "Correct" }).click();
  await page.waitForTimeout(1200);
  const s1 = session();
  const after = s1.grades.groups[s1.grades.pinGroup[pin.id]];
  expect(after?.status === "correct" && after.pinIds.length === 1, `after regrade: ${JSON.stringify(after)}`);
  expect(s1.grades.groups[before.id]?.status === "wrong" || !s1.grades.groups[before.id], "the rest of the group changed");
  const label = await panel.locator(".sv-q.focus .sv-label").innerText();
  const score = await panel.locator(".sv-total").innerText();
  const fb = await panel.locator(".sv-fb pre").innerText();
  expect(label === "Correct" && fb.includes(`Q${q}: Correct`), `panel after regrade: ${label} / ${fb}`);
  await snap("student-view");
  // ⌘Z puts it back in one step
  await page.keyboard.press("ControlOrMeta+z");
  await page.waitForTimeout(1200);
  const s2 = session();
  expect(s2.grades.pinGroup[pin.id] === before.id, "undo didn't restore the old grade in one step");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await page.waitForTimeout(300);

  // Esc closes; / opens the search; a UID finds the student; ↵ opens them
  await page.keyboard.press("Escape");
  expect((await panel.count()) === 0, "Esc didn't close the student panel");
  await page.keyboard.press("/");
  await panel.locator(".sv-search input").waitFor({ timeout: 2000 });
  const uid = stu.folder.match(/\d{5,}/)?.[0] ?? stu.name;
  await page.keyboard.type(uid);
  await page.waitForTimeout(200);
  const hits = await panel.locator(".sv-hit").count();
  await page.keyboard.press("Enter");
  await panel.locator(".sv-who").waitFor({ timeout: 2000 });
  const who = await panel.locator(".sv-big").innerText();
  await panel.getByRole("button", { name: "Close" }).click();
  await ledger.getByRole("button", { name: "Clear" }).click();
  await ledger.locator(".phead input[type=checkbox]").uncheck();
  const back = await ledger.locator(".lmeta").innerText();
  expect(/groups ·/.test(back), `after Clear: ${back}`);
  return `"${word}" + Wrong only: ${meta}; ${name} Q${q} wrong → correct (${score}); "/" + ${uid}: ${hits} hit → ${who}`;
});

await step("wizard: things to check before Start", async () => {
  // a few demo students, each with something wrong (the last one is clean)
  const subs = path.join(ROOT, "demo/submissions");
  const fix = path.join(WORK, "problem-subs");
  const names = fs.readdirSync(subs).filter((f) => !f.startsWith(".")).slice(0, 9);
  for (const s of names) fs.cpSync(path.join(subs, s), path.join(fix, s), { recursive: true });
  const [noId, big, empty, wrongQ, other, broken, many] = names.map((s) => path.join(fix, s));
  fs.writeFileSync(path.join(noId, "my answers.ndpa"), fs.readFileSync(path.join(noId, "VMS109.ndpi.ndpa")));
  fs.writeFileSync(path.join(big, "VMS133.ndpi.ndpa"), "x".repeat(2 * 1024 * 1024 + 1));
  for (const f of fs.readdirSync(empty)) fs.rmSync(path.join(empty, f));
  fs.writeFileSync(path.join(empty, "answers.pdf"), "pdf");
  const v109 = path.join(wrongQ, "VMS109.ndpi.ndpa");
  fs.writeFileSync(v109, fs.readFileSync(v109, "utf8").replace(/<title>[^<]*<\/title>/, "<title>Q9</title>"));
  fs.rmSync(path.join(wrongQ, "VMS133.ndpi.ndpa"));
  fs.copyFileSync(path.join(other, "VMS109.ndpi.ndpa"), path.join(other, "VMS999.ndpi.ndpa"));
  fs.writeFileSync(path.join(broken, "VMS109.ndpi.ndpa"), "<annotations><ndpviewstate>");
  const pin = (i) => `<ndpviewstate id="${i}"><title>Q3</title><annotation type="pin"><x>${i * 1000}</x><y>0</y></annotation></ndpviewstate>`;
  fs.writeFileSync(path.join(many, "VMS133.ndpi.ndpa"), `<annotations>${Array.from({ length: 60 }, (_, i) => pin(i)).join("")}</annotations>`);

  await closeSession(page);
  await page.getByText("New grading session…").click();
  const needs0 = await page.locator(".start-needs").innerText();
  expect(/the exam/.test(needs0) && /submissions folder/.test(needs0) && /slides folder/.test(needs0), `before anything: ${needs0}`);
  await dialog(path.join(ROOT, "demo/exam.json"));
  await page.getByText("Choose exam PDF / JSON…").click();
  await page.waitForTimeout(400);
  await dialog(fix);
  await page.locator(".step").nth(1).getByRole("button", { name: "Choose folder…" }).click();
  await page.locator(".scan-row").waitFor({ timeout: 10000 });
  const row = await page.locator(".scan-row").innerText();
  expect(/8 things to check/.test(row), `row: ${row}`);
  const needs = await page.locator(".start-needs").innerText();
  expect(needs === "Still needed: the slides folder", `greyed-out Start says: ${needs}`);
  expect(await page.getByRole("button", { name: "Start grading →" }).isDisabled(), "Start enabled without slides");
  await snap("wizard-things-to-check");

  await page.locator(".scan-row").getByRole("button", { name: "Review" }).click();
  await page.locator(".scan-modal").waitFor();
  const kinds = await page.locator(".scan-modal .sp-group").evaluateAll((els) => els.map((e) => e.dataset.kind));
  const text = await page.locator(".scan-modal").innerText();
  await snap("things-to-check");
  expect(kinds.length === 8, `groups: ${kinds.join(", ")}`);
  expect(/Choose the slide each file is for/.test(text) && text.includes("my answers.ndpa") && text.includes("“Q9”"), "explanations or file names missing");
  // fix one in the app: the badly named file is for VMS109 (the file itself isn't changed)
  await page.locator('.scan-modal .sp-group[data-kind="no-slide-id"] select.sp-slide').selectOption("VMS109");
  await page.locator(".scan-modal .sp-fixed").waitFor({ timeout: 10000 });
  // the folder is read again with that choice
  await page.locator(".scan-modal .sp-counts", { hasText: "8 found" }).waitFor({ timeout: 10000 });
  expect((await page.locator('.scan-modal .sp-group[data-kind="no-slide-id"]').count()) === 0, "the fixed file is still listed");
  const counts1 = await page.locator(".scan-modal .sp-counts").innerText();
  expect(/8 found/.test(counts1) && /1 fixed/.test(counts1) && /7 left/.test(counts1), `after choosing a slide: ${counts1}`);
  expect(fs.existsSync(path.join(noId, "my answers.ndpa")), "the file was changed or removed");
  // acknowledge one, then everything left
  await page.locator('.scan-modal .sp-group[data-kind="unknown-question"]').getByRole("button", { name: "OK" }).click();
  const counts2 = await page.locator(".scan-modal .sp-counts").innerText();
  expect(/1 acknowledged/.test(counts2) && /6 left/.test(counts2), `after OK: ${counts2}`);
  await page.locator(".scan-modal").getByRole("button", { name: "Acknowledge all" }).click();
  const counts3 = await page.locator(".scan-modal .sp-counts").innerText();
  await snap("things-to-check-done");
  expect(/all checked/.test(counts3), `after Acknowledge all: ${counts3}`);
  await page.locator(".scan-modal").getByRole("button", { name: "Done" }).click();
  const row2 = await page.locator(".scan-row").innerText();
  expect(/All 8 checked/.test(row2), `wizard row: ${row2}`);
  // fixing it in the folder and checking again still works (the stray VMS999 file goes)
  fs.rmSync(path.join(other, "VMS999.ndpi.ndpa"));
  await page.locator(".scan-row").getByRole("button", { name: "Review" }).click();
  await page.locator(".scan-modal").getByRole("button", { name: "Check again" }).click();
  await page.locator(".scan-modal .sp-counts", { hasText: "7 found" }).waitFor({ timeout: 10000 });
  await page.locator(".scan-modal").getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Cancel" }).click();
  return `${row.replace(/\s+/g, " ")} → ${row2.replace(/\s+/g, " ")} · ${kinds.join(", ")} · "${needs}"`;
});

await step("exam editor: fix and add questions before starting; add a forgotten question inside a session", async () => {
  const EXAM = path.join(WORK, "edited-exam.json");
  // ---- in the wizard ----
  await page.locator(".startup").waitFor();
  await page.getByText("New grading session…").click();
  await dialog(path.join(ROOT, "demo/exam.json"));
  await page.getByText("Choose exam PDF / JSON…").click();
  await page.waitForTimeout(400);
  await dialog(SLIDES);
  await page.locator(".step").nth(2).getByRole("button").click();
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "Edit questions…" }).click();
  const ed = page.locator(".exam-editor");
  await ed.waitFor();
  expect((await ed.locator(".ee-list li").count()) === 5, "editor doesn't list the 5 questions read");
  // reword Q2, then add Q6 on VMS133 with the slide picker
  await ed.locator(".ee-list li").nth(1).click();
  await ed.locator("textarea").fill("Using VMS109, place a pin on white adipose tissue (reworded)");
  await ed.getByRole("button", { name: "+ Add question" }).click();
  await ed.locator(".ee-find input").fill("133");
  await ed.locator(".ee-tile", { hasText: "VMS133" }).click();
  await page.waitForTimeout(600); // thumbnails
  await snap("exam-editor-picker");
  await ed.getByRole("button", { name: "Done choosing" }).click();
  await ed.locator("textarea").fill("Using VMS133, place a pin on a mast cell");
  await ed.getByText("Mark its answer when grading starts").click();
  await snap("exam-editor");
  await dialog(EXAM);
  await ed.getByRole("button", { name: "Save as exam file…" }).click();
  await page.waitForTimeout(500);
  const saved = JSON.parse(fs.readFileSync(EXAM, "utf8"));
  expect(saved.questions.length === 6 && saved.questions[5].slides.join() === "VMS133" && /reworded/.test(saved.questions[1].prompt), `exam file: ${JSON.stringify(saved.questions.map((q) => [q.num, q.slides]))}`);
  await ed.getByRole("button", { name: "Use these questions" }).click();
  const table = await page.locator(".qtable tbody tr").count();
  expect(table === 6, `wizard shows ${table} questions`);
  await page.getByRole("button", { name: "Cancel" }).click();

  // ---- inside a session: add a forgotten question, review, apply ----
  await openSession(page, dialog, SESSION);
  const before = session();
  await page.locator(".right .ee-open").click();
  await ed.waitFor();
  expect(await ed.locator(".ee-risk").isVisible(), "no risk warning inside a session");
  expect(await ed.locator(".ee-list li").first().locator(".ee-n").innerText().then(() => ed.locator(".ee-num input").isDisabled()), "existing question numbers aren't locked");
  await ed.getByRole("button", { name: "+ Add question" }).click();
  await ed.locator(".ee-find input").fill("109");
  await ed.locator(".ee-tile", { hasText: "VMS109" }).click();
  await ed.getByRole("button", { name: "Done choosing" }).click();
  await ed.locator("textarea").fill("Using VMS109, place a pin on a hair follicle");
  await ed.getByRole("button", { name: "Review changes…" }).click();
  await ed.locator(".ee-review").waitFor({ timeout: 30000 });
  const changes = await ed.locator(".ee-changes").innerText();
  await snap("exam-editor-review");
  expect(/Q6/.test(changes) && /New question on VMS109/.test(changes), `review: ${changes}`);
  await ed.getByRole("button", { name: "Apply changes" }).click();
  await page.waitForTimeout(1200);
  const after = session();
  const copies = fs.readdirSync(path.dirname(SESSION)).filter((f) => f.includes("(before question edit"));
  expect(after.questions.length === before.questions.length + 1 && after.questions.some((q) => q.num === 6 && /hair follicle/.test(q.prompt)), `session questions: ${after.questions.map((q) => q.num)}`);
  expect(copies.length === 1, `backup copies: ${copies.join(", ")}`);
  const opts = await page.locator(".topbar select option").allInnerTexts();
  expect(opts.some((o) => o.startsWith("Q6 · VMS109")), "Q6 isn't in the image list");
  const note = await page.locator(".notice-banner").innerText();
  return `wizard: 5 → 6 questions, exam file saved; session: +Q6 on VMS109 (${changes.split("\n").length} change), backup ${copies[0]}; "${note.split("\n")[0].slice(0, 60)}…"`;
});

await step("export ▸ Time: grading time per question, grader and student; graders compared; time-stats.csv", async () => {
  const log = session().timeLog ?? [];
  expect(log.length > 10 && log.some((e) => e.by === "Jamie") && log.some((e) => e.by === "Kim"), `time log: ${log.length} actions, graders ${[...new Set(log.map((e) => e.by ?? "you"))]}`);
  await page.getByRole("button", { name: "Export" }).first().click();
  const m = page.locator(".export-modal");
  await m.waitFor();
  await m.getByRole("button", { name: "Time", exact: true }).click();
  const t = page.locator(".ex-time");
  await t.waitFor();
  const text = await t.innerText();
  await snap("export-time");
  expect(/Grading time/.test(text) && /By question/.test(text) && /By grader/.test(text) && /Jamie/.test(text) && /Kim/.test(text), "Time tab is missing tables or graders");
  expect(/time vs agreement/.test(text) && /You & Kim|Kim & You/.test(text), "no grade-twice comparison");
  const dir = await m.locator(".field.wide input").inputValue();
  await m.getByRole("button", { name: "Save time-stats.csv" }).click();
  await page.waitForTimeout(500);
  const csv = fs.readFileSync(path.join(dir, "time-stats.csv"), "utf8");
  expect(/Total active grading time/.test(csv) && /Seconds per pin/.test(csv), "time-stats.csv missing tables");
  await m.getByRole("button", { name: "Close", exact: true }).click();
  return `${log.length} actions; ${text.split("\n").slice(0, 3).join(" ").replace(/\s+/g, " ")}`;
});

await step("student panel: Copy puts the feedback on the clipboard", async () => {
  // the test browser only allows reading the clipboard when granted (Chromium); WebKit has no such permission
  try {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(APP_URL).origin });
  } catch (e) {
    return `skipped: this browser can't grant clipboard access (${String(e.message ?? e).split("\n")[0]})`;
  }
  await page.evaluate(() => navigator.clipboard.writeText("(nothing yet)"));
  await page.keyboard.press("Escape");
  await page.keyboard.press("/");
  const panel = page.locator(".student-panel");
  await panel.locator(".sv-search input").waitFor({ timeout: 2000 });
  await page.keyboard.press("Enter"); // the first student
  await panel.locator(".sv-who").waitFor({ timeout: 2000 });
  const shown = await panel.locator(".sv-fb pre").textContent();
  const btn = panel.locator(".sv-fb").getByRole("button", { name: "Copy" });
  await btn.click();
  await panel.locator(".sv-fb").getByRole("button", { name: "Copied" }).waitFor({ timeout: 2000 });
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  await panel.getByRole("button", { name: "Close" }).click();
  expect(shown.length > 20 && copied === shown, `copied ${JSON.stringify(copied.slice(0, 60))}, shown ${JSON.stringify(shown.slice(0, 60))}`);
  return `${copied.split("\n").length} lines copied, same as shown`;
});

await step("wizard: drag a question to renumber, mark its answer, start → answer key on that question", async () => {
  const EXAM = path.join(WORK, "renumbered-exam.json");
  const confirms = [];
  const onDialog = (d) => {
    confirms.push(d.message());
    d.accept().catch(() => {});
  };
  page.on("dialog", onDialog);
  try {
    await closeSession(page);
    await page.getByText("New grading session…").click();
    await dialog(path.join(ROOT, "demo/exam.json"));
    await page.getByText("Choose exam PDF / JSON…").click();
    await page.waitForTimeout(400);
    await dialog(path.join(ROOT, "demo/submissions"));
    await page.locator(".step").nth(1).getByRole("button", { name: "Choose folder…" }).click();
    await page.waitForTimeout(800);
    await dialog(SLIDES);
    await page.locator(".step").nth(2).getByRole("button", { name: "Choose folder…" }).click();
    await page.waitForTimeout(800);
    await dialog(path.join(WORK, "renumbered.msgrade"));
    await page.locator(".step").nth(3).getByRole("button").click();
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: "Edit questions…" }).click();
    const ed = page.locator(".exam-editor");
    await ed.waitFor();
    const items = ed.locator(".ee-list li");
    // Q5 (VMS133, toluidine blue): mark its answer, then drag it to the top
    await items.nth(4).click();
    await ed.getByText("Mark its answer when grading starts").click();
    const from = await items.nth(4).boundingBox();
    const to = await items.nth(0).boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 - 10, { steps: 3 });
    await page.mouse.move(to.x + to.width / 2, to.y + 4, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    const nums = await items.locator(".ee-n").allInnerTexts();
    const prompts = await items.locator(".ee-prompt").allInnerTexts();
    await snap("exam-editor-renumbered");
    expect(confirms.length === 1 && /renumbers/.test(confirms[0]), `confirm before renumbering: ${JSON.stringify(confirms)}`);
    expect(nums.join() === "Q1,Q2,Q3,Q4,Q5" && /toluidine/.test(prompts[0]) && /Pacinian/.test(prompts[1]), `after the drag: ${nums.map((n, i) => `${n} ${prompts[i].slice(0, 30)}`).join(" | ")}`);
    // the moved question (now Q1) is still the one whose answer is marked
    await items.nth(0).click();
    expect(await ed.getByLabel("Mark its answer when grading starts").isChecked(), "the mark didn't follow the question to its new number");
    // a second drag doesn't ask again
    const a = await items.nth(1).boundingBox();
    const b = await items.nth(2).boundingBox();
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2 + 10, { steps: 3 });
    await page.mouse.move(b.x + b.width / 2, b.y + b.height - 4, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    const prompts2 = await items.locator(".ee-prompt").allInnerTexts();
    expect(confirms.length === 1 && /white adipose/.test(prompts2[1]) && /Pacinian/.test(prompts2[2]), `second drag: ${prompts2.map((x) => x.slice(0, 25)).join(" | ")}`);
    await dialog(EXAM);
    await ed.getByRole("button", { name: "Save as exam file…" }).click();
    await page.waitForTimeout(500);
    const saved = JSON.parse(fs.readFileSync(EXAM, "utf8")).questions;
    expect(
      saved.map((q) => q.num).join() === "1,2,3,4,5" && /toluidine/.test(saved[0].prompt) && saved[0].slides.join() === "VMS133" && /white adipose/.test(saved[1].prompt) && /Pacinian/.test(saved[2].prompt),
      `exam file: ${saved.map((q) => `${q.num} ${q.prompt.slice(6, 30)}`).join(" | ")}`,
    );
    await ed.getByRole("button", { name: "Use these questions" }).click();
    await page.getByText("Start grading →").click();
    await page.locator(".topbar").waitFor({ timeout: 30000 });
    await page.locator(".key-panel").waitFor({ timeout: 5000 });
    await waitTiles();
    const cur = await page.locator(".topbar select").evaluate((s) => s.options[s.selectedIndex].text);
    await snap("marked-answer-on-start");
    expect(cur.startsWith("Q1 · VMS133"), `opened on ${cur}`);
    return `Q5 dragged to Q1 (one confirm), saved in the new order; started in the answer key on "${cur}"`;
  } finally {
    page.off("dialog", onDialog);
  }
});

await step("in-session edit: graded pins that now answer another question are ungraded; a copy is saved first", async () => {
  // back to the main session; Q1 moves from VMS109 to VMS133 and Q6 (added earlier) goes, so VMS109 is Q2's alone:
  // pins titled "Q1" there now answer Q2, and their Q1 grades no longer apply
  const onDialog = (d) => d.accept().catch(() => {});
  page.on("dialog", onDialog);
  try {
    await closeSession(page);
    await openSession(page, dialog, SESSION);
    await waitTiles();
    // an earlier step asked for a rescan: opening a session must not start another one by itself
    await page.waitForTimeout(1500);
    const notice = (await page.locator(".notice-banner").allInnerTexts()).join(" ");
    expect(!/Rescan|Reading the submissions folder/.test(notice), `opening the session started a rescan nobody asked for: ${notice}`);
    const before = session();
    await page.locator(".right .ee-open").click();
    const ed = page.locator(".exam-editor");
    await ed.waitFor();
    await ed.locator(".ee-list li", { hasText: "Q6" }).click();
    await ed.locator(".ee-del").click();
    await ed.locator(".ee-list li", { hasText: "Q1" }).click();
    await ed.getByRole("button", { name: "Remove VMS109" }).click();
    await ed.getByRole("button", { name: "Choose slide…" }).click();
    await ed.locator(".ee-find input").fill("133");
    await ed.locator(".ee-tile", { hasText: "VMS133" }).click();
    await ed.getByRole("button", { name: "Done choosing" }).click();
    await ed.getByRole("button", { name: "Review changes…" }).click();
    await ed.locator(".ee-review").waitFor({ timeout: 30000 });
    const changes = await ed.locator(".ee-changes").innerText();
    const impact = await ed.locator(".ee-impact").innerText();
    await snap("exam-editor-review-moves");
    const regraded = Number(impact.match(/(\d+)\s+graded pins? now answer a different question/)?.[1]);
    expect(/Q1 adds VMS133, drops VMS109/.test(changes) && /Q6 Removed/.test(changes), `changes: ${changes.replace(/\n/g, " | ")}`);
    if (!(regraded > 0)) {
      // keep what the editor saw, to find out why nothing moved
      fs.copyFileSync(SESSION, path.join(OUT, "in-session-edit-session.msgrade"));
      const q1 = Object.values(before.grades.groups).filter((g) => g.taskId.startsWith("Q1|")).flatMap((g) => g.pinIds);
      const pins = new Map(before.pins.map((p) => [p.id, p]));
      const sample = q1.slice(0, 4).map((id) => `${JSON.stringify(pins.get(id)?.rawTitle)} q=${pins.get(id)?.q} assign=${before.grades.assign[id]}`);
      throw new Error(`impact: ${impact.replace(/\n/g, " | ")} · rules ${JSON.stringify(before.readingRules)} · ${q1.length} Q1 grades, e.g. ${sample.join("; ")}`);
    }
    await ed.getByRole("button", { name: "Apply changes" }).click();
    await page.waitForTimeout(1500);
    const after = session();
    // every pin graded before whose question is now another one
    const qOf = (g, id) => Number(g.groups[g.pinGroup[id]].taskId.match(/^Q(\d+)/)[1]);
    const moved = after.pins.filter((p) => before.grades.pinGroup[p.id] && p.q !== null && p.q !== qOf(before.grades, p.id));
    expect(moved.length === regraded, `${moved.length} pins changed question, review said ${regraded}`);
    expect(moved.every((p) => !after.grades.pinGroup[p.id]), `${moved.filter((p) => after.grades.pinGroup[p.id]).length} of them are still graded`);
    expect(after.questions.find((q) => q.num === 1).slides.join() === "VMS133" && !after.questions.some((q) => q.num === 6), "questions not updated");
    const copies = fs.readdirSync(WORK).filter((f) => f.includes("(before question edit"));
    const copy = copies.map((f) => JSON.parse(fs.readFileSync(path.join(WORK, f), "utf8"))).find((c) => c.questions.some((q) => q.num === 6));
    expect(copy && copy.questions.find((q) => q.num === 1).slides.join() === "VMS109" && moved.every((p) => copy.grades.pinGroup[p.id]), "no copy of the session from just before the edit");
    return `${regraded} graded pins now answer another question and were ungraded; backup kept (${copies.length} cop${copies.length === 1 ? "y" : "ies"})`;
  } finally {
    page.off("dialog", onDialog);
  }
});

await browser.close();
tiles.stop();
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.note ? `\n      ${r.note}` : ""}`);
  for (const i of r.issues ?? []) console.log(`      ! ${i}`);
}
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed · screenshots in ${OUT}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
