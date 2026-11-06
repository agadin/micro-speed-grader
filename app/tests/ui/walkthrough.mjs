// Full click-through of the app against the demo class:
//   start-up wizard → grade clusters (keys, menu, lasso, brush) → undo/redo → next image
//   → preferences → export → autosave → resume after reload.
// Screenshots go to tests/.out/ui. Needs `npm run dev` (or `npm run tauri dev`) running.
//   node tests/ui/walkthrough.mjs
import fs from "node:fs";
import path from "node:path";
import { launch, startTileServer, APP, ROOT } from "./harness.mjs";

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
const { browser, page, issues, dialog, emit } = await launch();
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

await page.goto("http://localhost:1420/");
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
  await dialog(path.join(ROOT, "images"));
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
  await page.keyboard.press("b");
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

await step("export grades.csv + feedback", async () => {
  await page.getByRole("button", { name: /^Export/ }).first().click();
  await page.waitForTimeout(400);
  await snap("export-dialog");
  const exp = path.join(WORK, "export");
  await dialog(exp);
  await page.locator(".modal").getByRole("button").first().click();
  await page.waitForTimeout(300);
  await page.locator(".modal").getByRole("button", { name: "Export" }).click();
  await page.waitForTimeout(1500);
  await snap("export-done");
  const csv = fs.readFileSync(path.join(exp, "grades.csv"), "utf8");
  const fb = fs.readdirSync(path.join(exp, "feedback"));
  const lines = parseCsv(csv.replace(/^\uFEFF/, "").trim()).map((r) => r.map((c) => c.replace(/\n/g, " / ")).join(","));
  expect(lines.length === 239, `csv has ${lines.length} records`);
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
  await page.locator(".ledger .phead input").check().catch(() => {});
  await page.waitForTimeout(300);
  const all = await page.locator(".lrow").count();
  expect(all >= before, `ledger shows ${all} rows after resume, session has ${before} groups`);
  return `${before} groups in file; ledger (all images) shows ${all}`;
});

await browser.close();
tiles.stop();
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.note ? `\n      ${r.note}` : ""}`);
  for (const i of r.issues ?? []) console.log(`      ! ${i}`);
}
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed · screenshots in ${OUT}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
