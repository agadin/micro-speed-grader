// Headless check of parsing/clustering/feedback against demo data. Run: npm run test:logic
import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { parseNdpa, matchTitle } from "../src/lib/ndpa";
import { parseQuestionsFromText } from "../src/lib/examParse";
import { computeClusters } from "../src/lib/cluster";
import { buildTasks, pinsForTask, doublePinIds, studentResults, feedbackText } from "../src/lib/grading";
import { defaultSettings } from "../src/lib/settings";
import { isPainted, pinsInPaint, type PaintOp } from "../src/lib/paint";
import { exportTable, kr20, parseStudentName, EXPORT_PRESETS, testStats, safeFileName, uniqueFileNames, textCell, toCsv, type ExportRow } from "../src/lib/exportCsv";
import { MAX_ANNOTATIONS } from "../src/lib/ndpa";
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
// hidden-pin paint: strokes / polygons in nm, erasing with "remove"
{
  const brush: PaintOp = { kind: "brush", mode: "add", pts: [{ x: 0, y: 0 }, { x: 10000, y: 0 }], rNm: 2000 };
  const poly: PaintOp = { kind: "poly", mode: "add", pts: [{ x: 20000, y: -5000 }, { x: 30000, y: -5000 }, { x: 30000, y: 5000 }, { x: 20000, y: 5000 }] };
  const erase: PaintOp = { kind: "brush", mode: "remove", pts: [{ x: 5000, y: 0 }], rNm: 1500 };
  ok(isPainted([brush], 3000, 1500) && !isPainted([brush], 3000, 2500), "brush stroke covers its radius");
  ok(isPainted([brush], 11500, 0) && !isPainted([brush], 12500, 0), "brush stroke has round caps");
  ok(isPainted([poly], 25000, 0) && !isPainted([poly], 31000, 0), "polygon contains inside only");
  ok(!isPainted([brush, erase], 5000, 500) && isPainted([brush, erase], 8000, 0), "erase cuts a hole");
  ok(isPainted([brush, erase, { ...erase, mode: "add" }], 5000, 500), "repainting refills");
  const mk = (id: string, x: number, y: number) => ({ id, xNm: x, yNm: y }) as Pin;
  const got = pinsInPaint([mk("a", 1000, 0), mk("b", 25000, 0), mk("c", 15000, 0)], [brush, poly]);
  ok(got.join() === "a,b", "pinsInPaint picks painted pins");
  ok(pinsInPaint([mk("a", 1000, 0)], []).length === 0, "no paint, no pins");
}

// export: names, columns, KR-20
{
  const a = parseStudentName("1028899 - Okafor, Hana");
  ok(a.uid === "1028899" && a.surname === "Okafor" && a.first === "Hana", `folder name parsed: ${JSON.stringify(a)}`);
  const b = parseStudentName("Smith, Jane (123456)");
  ok(b.uid === "123456" && b.surname === "Smith" && b.first === "Jane", "parenthesised id parsed");
  const c = parseStudentName("Mary Ann Lee");
  ok(c.uid === "" && c.surname === "Lee" && c.first === "Mary Ann", "plain name parsed");
  // textbook check: 4 students x 3 items
  const m = [[1, 1, 1], [1, 1, 0], [1, 0, 0], [0, 0, 0]];
  // totals 3,2,1,0 → var 1.25; p = .75,.5,.25 → Σpq = .1875+.25+.1875 = .625; KR20 = 1.5*(1-.5) = .75
  ok(Math.abs((kr20(m) ?? 0) - 0.75) < 1e-9, `KR-20 = ${kr20(m)}`);
  ok(kr20([[1, 1], [1, 1]]) === null, "no variance → no KR-20");
  const mk = (folder: string, st: ("correct" | "wrong" | "ungraded")[]): ExportRow => {
    const res = st.map((status, i) => ({ q: i + 1, status, text: status }));
    const score = st.filter((x) => x === "correct").length;
    return { stu: { id: folder, name: folder, folder }, res, text: "fb", score, total: st.length };
  };
  const rows = [
    mk("1 - A, X", ["correct", "correct", "correct"]),
    mk("2 - B, Y", ["correct", "correct", "wrong"]),
    mk("3 - C, Z", ["correct", "wrong", "wrong"]),
    mk("4 - D, W", ["wrong", "wrong", "wrong"]),
    mk("5 - E, V", ["correct", "ungraded", "wrong"]),
  ];
  const t = exportTable(rows, [1, 2, 3], { columns: EXPORT_PRESETS[0].columns, uidFrom: "folder", ungradedItem: "blank" });
  ok(t[0].join() === "UID,Surname,First_name,Number_of_correct_answers,Total_questions_asked,Comment,Q1,Q2,Q3", `header: ${t[0].join()}`);
  ok(t[2].join() === "2,B,Y,2,3,fb,1,1,0", `row: ${t[2].join()}`);
  ok(t[5].slice(6).join() === "1,,0", "ungraded item left blank");
  const st = testStats(rows, [1, 2, 3]);
  ok(st.n === 4 && st.excluded === 1 && Math.abs((st.kr20 ?? 0) - 0.75) < 1e-9, `stats: n=${st.n} kr20=${st.kr20}`);
  ok(Math.abs(st.items[0].p - 0.75) < 1e-9, "item difficulty");
}


// security patch regressions
{
  // CSV: student names that look like formulas are written as text; numbers are untouched
  ok(textCell("=HYPERLINK(1)") === "'=HYPERLINK(1)" && textCell("+1") === "'+1" && textCell("@x") === "'@x" && textCell("Smith") === "Smith", "formula-like text neutralised");
  const stu = (folder: string) => ({ stu: { id: folder, name: folder, folder }, res: [{ q: 1, status: "wrong" as const, text: "x" }], text: "fb", score: -1, total: 1 });
  const t = exportTable([stu("123 - =cmd, -2+3")], [1], { columns: EXPORT_PRESETS[0].columns, uidFrom: "folder", ungradedItem: "blank" });
  ok(t[1][1] === "'=cmd" && t[1][2] === "'-2+3" && t[1][3] === "-1", `csv row ${t[1].join("|")}`);
  ok(!/(^|,)[=+@]/.test(toCsv(t).split("\r\n")[1]), "no cell starts with a formula character");

  // feedback file names: reserved Windows names, control chars, length, collisions
  ok(safeFileName("CON") === "_CON" && safeFileName("nul.txt") === "_nul.txt" && safeFileName("com1") === "_com1", "reserved names prefixed");
  ok(safeFileName("a\u0001b. ") === "ab", "control chars and trailing dot/space removed");
  for (const n of ["../..", "..", ".", "a/../b", "C:\\x", " "]) {
    const f = safeFileName(n);
    ok(!/[\\/:]/.test(f) && f !== "." && f !== "..", `safe name for ${JSON.stringify(n)} -> ${JSON.stringify(f)}`);
  }
  ok(new TextEncoder().encode(safeFileName("a".repeat(400))).length <= 150, "long names truncated");
  const u = uniqueFileNames(["Smith_Jane", "Smith_Jane", "smith_jane", "a:b", "a*b"]);
  ok(new Set(u.map((x) => x.toLowerCase())).size === u.length, `unique names ${u.join(" | ")}`);

  // title regex stays linear on hostile input
  const t0 = performance.now();
  matchTitle("q" + " ".repeat(200000) + "x", [1, 2]);
  matchTitle("question" + " ".repeat(200000) + "#" + " ".repeat(200000) + "x", [1, 2]);
  ok(performance.now() - t0 < 200, `hostile title matched in ${(performance.now() - t0).toFixed(1)} ms`);
  ok(matchTitle("Question # 3", [3]).q === 3 && matchTitle("q#4", [4]).q === 4, "q# forms still match");

  // nested viewstates don't duplicate annotations; count is capped
  const pin = "<annotation type='pin'><x>1</x><y>2</y></annotation>";
  const nested = `<annotations><ndpviewstate><title>a</title>${pin}<ndpviewstate><title>b</title>${pin}<ndpviewstate><title>c</title>${pin}</ndpviewstate></ndpviewstate></ndpviewstate></annotations>`;
  const pn = parseNdpa(nested);
  ok(pn.length === 3 && pn.map((a) => a.title).join("") === "abc", `nested viewstates -> ${pn.map((a) => a.title).join(",")}`);
  const flood = `<annotations><ndpviewstate><title>x</title>${pin.repeat(5000)}</ndpviewstate></annotations>`;
  ok(parseNdpa(flood).length === MAX_ANNOTATIONS, "annotation count capped");

  // clustering stays fast with far-apart pairs (was cubic)
  const many: Pin[] = [];
  for (let i = 0; i < 3000; i++) for (const k of [0, 1]) many.push({ id: `c${i}_${k}`, studentId: "s", slide: "S", rawTitle: "", details: "", q: 1, candidates: [], titleGuessed: false, xNm: i * 1e7, yNm: k, annotationType: "pin" } as Pin);
  const c0 = performance.now();
  const cl = computeClusters(many, 25, 2);
  ok(cl.filter((c) => !c.single).length === 3000, `pairs clustered (${cl.length})`);
  ok(performance.now() - c0 < 2000, `6000 pins clustered in ${(performance.now() - c0).toFixed(0)} ms`);
}

process.exit(fails ? 1 : 0);
