// How the heavy operations hold up on a big class. Make one first (400 students on the real
// Practical 1: 32 questions, 30 slides, 12,000 files):
//   SL=$(ls sample-data/PracticeExamPractical1 | grep -o 'VMS[0-9]*' | sort -u | paste -sd, -)
//   node tools/simulate.mjs --key sample-data/PracticeExamPractical1 --slides "$SL" --students 400 \
//        --out app/tests/.out/scale --exam reference/exams/PracticeExam1_Practical.pdf
//   npm run test:scale
// Skips when there's no class at tests/.out/scale.
import "./setup-window";
import "./xml-parser";
import fs from "node:fs";
import path from "node:path";
import { scanSubmissions } from "../src/lib/loader";
import { buildTasks, feedbackText, pinsForTask, studentResults } from "../src/lib/grading";
import { computeClusters } from "../src/lib/cluster";
import { defaultSettings } from "../src/lib/settings";
import { exportTable, testStats } from "../src/lib/exportCsv";
import { emptyGrades, type Question, type Session } from "../src/lib/types";
import { applyPlan, emptyKey, newMark, planKey } from "../src/lib/answerKey";
import { mergeRescan } from "../src/lib/rescan";
import { planQuestionEdit } from "../src/lib/examEdit";
import { timeReport, type TimeEvent } from "../src/lib/timing";

const DIR = path.resolve("tests/.out/scale");
if (!fs.existsSync(path.join(DIR, "exam.json"))) {
  console.log("SKIP no big class at tests/.out/scale (see the comment at the top of tests/scale.test.ts)");
  process.exit(0);
}
let fails = 0;
const rows: [string, number, number][] = [];
async function time<T>(label: string, budgetMs: number, fn: () => T | Promise<T>): Promise<T> {
  const t0 = performance.now();
  const v = await fn();
  const ms = performance.now() - t0;
  rows.push([label, ms, budgetMs]);
  if (ms > budgetMs) fails++;
  return v;
}
const io = {
  listFiles: async (dir: string) => {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        e.isDirectory() ? walk(p) : out.push(p);
      }
    };
    walk(dir);
    return out.sort();
  },
  readText: async (p: string) => fs.readFileSync(p, "utf8"),
};

const exam = JSON.parse(fs.readFileSync(path.join(DIR, "exam.json"), "utf8"));
const questions: Question[] = exam.questions.map((q: Question) => ({ ...q, include: true }));
const subs = path.join(DIR, "submissions");
const scan = await time("Read 12,000 submission files", 20000, () => scanSubmissions(subs, questions, io));
const slideIds = new Set(questions.flatMap((q) => q.slides));
const tasks = buildTasks(questions, slideIds);
const s: Session = {
  version: 1, name: "Scale", createdAt: 0, savedAt: 0, sessionPath: "/x.msgrade", submissionsDir: subs, slidesDir: "",
  questions, students: scan.students, pins: scan.pins, slides: [...slideIds].map((id) => ({ id, path: `/s/${id}.ndpi` })),
  grades: emptyGrades(), taskIndex: 0,
};
console.log(`class: ${s.students.length} students, ${s.pins.length} pins, ${tasks.length} images, ${scan.problems.length} things to check`);

// clustering every image (what opening each image does)
const byTask = await time(`Cluster all ${tasks.length} images`, 3000, () =>
  tasks.map((t) => computeClusters(pinsForTask(s.pins, t, s.grades), 25, 2)),
);
const biggest = Math.max(...tasks.map((t) => pinsForTask(s.pins, t, s.grades).length));
await time(`Cluster the largest image (${biggest} pins)`, 300, () => {
  const t = tasks.find((x) => pinsForTask(s.pins, x, s.grades).length === biggest)!;
  return computeClusters(pinsForTask(s.pins, t, s.grades), 25, 2);
});

// grade the biggest cluster of every image correct, one action each, with a time log
const g = s.grades;
const log: TimeEvent[] = [];
let n = 0;
tasks.forEach((t, i) => {
  const c = byTask[i][0];
  if (!c) return;
  const id = `g${i}`;
  g.groups[id] = { id, taskId: t.id, status: "correct", text: "", pinIds: c.pinIds, createdAt: i };
  for (const p of c.pinIds) g.pinGroup[p] = id;
  log.push({ at: i, taskId: t.id, pinIds: c.pinIds, secs: 12 });
  n += c.pinIds.length;
});
s.timeLog = log;
console.log(`graded ${n} pins in ${Object.keys(g.groups).length} groups`);

const json = await time("Save: turn the session into JSON", 1500, () => JSON.stringify(s));
console.log(`session file: ${(json.length / 1e6).toFixed(1)} MB`);
await time("Open: read the session JSON back", 1500, () => JSON.parse(json));
const exRows = await time("Export: results + feedback for every student", 3000, () =>
  s.students.map((stu) => {
    const res = studentResults(s, stu, defaultSettings);
    return { stu, res, ...feedbackText(res, defaultSettings) };
  }),
);
const qnums = questions.map((q) => q.num).sort((a, b) => a - b);
await time("Export: grades.csv table", 1500, () =>
  exportTable(exRows, qnums, { columns: defaultSettings.exportColumns, uidFrom: defaultSettings.exportUid, ungradedItem: defaultSettings.exportUngraded }),
);
await time("Export: statistics (KR-20, items)", 1500, () => testStats(exRows, qnums, true));
await time("Export ▸ Time report", 1500, () => timeReport(s));

// answer key: one painted area per question at its biggest cluster
const key = { ...emptyKey(), marks: tasks.map((t, i) => { const c = byTask[i][0]; return newMark(t.q, t.slide, "correct", "", c ? [{ kind: "brush" as const, mode: "add" as const, pts: [{ x: c.cx, y: c.cy }], rNm: c.radiusNm * 1.5 }] : []); }) };
// on an ungraded copy, so the key has the whole class to grade
const fresh: Session = { ...s, grades: emptyGrades() };
const plan = await time("Answer key: work out what it grades", 5000, () => planKey(fresh, key, 1));
await time("Answer key: apply it", 1500, () => applyPlan(fresh, plan));
console.log(`answer key would grade ${plan.grade.length} more pins`);

const scan2 = await time("Rescan: read the folder again", 20000, () => scanSubmissions(subs, questions, io));
await time("Rescan: merge into the session", 3000, () => mergeRescan(s, scan2));
const edited = [...questions, { num: 33, slides: [questions[0].slides[0]], prompt: "added", include: true }];
const scan3 = await scanSubmissions(subs, edited, io);
await time("Question edit: work out what changes", 3000, () => planQuestionEdit(s, edited, scan3));

const w = Math.max(...rows.map((r) => r[0].length));
console.log("");
for (const [label, ms, budget] of rows) console.log(`${ms > budget ? "SLOW" : "PASS"} ${label.padEnd(w)}  ${ms.toFixed(0).padStart(6)} ms  (budget ${budget} ms)`);
process.exit(fails ? 1 : 0);
