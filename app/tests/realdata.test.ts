// Checks the app's readers against real course material when it's on this machine (it isn't in the
// repo: reference/exams/*.pdf and sample-data/<practical>/*.ndpa, the instructor's answer keys).
//   npm run test:real
// Skips (exit 0) when the material isn't there.
import "./setup-window";
import "./xml-parser";
import fs from "node:fs";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { parseQuestionsFromText } from "../src/lib/examParse";
import { scanSubmissions } from "../src/lib/loader";
import { parseNdpa } from "../src/lib/ndpa";


const ROOT = path.resolve("..");
const EXAMS = path.join(ROOT, "reference/exams");
const KEYS = path.join(ROOT, "sample-data");
let fails = 0;
const ok = (c: boolean, m: string) => {
  console.log(`${c ? "PASS" : "FAIL"} ${m}`);
  if (!c) fails++;
};
if (!fs.existsSync(EXAMS) || !fs.existsSync(KEYS)) {
  console.log("SKIP no real course material here (reference/exams, sample-data)");
  process.exit(0);
}

// the same line grouping the app's PDF reader uses (lib/exam.ts)
async function pdfText(file: string) {
  const doc = await getDocument({ data: new Uint8Array(fs.readFileSync(file)) }).promise;
  const lines: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const rows = new Map<number, { x: number; s: string }[]>();
    for (const it of content.items as { str: string; transform: number[] }[]) {
      if (!("str" in it)) continue;
      const y = Math.round(it.transform[5] / 2) * 2;
      rows.set(y, [...(rows.get(y) ?? []), { x: it.transform[4], s: it.str }]);
    }
    [...rows.entries()].sort((a, b) => b[0] - a[0]).forEach(([, row]) => lines.push(row.sort((a, b) => a.x - b.x).map((r) => r.s).join(" ")));
  }
  return lines.join("\n");
}

const io = {
  listFiles: async (dir: string) => {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith(".") || e.name === "__MACOSX") continue;
        const p = path.join(d, e.name);
        e.isDirectory() ? walk(p) : out.push(p);
      }
    };
    walk(dir);
    return out.sort();
  },
  readText: async (p: string) => fs.readFileSync(p, "utf8"),
};

const pairs = [
  ["PracticeExam1_Practical.pdf", "PracticeExamPractical1"],
  ["PracticeExam2_Practical.pdf", "PracticeExamPractical2"],
];
for (const [pdf, keyDir] of pairs) {
  const file = path.join(EXAMS, pdf);
  const keys = path.join(KEYS, keyDir);
  if (!fs.existsSync(file) || !fs.existsSync(keys)) continue;
  const qs = parseQuestionsFromText(await pdfText(file));
  const nums = qs.map((q) => q.num);
  const gaps = nums.length ? Array.from({ length: Math.max(...nums) }, (_, i) => i + 1).filter((n) => !nums.includes(n)) : [];
  ok(qs.length >= 10 && gaps.length === 0, `${pdf}: ${qs.length} questions read (Q${Math.min(...nums)}–Q${Math.max(...nums)})${gaps.length ? `, missing Q${gaps.join(", Q")}` : ""}`);
  const noSlide = qs.filter((q) => !q.slides.length).map((q) => `Q${q.num}`);
  ok(!noSlide.length, `${pdf}: every question names a slide${noSlide.length ? ` (not: ${noSlide.join(", ")})` : ""}`);
  const either = qs.filter((q) => q.slides.length > 1).map((q) => `Q${q.num} ${q.slides.join("/")}`);
  if (either.length) console.log(`      either-slide questions: ${either.join("; ")}`);

  // the instructor's key files, treated as one student's submission
  const keySlides = new Set(fs.readdirSync(keys).map((f) => f.match(/VMS\d+/)?.[0]).filter(Boolean) as string[]);
  const examSlides = new Set(qs.flatMap((q) => q.slides));
  // "either slide" questions only need a key on one of their slides
  const noKey = qs.filter((q) => !q.slides.some((sl) => keySlides.has(sl))).map((q) => `Q${q.num} ${q.slides.join("/")}`);
  const notInExam = [...keySlides].filter((s) => !examSlides.has(s));
  ok(!noKey.length, `${keyDir}: a key file for every question${noKey.length ? ` (none for ${noKey.join(", ")})` : ""}`);
  if (notInExam.length) console.log(`      key files for slides the exam doesn't use: ${notInExam.join(", ")}`);

  // every key file parses with the app's reader, and its pin titles name the exam's questions
  let pinsTotal = 0;
  const badFiles: string[] = [];
  const titleMiss: string[] = [];
  for (const f of fs.readdirSync(keys)) {
    try {
      const anns = parseNdpa(fs.readFileSync(path.join(keys, f), "utf8"));
      pinsTotal += anns.length;
      for (const a of anns) if (!/\bq(?:uestion)?\s*#?\s*\d+/i.test(a.title)) titleMiss.push(`${f}: “${a.title}”`);
    } catch (e) {
      badFiles.push(`${f}: ${e}`);
    }
  }
  ok(!badFiles.length, `${keyDir}: ${fs.readdirSync(keys).length} real NDP.view files parse${badFiles.length ? ` (failed: ${badFiles.join("; ")})` : ""}`);
  ok(pinsTotal >= qs.length * 0.8, `${keyDir}: ${pinsTotal} pins for ${qs.length} questions`);
  if (titleMiss.length) console.log(`      pin titles without a question number (${titleMiss.length}): ${titleMiss.slice(0, 5).join("; ")}${titleMiss.length > 5 ? "…" : ""}`);

  // the whole scan, as the app would run it on a class of one (the key as a student folder)
  const tmp = fs.mkdtempSync(path.join(path.resolve("tests/.out"), "real-"));
  const stu = path.join(tmp, "000000 - Key, Instructor");
  fs.mkdirSync(stu);
  for (const f of fs.readdirSync(keys)) fs.copyFileSync(path.join(keys, f), path.join(stu, f));
  const scan = await scanSubmissions(tmp, qs.map((q) => ({ ...q, include: true })), io);
  const answered = new Set(scan.pins.map((p) => p.q).filter((q) => q !== null));
  ok(answered.size >= qs.length * 0.9, `${keyDir}: the scan matches pins to ${answered.size} of ${qs.length} questions`);
  const kinds = scan.problems.reduce((m, p) => ((m[p.kind] = (m[p.kind] ?? 0) + 1), m), {} as Record<string, number>);
  console.log(`      things to check: ${scan.problems.length ? Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(", ") : "none"}`);
  for (const p of scan.problems.slice(0, 6)) console.log(`        ${p.kind}: ${p.file ?? ""} ${p.detail}`);
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(fails ? 1 : 0);
