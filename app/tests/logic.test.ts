// Headless check of parsing/clustering/feedback against demo data. Run: npm run test:logic
import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { parseNdpa, matchTitle } from "../src/lib/ndpa";
import { parseQuestionsFromText } from "../src/lib/examParse";
import { computeClusters } from "../src/lib/cluster";
import { buildTasks, pinsForTask, doublePinIds, studentResults, feedbackText } from "../src/lib/grading";
import { defaultSettings } from "../src/lib/settings";
import type { Pin, Session } from "../src/lib/types";
import { emptyGrades } from "../src/lib/types";

(globalThis as any).DOMParser = new JSDOM().window.DOMParser;
const root = path.resolve(process.argv[2]);
let fails = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? "PASS" : "FAIL"} ${m}`); if (!c) fails++; };

// titles
ok(matchTitle("Q9", [9, 10]).q === 9, "Q9 matches");
ok(matchTitle("q 10", [9, 10]).q === 10, "q 10 matches");
ok(matchTitle("Question 9", [9, 10]).q === 9, "Question 9 matches");
ok(matchTitle("", [9, 10]).q === null, "blank is ambiguous");
ok(matchTitle("Q407", [27, 28]).q === null, "Q407 not matched");
ok(matchTitle("VMS146 q10", [9, 10]).q === 10, "VMS146 q10 -> 10");

// PDF text parsing (prompt split)
const qs = parseQuestionsFromText("Q5. Using VMS133, annotate a muscle Q6.  Using VMS137 or VMS479, annotate a metaplastic cell Q7. Using VMS140, x");
ok(qs.length === 3 && qs[1].slides.join() === "VMS137,VMS479", "or-question slides parsed");

// demo submissions
const exam = JSON.parse(fs.readFileSync(path.join(root, "exam.json"), "utf8"));
const questions = exam.questions.map((q: any) => ({ ...q, include: true }));
const subDir = path.join(root, "submissions");
const pins: Pin[] = [];
const students = fs.readdirSync(subDir).filter((f) => !f.startsWith(".")).map((folder, i) => ({ id: `s${i}`, name: folder, folder }));
for (const s of students) for (const f of fs.readdirSync(path.join(subDir, s.folder))) {
  const slide = f.match(/VMS\d+/)![0];
  const sq = questions.filter((q: any) => q.slides.includes(slide)).map((q: any) => q.num);
  for (const a of parseNdpa(fs.readFileSync(path.join(subDir, s.folder, f), "utf8"))) {
    const m = matchTitle(a.title, sq);
    pins.push({ id: `p${pins.length}`, studentId: s.id, slide, rawTitle: a.title, details: "", q: m.q ?? (sq.length === 1 ? sq[0] : null),
      candidates: m.q === null && sq.length > 1 ? sq : [], titleGuessed: !m.clean, xNm: a.xNm, yNm: a.yNm, annotationType: a.type });
  }
}
ok(students.length === fs.readdirSync(subDir).filter((f) => !f.startsWith(".")).length && students.length >= 100, `${students.length} students`);
const g = emptyGrades();
const slideSet = new Set<string>(questions.flatMap((q: any) => q.slides));
const tasks = buildTasks(questions, slideSet);
const want = questions.flatMap((q: any) => q.slides.map((s: string) => `Q${q.num}|${s}`)).join();
ok(tasks.map((t) => t.id).join() === want, `tasks in question order (${tasks.map((t) => t.id).join()})`);
for (const t of tasks) {
  const tp = pinsForTask(pins, t, g);
  const d = doublePinIds(pins, t.q, g);
  const t0 = performance.now();
  const cl = computeClusters(tp.filter((p) => !d.has(p.id)), 25, 2);
  const big = cl.filter((c) => !c.single);
  console.log(`  ${t.id}: ${tp.length} pins, ${d.size} double, ${big.length} clusters [${big.map((c) => c.label + ":" + c.pinIds.length).join(" ")}], ${cl.length - big.length} singles, ${(performance.now() - t0).toFixed(1)}ms`);
  ok(big.length >= 2 && big[0].pinIds.length >= big[big.length - 1].pinIds.length && big[0].pinIds.length >= 10, `${t.id} clusters sorted, largest ≥ 10`);
}
if (questions.some((q: any) => questions.some((o: any) => o !== q && o.slides.some((s: string) => q.slides.includes(s)))))
  ok(pins.some((p) => p.q === null), "some ambiguous (untitled) pins on multi-question slide");

// grade the biggest cluster of the first question correct and check feedback
const t9 = tasks[0];
const q1 = t9.q;
const cl9 = computeClusters(pinsForTask(pins, t9, g).filter((p) => !doublePinIds(pins, q1, g).has(p.id)), 25, 2);
const gid = "g1";
g.groups[gid] = { id: gid, taskId: t9.id, status: "correct", text: "", pinIds: cl9[0].pinIds, createdAt: 1 };
cl9[0].pinIds.forEach((id) => (g.pinGroup[id] = gid));
const session = { questions, students, pins, grades: g } as unknown as Session;
const stu = students.find((s) => pins.some((p) => p.studentId === s.id && cl9[0].pinIds.includes(p.id)))!;
const fb = feedbackText(studentResults(session, stu, defaultSettings));
console.log(fb.text.split("\n").map((l) => "    " + l).join("\n"));
ok(fb.text.includes(`Q${q1}: Correct`) && fb.total === questions.length, "feedback reflects grade");
const dbl = students.find((s) => doublePinIds(pins, q1, g).has(pins.find((p) => p.studentId === s.id && p.q === q1)?.id ?? ""))!;
ok(!!dbl && studentResults(session, dbl, defaultSettings)[0].text === defaultSettings.doubleMessage, "double-pin student auto-wrong");
process.exit(fails ? 1 : 0);
