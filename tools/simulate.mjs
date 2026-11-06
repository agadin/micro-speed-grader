#!/usr/bin/env node
/**
 * Generate a fake class of student submissions from an answer key, for demos.
 *
 *   node tools/simulate.mjs --key sample-data/PracticeExamPractical1 \
 *        --slides VMS146,VMS292 --students 200 --out demo --exam reference/exams/PracticeExam1_Practical.pdf
 *
 *   node tools/simulate.mjs --key demo-key --spec demo-key/demo.json --out demo
 *
 * Key: .ndpa files whose pins are titled "Q<n>". Several pins with the same
 * title = several acceptable answers. Pins titled "Q<n> wrong: <label>" are
 * places students wrongly answer; wrong clusters are built on them. "Q<n> cluster"
 * is a correct answer that is a safe spot for a big cluster (the other correct
 * pins of that question then get small clusters or stay alone).
 * --spec: JSON {name, questions:[{num, slides, prompt, profile}]} picks the
 * questions/prompts; profile = {sigmaUm, spread, wrong, random, missing (default 0), wrongMain, bigShare, spotSigmaUm};
 * "doubleRate" (default 0.01) = share of students per question with a duplicate pin;
 * "students" sets the class size.
 * Output:
 *   <out>/submissions/<student folder>/<slide>.ndpi.ndpa   (mock D2L layout)
 *   <out>/exam.json                                         (questions used)
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const args0 = process.argv.slice(2);
const SPEC = (() => {
  const i = args0.indexOf("--spec");
  return i >= 0 ? JSON.parse(fs.readFileSync(args0[i + 1], "utf8")) : null;
})();
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith("--") ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []),
);
const KEY = args.key ?? "sample-data/PracticeExamPractical1";
const SLIDES = (SPEC ? SPEC.questions.flatMap((q) => q.slides).join(",") : args.slides ?? "VMS146,VMS292").split(",").map((s) => s.trim().toUpperCase());
const N = Number(args.students ?? SPEC?.students ?? 200);
const OUT = args.out ?? "demo";
const SEED = Number(args.seed ?? 7);
// share of students per question who submit a second (duplicate) pin for it
const DOUBLE_RATE = Number(args.doubles ?? SPEC?.doubleRate ?? 0.01);

// ---------- seeded RNG ----------
let st = SEED >>> 0;
const rnd = () => {
  st = (st + 0x6d2b79f5) >>> 0;
  let t = st;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
const pick = (a) => a[Math.floor(rnd() * a.length)];
const shuffle = (a) => {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
};
const UM = 1000; // nm per µm

// ---------- read key ----------
const keyFiles = fs.statSync(KEY).isDirectory()
  ? fs.readdirSync(KEY).filter((f) => f.endsWith(".ndpa")).map((f) => path.join(KEY, f))
  : [KEY];
/** slide -> q -> [{x,y}] ; wrongSeeds: slide -> q -> [{x,y,label}] */
const key = new Map();
const wrongSeeds = new Map();
for (const f of keyFiles) {
  const slide = (path.basename(f).match(/VMS\d+/i) ?? [])[0]?.toUpperCase();
  if (!slide || !SLIDES.includes(slide)) continue;
  const xml = fs.readFileSync(f, "utf8");
  for (const vs of xml.split("<ndpviewstate").slice(1)) {
    const title = (vs.match(/<title>(.*?)<\/title>/) ?? [])[1] ?? "";
    const qm = title.trim().match(/^Q(\d+)(\s*(?:cluster|M))?$/i);
    const wm = title.trim().match(/^Q(\d+)\s+wrong\s*:?\s*(.*)$/i);
    const pm = vs.match(/<annotation[^>]*>\s*<x>(-?\d+)<\/x>\s*<y>(-?\d+)<\/y>/);
    if (!pm) continue;
    if (wm) {
      if (!wrongSeeds.has(slide)) wrongSeeds.set(slide, new Map());
      const m = wrongSeeds.get(slide), q = Number(wm[1]);
      m.set(q, [...(m.get(q) ?? []), { x: Number(pm[1]), y: Number(pm[2]), label: wm[2] }]);
      continue;
    }
    if (!qm) continue;
    const q = Number(qm[1]);
    if (SPEC && !SPEC.questions.some((sq) => sq.num === q && sq.slides.map((x) => x.toUpperCase()).includes(slide))) continue;
    if (!key.has(slide)) key.set(slide, new Map());
    const m = key.get(slide);
    m.set(q, [...(m.get(q) ?? []), { x: Number(pm[1]), y: Number(pm[2]), big: !!qm[2] }]);
  }
}
if (!key.size) throw new Error("No key pins found for slides " + SLIDES.join(","));

// ---------- students ----------
const FIRST = ["Ava","Liam","Noah","Emma","Mia","Ethan","Sofia","Lucas","Aria","Mateo","Zoe","Kai","Maya","Leo","Isla","Omar","Priya","Chen","Diego","Hana","Jonah","Lena","Ravi","Nina","Theo","Amara","Felix","Ines","Yusuf","Grace","Ivan","Selin","Arjun","Lucia","Malik","Elena","Kenji","Rosa","Tariq","Wen"];
const LAST = ["Nguyen","Patel","Garcia","Smith","Kim","Okafor","Rossi","Haddad","Johnson","Silva","Cohen","Tanaka","Brown","Mensah","Lopez","Ivanova","Shah","Martin","Ali","Novak","Reyes","Wang","Fischer","Diaz","Moreau","Khan","Larsen","Adeyemi","Park","Costa"];
const students = Array.from({ length: N }, (_, i) => {
  const first = pick(FIRST), last = pick(LAST);
  const id = String(1000000 + Math.floor(rnd() * 8999999));
  return { folder: `${id} - ${last}, ${first}`, answers: new Map() /* slide -> [{title,x,y}] */ };
});
const add = (stu, slide, title, x, y) => {
  if (!stu.answers.has(slide)) stu.answers.set(slide, []);
  stu.answers.get(slide).push({ title, x: Math.round(x), y: Math.round(y) });
};

const titleFor = (q) => {
  const r = rnd();
  if (r < 0.88) return `Q${q}`;
  if (r < 0.975) return pick([`q${q}`, `Q ${q}`, `Question ${q}`, `${q}`, `Q${q}.`, `q ${q}`]);
  return ""; // forgot to title it
};

// ---------- simulate each question ----------
const summary = [];
for (const [slide, qs] of key) {
  for (const [q, keyPins] of qs) {
    const order = shuffle(students);
    const prof = SPEC?.questions.find((sq) => sq.num === q)?.profile ?? {};
    const nMissing = Math.round(N * (prof.missing ?? 0)); // no-answer students (off by default)
    const nRandom = Math.round(N * (prof.random ?? 0.05));
    const nWrong = Math.round(N * (prof.wrong ?? 0.1));
    const sig = prof.sigmaUm; // spread of a correct cluster (µm); default 2-5
    let k = 0;
    const missing = order.slice(k, (k += nMissing));
    const random = order.slice(k, (k += nRandom));
    const wrong = order.slice(k, (k += nWrong));
    const correct = order.slice(k);

    // correct answers: each key pin gets a mode (first is always a big cluster)
    // spread (harder question): no dominant answer, students split across many spots
    const hasBig = keyPins.some((kp) => kp.big);
    const modes = keyPins.map((kp, i) =>
      hasBig
        ? kp.big ? "big" : pick(["medium", "small", "small", "alone", "alone"])
        : prof.spread ? pick(["medium", "medium", "small", "alone"]) : i === 0 ? "big" : pick(["big", "medium", "alone", "alone"]),
    );
    let weights = modes.map((m) =>
      m === "big" ? 0.6 + rnd() * 0.4 : m === "medium" ? 0.15 + rnd() * 0.2 : m === "small" ? 0.04 + rnd() * 0.05 : 0,
    );
    // bigShare: the "cluster" spots get this share of the correct answers; the rest spread evenly over the other spots
    if (hasBig && prof.bigShare != null) {
      const nb = keyPins.filter((kp) => kp.big).length, ns = keyPins.length - nb;
      keyPins.forEach((kp, i) => (modes[i] = kp.big ? "big" : "spot"));
      weights = keyPins.map((kp) => (kp.big ? prof.bigShare / nb : (1 - prof.bigShare) / ns) * (0.5 + rnd()));
    }
    const alone = modes.filter((m) => m === "alone").length;
    let pool = [...correct];
    keyPins.forEach((kp, i) => {
      if (modes[i] !== "alone") return;
      const n = 1 + (rnd() < 0.5 ? 1 : 0); // the key answer alone, maybe +1 nearby
      for (let j = 0; j < n && pool.length; j++) {
        const stu = pool.pop();
        add(stu, slide, titleFor(q), kp.x + gauss() * 3 * UM, kp.y + gauss() * 3 * UM);
      }
    });
    const wsum = weights.reduce((a, b) => a + b, 0) || 1;
    const total = pool.length;
    keyPins.forEach((kp, i) => {
      if (modes[i] === "alone") return;
      const n = Math.round((total * weights[i]) / wsum);
      const sigma = (modes[i] === "spot" && prof.spotSigmaUm != null ? prof.spotSigmaUm : sig ? sig * (0.7 + rnd() * 0.6) : 2 + rnd() * 3) * UM;
      for (let j = 0; j < n && pool.length; j++) {
        const stu = pool.pop();
        add(stu, slide, titleFor(q), kp.x + gauss() * sigma, kp.y + gauss() * sigma);
      }
    });
    while (pool.length) {
      const stu = pool.pop();
      const kp = keyPins[weights.indexOf(Math.max(...weights))];
      add(stu, slide, titleFor(q), kp.x + gauss() * (sig ?? 3) * UM, kp.y + gauss() * (sig ?? 3) * UM);
    }

    // wrong answers: on the key's "wrong" seeds when given, otherwise near the right area
    // profile.wrongMain: label of the most common mistake; its seeds get the first (biggest-ish) clusters
    const seeds = shuffle(wrongSeeds.get(slide)?.get(q) ?? []).sort(
      (a, b) => Number(!!prof.wrongMain && b.label.includes(prof.wrongMain)) - Number(!!prof.wrongMain && a.label.includes(prof.wrongMain)),
    );
    if (seeds.length) {
      const nClusters = Math.min(seeds.length, 2 + Math.floor(rnd() * 3) + (seeds.length > 8 ? 1 : 0));
      const loners = seeds.slice(nClusters, nClusters + 4);
      const inClusters = wrong.length - Math.min(loners.length, Math.floor(wrong.length / 4));
      const props = Array.from({ length: nClusters }, () => 0.2 + rnd());
      const psum = props.reduce((a, b) => a + b, 0);
      let wi = 0;
      props.forEach((p, ci) => {
        const s = seeds[ci];
        const n = ci === nClusters - 1 ? inClusters - wi : Math.round((inClusters * p) / psum);
        const sigma = (sig ? sig * 0.6 : 4 + rnd() * 3) * UM;
        for (let j = 0; j < n && wi < wrong.length; j++, wi++)
          add(wrong[wi], slide, titleFor(q), s.x + gauss() * sigma, s.y + gauss() * sigma);
      });
      for (let li = 0; wi < wrong.length; wi++, li++) {
        const s = loners[li % loners.length];
        add(wrong[wi], slide, titleFor(q), s.x + gauss() * 4 * UM, s.y + gauss() * 4 * UM);
      }
      summary.push({ slide, q, wrongSeeds: seeds.slice(0, nClusters).map((s) => s.label), loners: loners.map((s) => s.label) });
    } else {
    const nClusters = 2 + Math.floor(rnd() * 3);
    const props = Array.from({ length: nClusters }, () => 0.2 + rnd());
    const psum = props.reduce((a, b) => a + b, 0);
    let wi = 0;
    props.forEach((p, ci) => {
      const kp = pick(keyPins);
      const ang = rnd() * Math.PI * 2;
      const dist = (40 + rnd() * 260) * UM;
      const cx = kp.x + Math.cos(ang) * dist, cy = kp.y + Math.sin(ang) * dist;
      const n = ci === nClusters - 1 ? wrong.length - wi : Math.round((wrong.length * p) / psum);
      const sigma = (3 + rnd() * 4) * UM;
      for (let j = 0; j < n && wi < wrong.length; j++, wi++)
        add(wrong[wi], slide, titleFor(q), cx + gauss() * sigma, cy + gauss() * sigma);
    });
    }

    // random scatter
    for (const stu of random) {
      const kp = pick(keyPins);
      const ang = rnd() * Math.PI * 2;
      const dist = (60 + rnd() * 1200) * UM;
      add(stu, slide, titleFor(q), kp.x + Math.cos(ang) * dist, kp.y + Math.sin(ang) * dist);
    }
    summary.push({ slide, q, keyPins: keyPins.length, modes, missing: missing.length, random: nRandom, wrong: nWrong });
  }
}

// ---------- double-pin examples ----------
const allQs = [...key].flatMap(([slide, qs]) => [...qs.keys()].map((q) => ({ slide, q })));
// per question: ~DOUBLE_RATE of the students who answered drop a second pin, usually on a
// wrong spot (or somewhere else nearby when the key has none)
for (const { slide, q } of allQs) {
  const answered = students.filter((st) => (st.answers.get(slide) ?? []).some((a) => a.title.match(new RegExp(`\\b${q}\\b`))));
  const n = Math.max(1, Math.round(N * DOUBLE_RATE));
  const seeds = wrongSeeds.get(slide)?.get(q) ?? [];
  for (const stu of shuffle(answered).slice(0, n)) {
    const s = seeds.length ? pick(seeds) : null;
    const kp = pick(key.get(slide).get(q));
    const [x, y] = s
      ? [s.x + gauss() * 5 * UM, s.y + gauss() * 5 * UM]
      : [kp.x + (80 + rnd() * 100) * UM, kp.y - (60 + rnd() * 80) * UM];
    add(stu, slide, `Q${q}`, x, y);
    summary.push({ double: stu.folder, slide, q });
  }
}

// ---------- write ----------
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const subDir = path.join(OUT, "submissions");
fs.rmSync(subDir, { recursive: true, force: true });
for (const stu of students) {
  const dir = path.join(subDir, stu.folder);
  fs.mkdirSync(dir, { recursive: true });
  for (const [slide, anns] of stu.answers) {
    const blocks = shuffle(anns).map(
      (a, i) => `\t<ndpviewstate id="${i + 1}">
\t\t<title>${esc(a.title)}</title>
\t\t<details/>
\t\t<coordformat>nanometers</coordformat>
\t\t<lens>20.0</lens>
\t\t<x>${a.x}</x>
\t\t<y>${a.y}</y>
\t\t<z>0</z>
\t\t<showtitle>1</showtitle>
\t\t<showhistogram>0</showhistogram>
\t\t<showlineprofile>0</showlineprofile>
\t\t<annotation type="pin" displayname="AnnotatePin" color="#00ff00">
\t\t\t<x>${a.x}</x>
\t\t\t<y>${a.y}</y>
\t\t\t<icon>pingreen</icon>
\t\t\t<stricon>iconpingreen</stricon>
\t\t</annotation>
\t</ndpviewstate>`,
    );
    const xml = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<annotations>\n${blocks.join("\n")}\n</annotations>\n`;
    fs.writeFileSync(path.join(dir, `${slide}.ndpi.ndpa`), xml);
  }
}

// exam.json with prompts pulled from the PDF when available
let prompts = {};
if (args.exam) {
  try {
    const txt = execFileSync("pdftotext", [args.exam, "-"], { encoding: "utf8" }).replace(/\s+/g, " ");
    for (const part of txt.split(/(?=\bQ\d{1,3}\s*\.\s)/)) {
      const m = part.match(/^Q(\d{1,3})\s*\.\s*(.*)$/);
      if (m && !prompts[m[1]]) prompts[m[1]] = m[2].trim();
    }
  } catch {
    /* pdftotext missing: prompts stay blank */
  }
}
const questions = SPEC
  ? SPEC.questions.map(({ num, slides, prompt }) => ({ num, slides, prompt }))
  : allQs.map(({ slide, q }) => ({ num: q, slides: [slide], prompt: prompts[q] ?? "" })).sort((a, b) => a.num - b.num);
fs.writeFileSync(path.join(OUT, "exam.json"), JSON.stringify({ name: SPEC?.name ?? "Demo exam", questions }, null, 2));
console.log(JSON.stringify(summary, null, 1));
console.log(`Wrote ${N} students to ${subDir}`);
