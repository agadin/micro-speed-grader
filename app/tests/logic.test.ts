// Headless check of parsing/clustering/feedback against demo data. Run: npm run test:logic
import "./setup-window";
import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { parseNdpa, matchTitle, namedQuestion } from "../src/lib/ndpa";
import { groupProblems, scanSubmissions, startBlockers, MAX_NDPA_BYTES, type ScanIO } from "../src/lib/loader";
import { parseQuestionsFromText } from "../src/lib/examParse";
import { computeClusters } from "../src/lib/cluster";
import { buildTasks, pinsForTask, doublePinIds, studentResults, feedbackText } from "../src/lib/grading";
import { defaultSettings } from "../src/lib/settings";
import { isPainted, pinsInPaint, type PaintOp } from "../src/lib/paint";
import { exportTable, kr20, parseStudentName, EXPORT_PRESETS, testStats, safeFileName, uniqueFileNames, textCell, toCsv, type ExportRow } from "../src/lib/exportCsv";
import { MAX_ANNOTATIONS } from "../src/lib/ndpa";
import { parseMarkdown, slug } from "../src/lib/markdown";
import { applyPlan, emptyKey, makeKeyFile, matchPin, newMark, parseKeyFile, planKey, type AnswerKey } from "../src/lib/answerKey";
import { activeSecs, fmtDuration, IDLE_CAP, timeCsv, timeReport } from "../src/lib/timing";
import { checkQuestions, examJson, nextNum, normSlide, planQuestionEdit, questionChanges, renumbered } from "../src/lib/examEdit";
import { area, dist, fmtArea, fmtLength, measureLabel, perimeter } from "../src/lib/measure";
import { canCarry, carryOver, dismissRows, mergeRescan, rescanMessage, restorePins, reviewPinIds, reviewRows } from "../src/lib/rescan";
import { KEY, HOST, agreement, changedSinceSent, conflictPins, hostGraded, planOverlap, recallChecks, resolveWith, sameReason, seeded, awayPins, splitWeighted, guestSession, makePack, makeResult, mergeResult, parsePack, parseResult, remainingByTask } from "../src/lib/handoff";
import { AUTO, autoRows, filterGroups, findStudents, graderOptions, isFiltered, noFilter, rowPasses, studentLabel, studentSummary, type LedgerFilter } from "../src/lib/review";
import type { GradeState, Pin, Question, Session } from "../src/lib/types";
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


// hand-off packs: split → pack → guest grades → results → merge
{
  const mk = (id: string, stu: string, slide: string, q: number | null, cands: number[] = []) =>
    ({ id, studentId: stu, slide, rawTitle: "", details: "", q, candidates: cands, titleGuessed: false, xNm: 0, yNm: 0, annotationType: "pin" }) as Pin;
  const hs: Session = {
    version: 1, name: "Final", createdAt: 0, savedAt: 0, sessionPath: "/h/final.msgrade", submissionsDir: "", slidesDir: "/h/slides",
    questions: [{ num: 1, slides: ["A"], prompt: "", include: true }, { num: 2, slides: ["B"], prompt: "", include: true }, { num: 3, slides: ["B"], prompt: "", include: true }],
    students: [{ id: "s1", name: "One", folder: "One" }, { id: "s2", name: "Two", folder: "Two" }],
    pins: [mk("a1", "s1", "A", 1), mk("a2", "s2", "A", 1), mk("b1", "s1", "B", 2), mk("b2", "s2", "B", 2), mk("c1", "s1", "B", 3), mk("x", "s2", "B", null, [2, 3])],
    slides: [{ id: "A", path: "/h/slides/A.ndpi" }, { id: "B", path: "/h/slides/B.ndpi" }],
    grades: emptyGrades(), taskIndex: 0,
  };
  const ts = buildTasks(hs.questions, new Set(["A", "B"]));
  const rem = remainingByTask(hs, ts);
  ok(rem.map((r) => r.pinIds.length).join() === "2,3,2", `remaining per task ${rem.map((r) => r.pinIds.length)}`);
  const splitEven = (items: { id: string; n: number }[], k: number) => splitWeighted(items, new Array(Math.max(0, k)).fill(1));
  const sum = (m: Map<string, number>, items: { id: string; n: number }[], who: number) =>
    items.filter((x) => m.get(x.id) === who).reduce((t, x) => t + x.n, 0);
  const it3 = [{ id: "a", n: 10 }, { id: "b", n: 5 }, { id: "c", n: 5 }];
  const s2 = splitEven(it3, 2);
  ok(sum(s2, it3, 0) === 10 && sum(s2, it3, 1) === 10, "split 10 | 5+5 evenly between two");
  const it6 = [{ id: "a", n: 30 }, { id: "b", n: 20 }, { id: "c", n: 20 }, { id: "d", n: 10 }, { id: "e", n: 20 }, { id: "f", n: 20 }];
  const s3 = splitEven(it6, 3);
  ok([0, 1, 2].every((w) => sum(s3, it6, w) >= 30 && sum(s3, it6, w) <= 50), `split among three ${[0, 1, 2].map((w) => sum(s3, it6, w))}`);
  ok(splitEven(it6, 4).size === 6 && new Set(splitEven(it6, 4).values()).size === 4, "everyone gets work when there's enough");
  const ten = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, n: 10 }));
  const w73 = splitWeighted(ten, [70, 30]);
  ok(sum(w73, ten, 0) === 70 && sum(w73, ten, 1) === 30, `70/30 split: ${sum(w73, ten, 0)}/${sum(w73, ten, 1)}`);
  const w0 = splitWeighted(ten, [0, 50, 50]);
  ok(sum(w0, ten, 0) === 0 && sum(w0, ten, 1) === 50, "a 0% share gets nothing");
  ok(splitWeighted(ten, [0, 0]).size === 0, "all-zero shares split nothing");
  ok(splitEven(it6, 0).size === 0 && [...splitEven(it6, 1).values()].every((v) => v === 0), "split extremes");

  // host hands out task Q2·B
  const give = rem.find((r) => r.task.q === 2)!;
  const pack = parsePack(JSON.stringify(makePack(hs, "Jamie", [give.task.id], give.pinIds)));
  hs.handoffs = [{ id: pack.id, guest: "Jamie", createdAt: 0, taskIds: pack.taskIds, pinIds: pack.pinIds, status: "out" }];
  ok(awayPins(hs).size === give.pinIds.length && remainingByTask(hs, ts).find((r) => r.task.q === 2)!.pinIds.length === 0, "handed-out pins locked on host");

  // guest grades everything they were given (plus tries to grade a pin they weren't)
  const gs = guestSession(pack, [{ id: "B", path: "/g/B.ndpi" }], "/g/final-jamie.msgrade", "/g");
  ok(gs.slides.length === 1 && gs.slides[0].path === "/g/B.ndpi" && gs.guestPack?.guest === "Jamie", "guest session relinks slides");
  gs.grades = { groups: { g1: { id: "g1", taskId: give.task.id, status: "correct", text: "nice", pinIds: [...give.pinIds, "a1"], createdAt: 1 } }, pinGroup: Object.fromEntries([...give.pinIds, "a1"].map((id) => [id, "g1"])), assign: { x: 2 } };
  const res = parseResult(JSON.stringify(makeResult(gs)));
  ok(res.groups[0].pinIds.length === give.pinIds.length && !res.groups[0].pinIds.includes("a1"), "results contain only pack pins");

  // host meanwhile graded one of them after a recall: host wins
  hs.grades = { groups: { h1: { id: "h1", taskId: give.task.id, status: "wrong", text: "host", pinIds: ["b1"], createdAt: 2 } }, pinGroup: { b1: "h1" }, assign: {} };
  const m = mergeResult(hs, res);
  ok(m.grades.pinGroup.b1 === "h1" && m.skipped === 1 && m.merged === give.pinIds.length - 1, `merge keeps host grade (merged ${m.merged}, skipped ${m.skipped})`);
  ok(m.grades.assign.x === 2 && m.handoffs[0].status === "returned", "assignment merged and pack marked returned");
  let threw = false;
  try { mergeResult({ ...hs, handoffs: [] }, res); } catch { threw = true; }
  ok(threw, "results for an unknown pack are refused");

  // several graders at once: two packs out, both locked, results merge independently in any order
  const hm: Session = { ...hs, grades: emptyGrades(), handoffs: [] };
  const r2 = remainingByTask(hm, ts);
  const [ta, tb] = [r2.find((r) => r.task.q === 1)!, r2.find((r) => r.task.q === 3)!];
  const pa = makePack(hm, "Ana", [ta.task.id], ta.pinIds);
  const pb = makePack(hm, "Ben", [tb.task.id], tb.pinIds);
  hm.handoffs = [pa, pb].map((p) => ({ id: p.id, guest: p.guest, createdAt: 0, taskIds: p.taskIds, pinIds: p.pinIds, status: "out" as const }));
  ok(awayPins(hm).size === ta.pinIds.length + tb.pinIds.length, "two packs out lock both sets of pins");
  const gradeAll = (p: typeof pa) => {
    const g = guestSession(p, [{ id: "A", path: "/g/A.ndpi" }, { id: "B", path: "/g/B.ndpi" }], "/g/x.msgrade", "/g");
    g.grades = { groups: { z: { id: "z", taskId: p.taskIds[0], status: "correct", text: p.guest, pinIds: p.pinIds, createdAt: 1 } }, pinGroup: Object.fromEntries(p.pinIds.map((id) => [id, "z"])), assign: {} };
    return parseResult(JSON.stringify(makeResult(g)));
  };
  const m1 = mergeResult(hm, gradeAll(pb));
  const hm2: Session = { ...hm, grades: m1.grades, handoffs: m1.handoffs };
  const m2 = mergeResult(hm2, gradeAll(pa));
  ok(
    m2.handoffs.every((h) => h.status === "returned") && [...ta.pinIds, ...tb.pinIds].every((id) => m2.grades.pinGroup[id]),
    "two graders' results merge in any order",
  );
}

// ---- grading with others: who graded, re-sent results, pins graded twice, disagreements ----
{
  const P = (id: string, stu: string, q: number) =>
    ({ id, studentId: stu, slide: "A", rawTitle: "", details: "", q, candidates: [], titleGuessed: false, xNm: 0, yNm: 0, annotationType: "pin" }) as Pin;
  const pins = Array.from({ length: 8 }, (_, i) => P(`p${i}`, `s${i}`, 1));
  const base = (): Session => ({
    version: 1, name: "Mid", createdAt: 0, savedAt: 0, sessionPath: "/h/mid.msgrade", submissionsDir: "", slidesDir: "/h",
    questions: [{ num: 1, slides: ["A"], prompt: "", include: true }],
    students: pins.map((p) => ({ id: p.studentId, name: p.studentId, folder: p.studentId })),
    pins, slides: [{ id: "A", path: "/h/A.ndpi" }], grades: emptyGrades(), taskIndex: 0,
  });
  const pinMap = new Map(pins.map((p) => [p.id, p]));
  const T = "Q1|A";
  const result = (packId: string, guest: string, gs: { ids: string[]; status: "correct" | "wrong"; text: string }[]) =>
    parseResult(JSON.stringify({ kind: "msg-handoff-result", version: 1, packId, guest, sentAt: 1, assign: {},
      groups: gs.map((x, i) => ({ id: `r${i}`, taskId: T, status: x.status, text: x.text, pinIds: x.ids, createdAt: 1 })) }));
  const hostGrade = (g: GradeState, ids: string[], status: "correct" | "wrong", text: string) => {
    const id = `h${Math.random()}`;
    g.groups[id] = { id, taskId: T, status, text, pinIds: ids, createdAt: 2 };
    for (const p of ids) g.pinGroup[p] = id;
    return hostGraded(g, ids, pinMap);
  };

  // reasons: only clearly different ones disagree
  ok(sameReason("Neutrophil", "neutrophils.") && sameReason("Neutrophl", "Neutrophil") && sameReason("", "Lymphocyte") && sameReason("Dermis, not epidermis", "epidermis"), "same reason despite case, plural, typo, blank");
  ok(!sameReason("Neutrophil", "Lymphocyte") && !sameReason("Smooth muscle", "Adipose tissue"), "clearly different reasons disagree");

  // planning the overlap
  const imgs = [{ taskId: "t1", pinIds: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"], col: 1 }, { taskId: "t2", pinIds: ["k", "l", "m", "n"], col: 0 }];
  const plan = planOverlap(imgs, [0, 1, 2], 0.2, seeded(7));
  ok(plan.size === 3 && [...plan.values()].every(([a, b]) => a !== b), `overlap: 2 + 1 pins, two different people each (${[...plan.values()].join(" ")})`);
  const noMe = planOverlap(imgs, [1, 2], 0.2, seeded(7));
  ok(noMe.size === 2 && [...noMe.keys()].every((k) => !["k", "l", "m", "n"].includes(k)), "with the host left out, the host's own images are graded once");
  ok(planOverlap(imgs, [1], 0.5).size === 0 && planOverlap(imgs, [0, 1], 0).size === 0, "no overlap with one person or 0%");

  // results sent twice: the second file updates that guest's grades; the host's own grade still wins
  {
    const s = base();
    s.handoffs = [{ id: "pk", guest: "Ana", createdAt: 0, taskIds: [T], pinIds: ["p0", "p1", "p2"], status: "out" }];
    const m1 = mergeResult(s, result("pk", "Ana", [{ ids: ["p0", "p1"], status: "correct", text: "" }]));
    ok(m1.merged === 2 && m1.grades.groups[m1.grades.pinGroup.p0].by === "Ana", "merged grades are stamped with the guest's name");
    const s2 = { ...s, grades: m1.grades, handoffs: m1.handoffs };
    hostGrade(s2.grades, ["p1"], "wrong", "host says no");
    const m2 = mergeResult(s2, result("pk", "Ana", [{ ids: ["p0", "p1", "p2"], status: "wrong", text: "Lymphocyte" }]));
    const g2 = m2.grades;
    ok(m2.updated === 1 && m2.merged === 1 && m2.skipped === 1, `re-send: updated ${m2.updated}, new ${m2.merged}, kept host ${m2.skipped}`);
    ok(g2.groups[g2.pinGroup.p0].text === "Lymphocyte" && g2.groups[g2.pinGroup.p1].text === "host says no", "re-sent grade replaces the guest's own, not the host's");
  }

  // host and a guest grade the same pins blind
  {
    const s = base();
    s.grades.checks = Object.fromEntries(["p0", "p1", "p2"].map((id) => [id, { taskId: T, graders: [HOST, "Ana"], verdicts: [], state: "waiting" as const }]));
    s.handoffs = [{ id: "pk", guest: "Ana", createdAt: 0, taskIds: [T], pinIds: ["p0", "p1", "p2", "p3"], checkPins: ["p0", "p1", "p2"], status: "out" }];
    const away = awayPins(s);
    ok(!away.has("p0") && away.has("p3"), "pins the host also grades aren't locked; the guest's own are");
    const pack = makePack({ ...s, grades: { ...s.grades, groups: { z: { id: "z", taskId: T, status: "correct", text: "", pinIds: ["p0", "p7"], createdAt: 0 } }, pinGroup: { p0: "z", p7: "z" } } }, "Ana", [T], ["p0", "p1", "p2", "p3"]);
    ok(!pack.session.grades.pinGroup.p0 && pack.session.grades.pinGroup.p7 === "z" && !("checks" in pack.session.grades), "pack leaves out grades on the guest's pins (blind) and the checks");
    // host grades p0 correct, p1 correct; guest says p0 correct, p1 wrong, p2 wrong
    hostGrade(s.grades, ["p0", "p1"], "correct", "");
    ok(s.grades.checks!.p0.state === "waiting" && !!s.grades.pinGroup.p0, "host's verdict recorded; waits for the guest");
    const m = mergeResult(s, result("pk", "Ana", [{ ids: ["p0", "p3"], status: "correct", text: "" }, { ids: ["p1", "p2"], status: "wrong", text: "Neutrophil" }]));
    const g = m.grades;
    ok(g.checks!.p0.state === "agreed" && !!g.pinGroup.p0, "agreement keeps the grade");
    ok(g.checks!.p1.state === "conflict" && !g.pinGroup.p1 && conflictPins(g).join() === "p1", "disagreement: pin left ungraded and flagged");
    ok(g.checks!.p2.state === "waiting" && !g.pinGroup.p2 && m.waiting === 1 && m.conflicts === 1, "host hasn't graded p2 yet: guest's grade stays hidden");
    // host grades p2 wrong with a matching reason: agreed. Then settles p1 with Ana's grade.
    const n = hostGrade(g, ["p2"], "wrong", "neutrophils");
    ok(n === 0 && g.checks!.p2.state === "agreed", "host's later verdict is compared on the spot");
    const r = resolveWith(g, ["p1"], "Ana", pinMap);
    ok(r.checks!.p1.state === "resolved" && r.groups[r.pinGroup.p1].by === "Ana" && r.groups[r.pinGroup.p1].text === "Neutrophil", "resolve with one grader's verdict");
    const st = agreement(r).find((x) => x.a === HOST || x.b === HOST)!;
    ok(st.pins === 3 && st.agree === 2, `agreement counted (${st.agree}/${st.pins}, κ ${st.kappa?.toFixed(2)})`);
  }

  // two guests grade the same pins; the host only settles
  {
    const s = base();
    s.grades.checks = { p4: { taskId: T, graders: ["Ana", "Ben"], verdicts: [], state: "waiting" }, p5: { taskId: T, graders: ["Ana", "Ben"], verdicts: [], state: "waiting" } };
    s.handoffs = [
      { id: "a", guest: "Ana", createdAt: 0, taskIds: [T], pinIds: ["p4", "p5"], checkPins: ["p4", "p5"], status: "out" },
      { id: "b", guest: "Ben", createdAt: 0, taskIds: [T], pinIds: ["p4", "p5"], checkPins: ["p4", "p5"], status: "out" },
    ];
    ok(awayPins(s).has("p4"), "pins only guests grade are locked for the host");
    const m1 = mergeResult(s, result("a", "Ana", [{ ids: ["p4", "p5"], status: "correct", text: "" }]));
    const s1 = { ...s, grades: m1.grades, handoffs: m1.handoffs };
    ok(!m1.grades.pinGroup.p4 && m1.waiting === 2, "first guest's verdicts wait for the second");
    const m2 = mergeResult(s1, result("b", "Ben", [{ ids: ["p4"], status: "correct", text: "" }, { ids: ["p5"], status: "wrong", text: "Fibroblast" }]));
    ok(m2.grades.groups[m2.grades.pinGroup.p4].by === "Ana & Ben" && m2.conflicts === 1 && !m2.grades.pinGroup.p5, "agreeing guests share the grade; the other pin is a disagreement");
    // the host grading a disagreed pin settles it
    const g = m2.grades;
    hostGrade(g, ["p5"], "correct", "");
    ok(g.checks!.p5.state === "resolved" && conflictPins(g).length === 0, "host's own grade settles a disagreement");
    // recall: Ben's pack recalled before he returned → Ana's verdict alone decides
    const r = recallChecks(m1.grades, "Ben", ["p4", "p5"], pinMap);
    ok(r.checks!.p4.state === "agreed" && r.groups[r.pinGroup.p4].by === "Ana", "after a recall the remaining grader's verdict stands");
  }

  // recalled and handed on: two guests end up grading the same pin → compared, not silently overwritten
  {
    const s = base();
    s.handoffs = [
      { id: "a", guest: "Ana", createdAt: 0, taskIds: [T], pinIds: ["p6"], status: "recalled" },
      { id: "b", guest: "Ben", createdAt: 0, taskIds: [T], pinIds: ["p6"], status: "out" },
    ];
    const m1 = mergeResult(s, result("b", "Ben", [{ ids: ["p6"], status: "correct", text: "" }]));
    const m2 = mergeResult({ ...s, grades: m1.grades, handoffs: m1.handoffs }, result("a", "Ana", [{ ids: ["p6"], status: "wrong", text: "Mast cell" }]));
    ok(m2.conflicts === 1 && m2.grades.checks!.p6.graders.join() === "Ben,Ana", "late results from a recalled pack become a disagreement");
  }

  // a rescan while a pack is out: the guest's grades for pins that changed since are kept aside
  {
    const s = base();
    s.handoffs = [{ id: "pk", guest: "Ana", createdAt: 0, taskIds: [T], pinIds: ["p0", "p1", "p2"], status: "out" }];
    // the files now: p1 is gone, p2 moved, the rest unchanged
    const scan = {
      students: s.students,
      pins: s.pins.filter((p) => p.id !== "p1").map((p) => (p.id === "p2" ? { ...p, id: "x", xNm: 5000 } : p)),
    };
    const r = mergeRescan(s, scan);
    const s1: Session = { ...s, students: r.students, pins: r.pins, retired: r.retired, grades: r.grades };
    const np = r.replacements[0];
    ok(changedSinceSent(s).size === 0 && changedSinceSent(s1).get("pk") === 2, `out pack: ${changedSinceSent(s1).get("pk")} pins changed since sent`);
    ok(reviewRows(s1).length === 1 && reviewRows(s1)[0].kind === "removed", "before the results: only the removed pin is to review");
    const m = mergeResult(s1, result("pk", "Ana", [{ ids: ["p0", "p1"], status: "correct", text: "" }, { ids: ["p2"], status: "wrong", text: "Mast cell" }]));
    ok(m.merged === 1 && m.changed === 2 && !m.grades.pinGroup.p1 && !m.grades.pinGroup.p2 && !m.grades.pinGroup[np], `merged ${m.merged}, changed since sent ${m.changed}: not graded`);
    const s2: Session = { ...s1, grades: m.grades, handoffs: m.handoffs, retired: m.retired };
    const rows = reviewRows(s2);
    const ch = rows.find((x) => x.kind === "changed")!;
    ok(rows.length === 2 && ch.old.grade?.by === "Ana" && ch.old.grade.text === "Mast cell" && ch.newPin?.id === np, "the guest's grades are kept with the old pins, in Changed submissions");
    const c = carryOver(s2, [ch]);
    ok(c.grades.groups[c.grades.pinGroup[np]]?.by === "Ana" && c.grades.groups[c.grades.pinGroup[np]].text === "Mast cell", "carry over gives the new pin the guest's grade");
    ok(changedSinceSent(s2).size === 0, "a returned pack no longer shows changes");
    ok(mergeResult(s, result("pk", "Ana", [{ ids: ["p0"], status: "correct", text: "" }])).retired === undefined, "nothing changed: retired pins untouched");
  }

  // a file from a newer version says so
  let msg = "";
  try { parsePack(JSON.stringify({ kind: "msg-handoff", version: 2 })); } catch (e) { msg = String(e); }
  ok(/newer version/.test(msg), "newer pack format: asks to update the app");
}

// ---- answer key: match painted marks, apply at each level, key files, rescan, then hand off the rest ----
{
  const P = (id: string, stu: string, slide: string, q: number | null, x: number, y = 0, cands: number[] = []) =>
    ({ id, studentId: stu, slide, rawTitle: `t${id}`, details: "", q, candidates: cands, titleGuessed: false, xNm: x, yNm: y, annotationType: "pin" }) as Pin;
  // Q1 on slide A; Q2 "either B or C"; pins at x = 0 (right), 100 (common wrong), 500 (elsewhere)
  const pins = [
    P("a1", "s1", "A", 1, 0), P("a2", "s2", "A", 1, 100), P("a3", "s3", "A", 1, 500), P("a4", "s4", "A", 1, 0),
    P("b1", "s1", "B", 2, 0), P("c2", "s2", "C", 2, 0), P("b3", "s3", "B", 2, 300),
    P("d1", "s5", "A", 1, 0), P("d2", "s5", "A", 1, 100), // student s5 has two pins for Q1 → never key-graded
  ];
  const base = (): Session => ({
    version: 1, name: "Prac", createdAt: 0, savedAt: 0, sessionPath: "/p.msgrade", submissionsDir: "/subs", slidesDir: "/s",
    questions: [{ num: 1, slides: ["A"], prompt: "", include: true }, { num: 2, slides: ["B", "C"], prompt: "", include: true }],
    students: ["s1", "s2", "s3", "s4", "s5"].map((id) => ({ id, name: id, folder: id })),
    pins: pins.map((p) => ({ ...p })), slides: [], grades: emptyGrades(), taskIndex: 0,
  });
  const circle = (x: number, r = 20): PaintOp[] => [{ kind: "brush", mode: "add", pts: [{ x, y: 0 }], rNm: r }];
  const key: AnswerKey = {
    ...emptyKey(),
    marks: [
      newMark(1, "A", "correct", "", circle(0)),
      newMark(1, "A", "wrong", "Neutrophil", circle(100)),
      newMark(2, "B", "correct", "", circle(0)),
      newMark(2, "C", "correct", "", circle(0)),
    ],
  };
  const s = base();
  const gradeOf = (g: GradeState, id: string) => g.groups[g.pinGroup[id]];

  ok(matchPin(key, s.pins[0], s.grades).kind === "match" && matchPin(key, s.pins[2], s.grades).kind === "none", "pin in a mark matches; elsewhere doesn't");
  const p1 = planKey(s, key, 1);
  ok(p1.grade.length === 5 && p1.unmatched === 2, `ungraded: ${p1.grade.length} graded by key, ${p1.unmatched} left (a3, b3); double pins skipped`);
  const g1 = applyPlan(s, p1);
  ok(gradeOf(g1, "a1").by === KEY && gradeOf(g1, "a1").status === "correct" && gradeOf(g1, "a2").text === "Neutrophil", "key grades: correct, and wrong with its reason");
  ok(gradeOf(g1, "b1").taskId === "Q2|B" && gradeOf(g1, "c2").taskId === "Q2|C", "either-slide question: each slide's mark grades its own image");
  ok(!g1.pinGroup.d1 && !g1.pinGroup.d2, "a student with two pins for a question is left to the double-pin rule");
  ok(planKey(s, key, 0).grade.length === 0, "level 0 changes nothing now");

  // a person grades a1 wrong, a TA grades a4 wrong; then the key is applied again at each level
  const s2 = { ...s, grades: g1 };
  s2.grades.groups.me = { id: "me", taskId: "Q1|A", status: "wrong", text: "mine", pinIds: ["a1"], createdAt: 1 };
  s2.grades.pinGroup.a1 = "me";
  s2.grades.groups.ta = { id: "ta", taskId: "Q1|A", status: "wrong", text: "ta", pinIds: ["a4"], createdAt: 1, by: "Jamie" };
  s2.grades.pinGroup.a4 = "ta";
  for (const gid of Object.keys(s2.grades.groups)) s2.grades.groups[gid] = { ...s2.grades.groups[gid], pinIds: s2.grades.groups[gid].pinIds.filter((x) => gid === "me" || gid === "ta" || (x !== "a1" && x !== "a4")) };
  // move the wrong-answer mark away: the key's earlier grade on a2 no longer matches
  const moved: AnswerKey = { ...key, marks: key.marks.map((m) => (m.kind === "wrong" ? { ...m, ops: circle(400) } : m)) };
  const lv = [1, 2, 3, 4].map((l) => planKey(s2, moved, l as 1 | 2 | 3 | 4));
  ok(lv[0].grade.length === 0 && lv[0].clear.length === 0, "level 1: nothing ungraded is left to grade");
  ok(lv[1].clear.join() === "a2", "level 2: the key's grade on a pin no longer in any mark is removed");
  ok(lv[2].grade.map((x) => x.pinId).join() === "a4" && lv[2].replaces === 1, "level 3: replaces another grader's grade, keeps mine");
  ok(lv[3].grade.map((x) => x.pinId).sort().join() === "a1,a4" && lv[3].replaces === 2, "level 4: replaces mine too");

  // overlapping marks that disagree → left for a person
  const clash: AnswerKey = { ...key, marks: [...key.marks, newMark(1, "A", "wrong", "Mast cell", circle(0))] };
  ok(matchPin(clash, s.pins[0], s.grades).kind === "conflict" && planKey(s, clash, 1).conflicts >= 2, "pin in a correct and a wrong mark is left for a person");

  // an unlabelled pin on a slide two questions use: graded under the question whose mark it's in
  const amb = { ...base(), questions: [...base().questions, { num: 3, slides: ["B"], prompt: "", include: true }] };
  amb.pins.push(P("u1", "s4", "B", null, 0, 0, [2, 3]));
  const ga = applyPlan(amb, planKey(amb, key, 1));
  ok(gradeOf(ga, "u1")?.taskId === "Q2|B" && ga.assign.u1 === 2, "unlabelled pin assigned to the question whose mark it's in");

  // key file round trip; marks for questions/slides the session lacks are skipped
  const f = JSON.stringify(makeKeyFile(s, { ...key, marks: [...key.marks, newMark(9, "Z", "correct", "", circle(0))] }));
  const back = parseKeyFile(f, s);
  ok(back.marks.length === 4 && back.skipped === 1 && back.marks[1].reason === "Neutrophil", `key file: ${back.marks.length} marks, ${back.skipped} skipped`);
  let kmsg = "";
  try { parseKeyFile(JSON.stringify({ kind: "msg-key", version: 1, marks: [{ q: 1, slide: "A", kind: "correct", ops: [{ kind: "poly", mode: "add", pts: [{ x: "a" }] }] }] }), s); } catch (e) { kmsg = String(e); }
  ok(!kmsg && parseKeyFile(JSON.stringify({ kind: "msg-key", version: 1, marks: [{ q: 1, slide: "A", kind: "correct", ops: [{ kind: "poly", mode: "add", pts: [{ x: "a" }] }] }] }), s).skipped === 1, "malformed marks are skipped, not trusted");

  // rescan: a late student and a changed file; unchanged pins keep id + grade; new pins get the key
  const scanned = {
    students: [...s.students.map((x) => ({ ...x, id: `n${x.id}` })), { id: "n6", name: "s6", folder: "s6" }],
    pins: [
      ...s.pins.filter((p) => p.id !== "a3").map((p) => ({ ...p, id: `x${p.id}`, studentId: `n${p.studentId}` })),
      { ...P("new1", "n6", "A", 1, 0), id: "xnew1" },
      { ...P("new2", "ns3", "A", 1, 100), id: "xnew2" },
    ],
  };
  const r = mergeRescan({ ...s, grades: g1 }, scanned);
  ok(r.newStudents === 1 && r.added.length === 2 && r.replacements.length === 1 && r.removed === 0, `rescan: +${r.newStudents} student, +${r.added.length} pins (${r.replacements.length} changed), −${r.removed}`);
  ok(r.pins.some((p) => p.id === "a1") && !!r.grades.pinGroup.a1 && !r.pins.some((p) => p.id === "a3") && r.retired.some((x) => x.pin.id === "a3"), "unchanged pins keep their id and grade; the moved pin is retired");
  const sr: Session = { ...s, students: r.students, pins: r.pins, grades: r.grades };
  const auto = planKey(sr, key, 0, new Set(r.added));
  ok(auto.grade.length === 2, "new submissions get the key (level 0 = only new pins)");

  // the instructor's flow: the key grades what it can, the rest goes to a TA, who only gets untouched pins
  const sk = { ...s, grades: g1, key };
  const rest = remainingByTask(sk, buildTasks(sk.questions, new Set(["A", "B", "C"])));
  const left = rest.flatMap((x) => x.pinIds).sort();
  ok(left.join() === "a3,b3", `hand-off after the key: only ${left.join(", ")} remain`);
  const pk = makePack(sk, "Jamie", rest.filter((x) => x.pinIds.length).map((x) => x.task.id), left);
  ok(pk.pinIds.join() === "a3,b3" && pk.session.key?.marks.length === 4 && pk.session.key.mode === "suggest", "pack carries the key (as suggestions) and only the untouched pins");
}

// ---- rescan: changed / removed / new pins, the Changed submissions review ----
{
  const P = (id: string, stu: string, slide: string, q: number | null, x: number, title = `Q${q}`) =>
    ({ id, studentId: stu, slide, rawTitle: title, details: "", q, candidates: [], titleGuessed: false, xNm: x, yNm: 0, annotationType: "pin" }) as Pin;
  const grp = (id: string, pinIds: string[], status: "correct" | "wrong", text = "", by?: string) =>
    ({ id, taskId: "Q1|A", status, text, pinIds, createdAt: 1, ...(by ? { by } : {}) });
  // s1..s4 each answer Q1 on slide A; s1 and s2 also answer Q2
  const s: Session = {
    version: 1, name: "Prac", createdAt: 0, savedAt: 0, sessionPath: "/p.msgrade", submissionsDir: "/subs", slidesDir: "/s",
    questions: [{ num: 1, slides: ["A"], prompt: "Find a neutrophil", include: true }, { num: 2, slides: ["A"], prompt: "", include: true }],
    students: ["s1", "s2", "s3", "s4"].map((id) => ({ id, name: `Student ${id}`, folder: id })),
    pins: [P("p1", "s1", "A", 1, 0), P("p2", "s2", "A", 1, 0), P("p3", "s3", "A", 1, 100), P("p4", "s4", "A", 1, 0), P("p5", "s1", "A", 2, 50), P("p6", "s2", "A", 2, 50)],
    slides: [], taskIndex: 0,
    grades: {
      groups: { g1: grp("g1", ["p1", "p2", "p4"], "correct"), g2: grp("g2", ["p3"], "wrong", "Neutrophil", "Jamie"), g3: { ...grp("g3", ["p5"], "correct"), taskId: "Q2|A" } },
      pinGroup: { p1: "g1", p2: "g1", p4: "g1", p3: "g2", p5: "g3" },
      assign: {},
    },
  };
  const stu = (id: string) => s.students.find((x) => x.id === id)!;
  // the folder again: s2 and s3 moved their Q1 pin (Jamie graded s3's), s4 took Q1 out, s1's Q2 pin
  // is gone, s1's Q1 pin is unchanged, and a late student s5 arrives
  const scan = {
    students: [...s.students.map((x) => ({ ...x, id: `n${x.id}` })), { id: "ns5", name: "Student s5", folder: "s5" }],
    pins: [P("x1", "ns1", "A", 1, 0), P("x2", "ns2", "A", 1, 900), P("x3", "ns3", "A", 1, 0), P("x6", "ns2", "A", 2, 50), P("x7", "ns5", "A", 1, 0)],
  };
  const r = mergeRescan(s, scan);
  ok(r.newStudents === 1 && r.added.length === 3 && r.replacements.length === 2 && r.removed === 2, `rescan classifies: ${r.added.length} added, ${r.replacements.length} changed, ${r.removed} removed`);
  const ret = new Map(r.retired.map((x) => [x.pin.id, x]));
  const newOf = (sid: string) => r.pins.find((p) => r.added.includes(p.id) && p.studentId === sid)!;
  ok(ret.get("p2")?.replacedBy === newOf("s2").id && ret.get("p3")?.replacedBy === newOf("s3").id && !ret.get("p4")?.replacedBy && !ret.get("p5")?.replacedBy, "each changed pin is linked to the student's new pin for the same question");
  ok(ret.get("p3")?.grade?.status === "wrong" && ret.get("p3")?.grade?.text === "Neutrophil" && ret.get("p3")?.grade?.by === "Jamie", "a retired pin keeps its grade (and who gave it)");
  ok(!r.grades.pinGroup.p2 && !r.grades.pinGroup.p3 && r.grades.groups.g1.pinIds.join() === "p1", "retired pins are out of the grades; unchanged p1 keeps its grade");
  ok(r.pins.length === 5 && !r.pins.some((p) => ["p2", "p3", "p4", "p5"].includes(p.id)), "retired pins aren't the student's answer any more");
  const s2: Session = { ...s, students: r.students, pins: r.pins, retired: r.retired, grades: r.grades };
  ok(rescanMessage(r, r.grades) === "Rescan: 1 new student, 1 new pin, 2 changed, 2 removed.", `message: ${rescanMessage(r, r.grades)}`);

  // results / export: a removed answer is "no answer", a changed one is ungraded until reviewed
  const res = (st: Session, id: string, q: number) => studentResults(st, stu(id), defaultSettings).find((x) => x.q === q)!;
  ok(res(s2, "s4", 1).status === "wrong" && res(s2, "s4", 1).text === defaultSettings.noAnswerMessage && res(s2, "s2", 1).status === "ungraded", "export: retired pins don't count");

  const rows = reviewRows(s2);
  ok(rows.length === 4 && rows.filter((x) => x.kind === "changed").length === 2 && rows.filter((x) => x.kind === "removed").length === 2, `review lists ${rows.length} rows (2 changed, 2 removed)`);
  ok(reviewPinIds(rows).size === 2 && reviewPinIds(rows).has(newOf("s2").id), "the changed submissions' new pins are badged");

  // carry over: the new pin gets the old grade, from whoever gave it; the row is done
  const c1 = carryOver(s2, rows.filter((x) => x.studentId === "s3"));
  const g3 = c1.grades.groups[c1.grades.pinGroup[newOf("s3").id]];
  ok(g3?.status === "wrong" && g3.text === "Neutrophil" && g3.by === "Jamie" && g3.taskId === "Q1|A", "carry over: Jamie's ✗ Neutrophil moves to the new pin");
  const s3: Session = { ...s2, ...c1 };
  ok(reviewRows(s3).length === 3 && res(s3, "s3", 1).status === "wrong", "carried-over row leaves the review; the grade counts");

  // a person grades a new pin: the row is done, and carry over can't overwrite it
  const np2 = newOf("s2").id;
  const gMe = { ...s3.grades, groups: { ...s3.grades.groups, me: grp("me", [np2], "wrong", "Eosinophil") }, pinGroup: { ...s3.grades.pinGroup, [np2]: "me" } };
  const s4: Session = { ...s3, grades: gMe };
  const stale = reviewRows(s3).find((x) => x.newPin?.id === np2)!;
  ok(!reviewRows(s4).some((x) => x.newPin?.id === np2), "a person grading the new pin settles its row");
  const c4 = carryOver(s4, [{ ...stale, newGrade: gMe.groups.me }]);
  ok(c4.grades.groups[c4.grades.pinGroup[np2]].text === "Eosinophil", "carry over never replaces a person's grade");

  // the answer key graded the new pin: still listed, and carrying over replaces the key's grade
  const gKey = { ...s3.grades, groups: { ...s3.grades.groups, k: grp("k", [np2], "wrong", "Mast cell", KEY) }, pinGroup: { ...s3.grades.pinGroup, [np2]: "k" } };
  const s5: Session = { ...s3, grades: gKey };
  const kr = reviewRows(s5).find((x) => x.newPin?.id === np2)!;
  ok(kr?.newGrade?.by === KEY && canCarry(kr), "a key-graded new pin stays listed and can take the old grade");
  const c2 = carryOver(s5, [kr]);
  const kg = c2.grades.groups[c2.grades.pinGroup[np2]];
  ok(kg.by === undefined && kg.status === "correct", "carry over replaces the key's grade with the old one (yours)");
  ok(reviewRows({ ...s5, ...dismissRows(s5, [kr]) }).every((x) => x.newPin?.id !== np2), "keep the key's grade: the row is done");

  // restore: the removed pin counts again, with its grade; accept removal just closes the row
  const rm = reviewRows(s3).filter((x) => x.kind === "removed");
  const s6: Session = { ...s3, ...restorePins(s3, rm.filter((x) => x.id === "p4")) };
  ok(s6.pins.some((p) => p.id === "p4" && p.restored) && s6.grades.groups[s6.grades.pinGroup.p4]?.status === "correct" && res(s6, "s4", 1).status === "correct", "restore: p4 counts again, still correct");
  ok(!s6.retired!.some((x) => x.pin.id === "p4"), "a restored pin is no longer retired");
  const s7: Session = { ...s6, ...dismissRows(s6, reviewRows(s6).filter((x) => x.id === "p5")) };
  ok(!reviewRows(s7).some((x) => x.id === "p5") && s7.retired!.some((x) => x.pin.id === "p5"), "accept removal: off the list, the old pin stays retired");

  // rescanning again: the restored pin isn't retired again; nothing else changes
  const again = mergeRescan(s7, scan);
  ok(again.added.length === 0 && again.removed === 0 && again.pins.some((p) => p.id === "p4"), "a second rescan finds nothing new, and keeps the restored pin");

  // the double-pin rule ignores retired pins: s1 replaces Q1 with two pins, then takes one out
  const others = scan.pins.filter((p) => p.studentId !== "ns1");
  const two = mergeRescan(s, { ...scan, pins: [...others, P("y1", "ns1", "A", 1, 300, "Q1a"), P("y2", "ns1", "A", 1, 400, "Q1b")] });
  const st2: Session = { ...s, students: two.students, pins: two.pins, retired: two.retired, grades: two.grades };
  ok(doublePinIds(st2.pins, 1, st2.grades).size === 2 && reviewRows(st2).some((x) => x.studentId === "s1" && x.double && !canCarry(x)), "two new pins: double-pin rule, no carry over");
  const one = mergeRescan(st2, { ...scan, pins: [...others, P("y1", "ns1", "A", 1, 300, "Q1a")] });
  const st3: Session = { ...st2, students: one.students, pins: one.pins, retired: one.retired, grades: one.grades };
  ok(doublePinIds(st3.pins, 1, st3.grades).size === 0 && one.retired.filter((x) => x.pin.studentId === "s1" && x.q === 1).length === 2, "the retired second pin no longer makes a double");
  const s1row = reviewRows(st3).find((x) => x.studentId === "s1" && x.q === 1);
  ok(!!s1row && s1row.old.pin.id === "p1" && canCarry(s1row), "the original grade is still offered for the pin that remains");

  // the answer key ignores retired pins; old session files (no retired list) still load and rescan
  const keyAll: AnswerKey = { ...emptyKey(), marks: [newMark(1, "A", "correct", "", [{ kind: "brush", mode: "add", pts: [{ x: 100, y: 0 }], rNm: 20 }])] };
  ok(planKey(s2, keyAll, 4).grade.length === 0, "the answer key never grades a retired pin");
  const oldFile = JSON.parse(JSON.stringify(s)) as Session;
  ok(oldFile.retired === undefined && reviewRows(oldFile).length === 0 && mergeRescan(oldFile, scan).retired.length === 4, "old session files (no retired pins) load and rescan");
}

// ---- review: one student across the exam; ledger search and filters ----
{
  const S = { ...session, grades: { groups: { ...g.groups }, pinGroup: { ...g.pinGroup }, assign: {} } } as Session;
  // the earlier test grade: a student in the big Q1 cluster is correct on Q1
  const sum = studentSummary(S, stu, defaultSettings);
  const a1 = sum.answers[0];
  ok(sum.answers.length === questions.length && sum.answers.map((a) => a.q).join() === [...questions].map((q: any) => q.num).sort((x: number, y: number) => x - y).join(), "student view lists every included question in order");
  ok(a1.kind === "correct" && a1.label === "Correct" && a1.by === "You" && a1.pins.length === 1 && a1.pins[0].taskId === t9.id, `Q1 correct by You with its pin (${a1.kind}, ${a1.by})`);
  ok(sum.score === 1 && sum.total === questions.length && sum.feedback === feedbackText(studentResults(S, stu, defaultSettings), defaultSettings).text, "score and feedback match the export");
  ok(sum.answers.slice(1).every((a) => a.kind !== "correct"), "other questions not correct yet");
  ok(sum.name === `${parseStudentName(stu.folder).surname}, ${parseStudentName(stu.folder).first}` && sum.uid === parseStudentName(stu.folder).uid, `name and UID: ${sum.name} ${sum.uid}`);
  // a double-pin student: AUTO wrong, both pins listed
  const d1 = studentSummary(S, dbl, defaultSettings).answers[0];
  ok(d1.kind === "double" && d1.by === "AUTO" && d1.pins.length > 1 && d1.reason === defaultSettings.doubleMessage, `double pins: ${d1.label}`);
  // a student with no pin for a question
  const none = students.find((s) => !pins.some((p) => p.studentId === s.id && (p.q === q1 || p.candidates.includes(q1))));
  if (none) ok(studentSummary(S, none, defaultSettings).answers[0].kind === "none", "no pin → No answer");
  // out with a guest; then a disagreement
  const p0 = a1.pins[0].pin.id;
  const S2 = { ...S, grades: { ...S.grades, groups: {}, pinGroup: {} }, handoffs: [{ id: "h", guest: "Jamie", createdAt: 0, taskIds: [t9.id], pinIds: [p0], status: "out" as const }] };
  const aw = studentSummary(S2, stu, defaultSettings).answers[0];
  ok(aw.kind === "away" && aw.label === "With Jamie" && aw.pins[0].away === "Jamie", `pin out with a guest: ${aw.label}`);
  const S3 = { ...S2, handoffs: [], grades: { ...S2.grades, checks: { [p0]: { taskId: t9.id, graders: ["Jamie", HOST], verdicts: [], state: "conflict" as const } } } };
  ok(studentSummary(S3, stu, defaultSettings).answers[0].kind === "conflict", "disagreement shown");
  // an unlabelled pin shows on each question it could answer
  const amb = pins.find((p) => p.q === null && p.candidates.length > 1);
  if (amb) {
    const as = studentSummary(S, students.find((s) => s.id === amb.studentId)!, defaultSettings).answers;
    ok(amb.candidates.every((q) => as.find((a) => a.q === q)!.pins.some((p) => p.pin.id === amb.id && p.unlabelled)), "unlabelled pin listed under each possible question");
  }
  // finding students: by surname, first name or UID, sorted by surname
  const uid = parseStudentName(stu.folder).uid;
  ok(findStudents(students, uid).map((s) => s.id).join() === stu.id, `find by UID ${uid}`);
  const sur = parseStudentName(stu.folder).surname;
  const bySur = findStudents(students, sur.toLowerCase());
  ok(bySur.some((s) => s.id === stu.id) && bySur.every((s) => s.folder.toLowerCase().includes(sur.toLowerCase())), `find by surname ${sur}: ${bySur.length}`);
  const sorted = findStudents(students, "").map((s) => studentLabel(s).name);
  ok(sorted.length === students.length && sorted.every((n, i) => i === 0 || sorted[i - 1].localeCompare(n) <= 0), "all students sorted by surname");
  ok(findStudents(students, "zzzz-nobody").length === 0, "no match");

  // ledger filters
  const G = (id: string, status: "correct" | "wrong", text: string, pinIds: string[], by?: string) => ({ id, taskId: t9.id, status, text, pinIds, createdAt: 1, ...(by ? { by } : {}) });
  const gs = [G("a", "wrong", "Neutrophil", ["p1"]), G("b", "correct", "", ["p2"]), G("c", "wrong", "Mast cell", ["p3"], "Jamie"), G("d", "correct", "borderline", ["p4"], "Jamie & Sam")];
  const nm = (id: string) => ({ p1: "Okafor, Hana", p2: "Smith, Jo", p3: "Lee, Ann", p4: "Brown, Isla" })[id] ?? "";
  const ids = (f: Partial<LedgerFilter>) => filterGroups(gs, { ...noFilter, ...f }, nm).map((x) => x.id).join();
  ok(ids({}) === "a,b,c,d" && !isFiltered(noFilter), "no filter: everything");
  ok(ids({ status: "wrong" }) === "a,c" && ids({ status: "correct" }) === "b,d", "wrong only / correct only");
  ok(ids({ grader: HOST }) === "a,b" && ids({ grader: "Jamie" }) === "c" && ids({ grader: "Jamie & Sam" }) === "d", "by grader");
  ok(ids({ query: "neutro" }) === "a" && ids({ query: "MAST" }) === "c" && ids({ query: "border" }) === "d", "search reasons (any case)");
  ok(ids({ query: "okafor" }) === "a" && ids({ query: "isla" }) === "d", "search student names");
  ok(ids({ query: "correct" }) === "b,d", "search 'correct' finds correct rows");
  ok(ids({ query: "lee mast", status: "wrong", grader: "Jamie" }) === "c" && ids({ query: "lee", status: "correct" }) === "", "filters combine");
  const opts = graderOptions(gs, true);
  ok(opts.map((o) => o.label).join() === "You,Jamie,Jamie & Sam,AUTO (double pins)" && opts.at(-1)!.key === AUTO, `grader options: ${opts.map((o) => o.label)}`);
  ok(graderOptions([gs[2]], false).map((o) => o.label).join() === "Jamie", "only graders present");
  ok(rowPasses({ ...noFilter, grader: AUTO }, { status: "wrong", grader: AUTO, text: "x", names: [] }) && !rowPasses({ ...noFilter, grader: HOST }, { status: "wrong", grader: AUTO, text: "x", names: [] }), "AUTO rows follow the grader filter");
  ok(!rowPasses({ ...noFilter, status: "correct" }, { status: "wrong", grader: AUTO, text: "x", names: [] }), "AUTO rows count as wrong");
  // AUTO rows: one per image, ungraded double pins only
  const ar = autoRows(S, tasks);
  ok(ar.length > 0 && ar.every((r) => r.pins.every((p) => p.slide === r.task.slide && !S.grades.pinGroup[p.id] && doublePinIds(pins, r.task.q, S.grades).has(p.id))), `AUTO rows on ${ar.length} images`);
  ok(ar.find((r) => r.task.id === t9.id)!.pins.length === [...doublePinIds(pins, q1, g)].filter((id) => pins.find((p) => p.id === id)!.slide === t9.slide).length, "AUTO row for this image matches the double pins");
}

// ---- help wiki (docs/help): parses, nested lists survive, every link/anchor/image exists ----
{
  const dir = path.resolve("../docs/help"); // run from app/
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  const docs = new Map(files.map((f) => [f, parseMarkdown(fs.readFileSync(path.join(dir, f), "utf8"))]));
  ok(files.includes("index.md") && files.length >= 8, `help articles: ${files.length}`);
  const bad: string[] = [];
  for (const [f, d] of docs) {
    if (!d.meta.title) bad.push(`${f}: no title`);
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    for (const m of src.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) if (!fs.existsSync(path.join(dir, m[1]))) bad.push(`${f}: image ${m[1]}`);
    for (const m of src.matchAll(/(?<!!)\[[^\]\n]*\]\(([^)]+)\)/g)) {
      const href = m[1];
      if (/^https?:/.test(href)) continue;
      const [file, anchor] = href.split("#");
      const target = file ? docs.get(file) : d;
      if (!target) bad.push(`${f}: link ${href}`);
      else if (anchor && !target.headings.some((h) => h.id === anchor)) bad.push(`${f}: anchor ${href}`);
    }
  }
  ok(bad.length === 0, `help links and images resolve${bad.length ? `: ${bad.join("; ")}` : ""}`);
  const ho = docs.get("handoff.md")!;
  const steps = ho.blocks.find((b) => b.t === "ol") as { items: { text: string; sub: string[]; more: string[] }[] } | undefined;
  ok(!!steps && steps.items.length === 4 && steps.items[2].sub.length === 4 && steps.items[2].more.length === 1, `nested list parsed (${steps?.items.map((i) => `${i.sub.length}/${i.more.length}`)})`);
  // every help reference in the app (data-help="a/b", showHelp("a/b"), HELP_ANCHOR, PANEL_HELP) points somewhere real
  const srcDir = path.resolve("src");
  const refs = new Set<string>();
  for (const f of fs.readdirSync(srcDir, { recursive: true }) as string[]) {
    if (!/\.tsx?$/.test(f)) continue;
    const t = fs.readFileSync(path.join(srcDir, f), "utf8");
    for (const m of t.matchAll(/data-help="([^"]+)"|showHelp\("([^"]+)"\)|\[\s*"([a-z-]+\/[a-z0-9-]+)",/g)) refs.add(m[1] ?? m[2] ?? m[3]);
    for (const m of t.matchAll(/HELP_ANCHOR[^=]*=\s*\{([^}]+)\}/g))
      for (const a of m[1].matchAll(/"([^"]+)"/g)) refs.add(`preferences/${a[1]}`);
  }
  refs.delete("article");
  refs.delete("article/section");
  const badRefs = [...refs].filter((r) => {
    const [id, anchor] = r.split("/");
    const d = docs.get(`${id}.md`);
    return !d || (anchor && !d.headings.some((h) => h.id === anchor));
  });
  ok(refs.size > 20 && badRefs.length === 0, `app help references resolve (${refs.size})${badRefs.length ? `: ${badRefs.join(", ")}` : ""}`);
  ok(slug("Mouse & keys") === "mouse--keys" && slug("**Bold** `x` title") === "bold-x-title", "GitHub-style heading ids");
}

// problems found while reading a submissions folder (a crafted copy of a few demo students)
{
  ok(namedQuestion("Q9") === 9 && namedQuestion("question #3 gland") === 3 && namedQuestion("VMS146") === null && namedQuestion("") === null, "namedQuestion");
  const fix = path.resolve("tests/.out/scan-fixture");
  fs.rmSync(fix, { recursive: true, force: true });
  const demoStudents = fs.readdirSync(subDir).filter((f) => !f.startsWith(".")).slice(0, 8);
  for (const s of demoStudents) fs.cpSync(path.join(subDir, s), path.join(fix, s), { recursive: true });
  const [ok1, noId, big, empty, wrongQ, other, broken, many] = demoStudents.map((s) => path.join(fix, s));
  fs.writeFileSync(path.join(noId, "my answers.ndpa"), fs.readFileSync(path.join(noId, "VMS109.ndpi.ndpa")));
  fs.writeFileSync(path.join(big, "VMS133.ndpi.ndpa"), "x".repeat(MAX_NDPA_BYTES + 1));
  fs.rmSync(empty, { recursive: true });
  fs.mkdirSync(empty);
  fs.writeFileSync(path.join(empty, "answers.pdf"), "pdf");
  // a Q9 pin on VMS109 (which is for Q1 and Q2), and no VMS133 file at all
  fs.writeFileSync(path.join(wrongQ, "VMS109.ndpi.ndpa"), fs.readFileSync(path.join(wrongQ, "VMS109.ndpi.ndpa"), "utf8").replace(/<title>[^<]*<\/title>/, "<title>Q9</title>"));
  fs.rmSync(path.join(wrongQ, "VMS133.ndpi.ndpa"));
  fs.copyFileSync(path.join(other, "VMS109.ndpi.ndpa"), path.join(other, "VMS999.ndpi.ndpa"));
  fs.writeFileSync(path.join(broken, "VMS109.ndpi.ndpa"), "<annotations><ndpviewstate>");
  const pin = (i: number) => `<ndpviewstate id="${i}"><title>Q3</title><annotation type="pin"><x>${i * 1000}</x><y>0</y></annotation></ndpviewstate>`;
  fs.writeFileSync(path.join(many, "VMS133.ndpi.ndpa"), `<annotations>${Array.from({ length: 60 }, (_, i) => pin(i)).join("")}</annotations>`);
  fs.writeFileSync(path.join(fix, "exam.pdf"), "a loose file next to the student folders is fine");

  const walk = (d: string): string[] =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name.startsWith(".") ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const io: ScanIO = {
    listFiles: async (d, suffixes = []) => walk(d).filter((f) => !suffixes.length || suffixes.some((s) => f.toLowerCase().endsWith(s))).sort(),
    readText: async (f, max) => {
      if (max != null && fs.statSync(f).size > max) throw new Error(`${f}: file is larger than ${max} bytes`);
      return fs.readFileSync(f, "utf8");
    },
  };
  const scan = await scanSubmissions(fix, questions, io);
  const kinds = (k: string) => scan.problems.filter((p) => p.kind === k);
  const nameOf = (dir: string) => path.basename(dir);
  ok(kinds("no-slide-id").length === 1 && kinds("no-slide-id")[0].file === `${nameOf(noId)}/my answers.ndpa`, "file with no slide ID found");
  ok(kinds("too-large").length === 1 && kinds("too-large")[0].student === nameOf(big), "oversized file found");
  ok(kinds("no-submission").length === 1 && kinds("no-submission")[0].student === nameOf(empty) && /answers\.pdf/.test(kinds("no-submission")[0].detail), "folder with no .ndpa found");
  const uq = kinds("unknown-question");
  ok(uq.length === 1 && uq[0].student === nameOf(wrongQ) && /“Q9”/.test(uq[0].detail) && /there is no Q9/.test(uq[0].detail), `pin titled with a missing question found (${uq[0]?.detail})`);
  ok(kinds("missing-slide").length === 1 && /VMS133 \(Q3, Q4, Q5\)/.test(kinds("missing-slide")[0].detail), `missing slide found (${kinds("missing-slide")[0]?.detail})`);
  ok(kinds("other-slide").length === 1 && /VMS999/.test(kinds("other-slide")[0].detail), "file for a slide not in the exam found");
  ok(kinds("unreadable").length === 1 && kinds("unreadable")[0].student === nameOf(broken), "unreadable file found");
  ok(kinds("too-many-pins").length === 1 && scan.pins.filter((p) => p.studentId === scan.students.find((s) => s.folder === nameOf(many))!.id && p.slide === "VMS133").length === 50, "too many pins: capped at 50");
  ok(scan.problems.length === 8 && !scan.problems.some((p) => p.student === nameOf(ok1)), `8 problems, none for the clean student (${scan.problems.map((p) => p.kind).join(", ")})`);
  ok(groupProblems(scan.problems).map((g) => g.kind).join() === "no-submission,missing-slide,no-slide-id,other-slide,unknown-question,too-many-pins,too-large,unreadable", "problems grouped in order");
  // a question left out on purpose: its slide's files are not problems, and nobody is "missing" it
  const no133 = questions.map((q: any) => ({ ...q, include: !q.slides.includes("VMS133") }));
  const scan2 = await scanSubmissions(fix, no133, io);
  ok(!scan2.problems.some((p) => p.kind === "missing-slide" || p.kind === "too-many-pins" || p.kind === "too-large"), "left-out question's slide is not checked");
  // the demo class itself reads cleanly
  const demo = await scanSubmissions(subDir, questions, io);
  ok(demo.problems.length === 0 && demo.students.length === students.length, `demo class: ${demo.problems.length} problems`);
  // what Start grading → is waiting for
  const w = { examPath: "", questions: [], subDir: "", slidesDir: "", sessionPath: "" };
  ok(startBlockers(w).join() === "the exam (or questions set up by hand),the submissions folder,the slides folder,a save location", "start blockers: everything");
  ok(startBlockers({ ...w, questions: [{ num: 1, slides: ["VMS1"], prompt: "", include: true }], subDir: "s", slidesDir: "i", sessionPath: "p" }).length === 0, "start blockers: questions set up by hand count as the exam");
  ok(startBlockers({ ...w, examPath: "e", questions: no133.map((q: any) => ({ ...q, include: false })), subDir: "s", slidesDir: "i" }).join() === "at least one included question,a save location", "start blockers: no questions, no save path");
  ok(startBlockers({ examPath: "e", questions: no133, subDir: "s", slidesDir: "i", sessionPath: "p" }).length === 0, "start blockers: ready");
}

// ---- exam editor: check questions, describe changes, edit questions inside a session ----
{
  const Q = (num: number, slides: string[], include = true, prompt = `Q${num}`): Question => ({ num, slides, prompt, include });
  const c1 = checkQuestions([Q(1, ["VMS109"]), Q(1, ["VMS133"]), Q(2, []), Q(3, ["ABC"]), Q(4, ["VMS999"])], new Set(["VMS109", "VMS133"]));
  ok(c1.errors.some((e) => /Q1 is used 2 times/.test(e)) && c1.errors.some((e) => /Q2 has no slide/.test(e)) && c1.errors.some((e) => /“ABC” isn't a slide ID/.test(e)), `errors: ${c1.errors.join(" | ")}`);
  ok(c1.warnings.some((w) => /VMS999 isn't in the slides folder/.test(w)), "slide missing from the folder is a warning, not an error");
  ok(checkQuestions([Q(1, ["VMS109"], false)]).errors.includes("Include at least one question.") && checkQuestions([Q(1, ["VMS109"])]).errors.length === 0, "needs one included question; a good list has no errors");
  ok(normSlide("vms 109") === "VMS109" && nextNum([Q(2, ["VMS1"]), Q(7, ["VMS1"])]) === 8 && renumbered([Q(5, ["A"]), Q(2, ["B"])]).map((q) => q.num).join() === "1,2", "slide IDs, next number, renumber");
  const ch = questionChanges([Q(1, ["VMS109"]), Q(2, ["VMS133"]), Q(3, ["VMS133"])], [Q(1, ["VMS109", "VMS110"]), Q(2, ["VMS133"], false, "new words"), Q(4, ["VMS200"])]);
  ok(ch.map((c) => `${c.q}:${c.kind}`).join() === "1:slides,2:prompt,2:left-out,3:removed,4:added", `changes: ${ch.map((c) => `${c.q}:${c.kind}`).join()}`);
  const ex = JSON.parse(examJson("Prac", [Q(2, ["VMS133"]), Q(1, ["VMS109"])]));
  ok(ex.name === "Prac" && ex.questions.map((q: Question) => q.num).join() === "1,2" && ex.questions[0].slides[0] === "VMS109", "exam file: sorted, same format the wizard reads");

  // inside a session: slide A only had Q1, so a pin titled "Q2" was graded as Q1. Adding Q2 on A moves it.
  const P = (id: string, stu: string, slide: string, q: number | null, title: string, x = 0) =>
    ({ id, studentId: stu, slide, rawTitle: title, details: "", q, candidates: [], titleGuessed: false, xNm: x, yNm: 0, annotationType: "pin" }) as Pin;
  const s0: Session = {
    version: 1, name: "E", createdAt: 0, savedAt: 0, sessionPath: "/e.msgrade", submissionsDir: "/subs", slidesDir: "/s",
    questions: [Q(1, ["A", "B"])],
    students: [{ id: "s1", name: "s1", folder: "s1" }, { id: "s2", name: "s2", folder: "s2" }],
    pins: [P("p1", "s1", "A", 1, "Q1"), P("p2", "s2", "A", 1, "Q2", 50), P("p3", "s1", "B", 1, "Q1", 9)],
    slides: [], taskIndex: 0,
    grades: { groups: { g1: { id: "g1", taskId: "Q1|A", status: "correct", text: "", pinIds: ["p1"], createdAt: 1 }, g2: { id: "g2", taskId: "Q1|A", status: "wrong", text: "Q2 answer", pinIds: ["p2"], createdAt: 1 }, g3: { id: "g3", taskId: "Q1|B", status: "correct", text: "", pinIds: ["p3"], createdAt: 1 } }, pinGroup: { p1: "g1", p2: "g2", p3: "g3" }, assign: {} },
  };
  const scanOf = (pins: Pin[]) => ({ students: s0.students.map((x) => ({ ...x, id: `n${x.id}` })), pins: pins.map((p) => ({ ...p, id: `x${p.id}`, studentId: `n${p.studentId}` })) });
  // the edited exam: Q2 added on A, and Q1 no longer uses B (so p3's file isn't read any more)
  const after = [Q(1, ["A"]), Q(2, ["A"])];
  const plan = planQuestionEdit(s0, after, scanOf([P("p1", "s1", "A", 1, "Q1"), P("p2", "s2", "A", 2, "Q2", 50)]));
  ok(plan.changes.map((c) => `${c.q}:${c.kind}`).join() === "1:slides,2:added", `plan changes: ${plan.changes.map((c) => `${c.q}:${c.kind}`).join()}`);
  ok(plan.regraded === 1 && !plan.grades.pinGroup.p2 && plan.merged.pins.find((p) => p.id === "p2")?.q === 2, "the Q2 pin graded as Q1 loses that grade and now answers Q2");
  ok(!!plan.grades.pinGroup.p1 && plan.retired === 1 && plan.merged.retired[0].pin.id === "p3" && !plan.merged.retired[0].review, "other grades kept; the dropped slide's pin steps aside quietly (grade kept, not up for review)");
}

// ---- time spent: capping breaks, sharing an action's time, per question / grader / student, pairs ----
{
  ok(activeSecs(0, 30_000) === 30 && activeSecs(0, 10 * 60_000) === IDLE_CAP && activeSecs(5000, 0) === 0, "breaks over the cap count as the cap");
  ok(fmtDuration(7.44) === "7.4 s" && fmtDuration(95) === "1 min 35 s" && fmtDuration(3725) === "1 h 2 min", "durations read as s / min / h");
  const P = (id: string, stu: string, q: number) =>
    ({ id, studentId: stu, slide: "A", rawTitle: "", details: "", q, candidates: [], titleGuessed: false, xNm: 0, yNm: 0, annotationType: "pin" }) as Pin;
  const ts: Session = {
    version: 1, name: "T", createdAt: 0, savedAt: 0, sessionPath: "/t.msgrade", submissionsDir: "", slidesDir: "",
    questions: [{ num: 1, slides: ["A"], prompt: "", include: true }, { num: 2, slides: ["A"], prompt: "", include: true }],
    students: [{ id: "s1", name: "One", folder: "One" }, { id: "s2", name: "Two", folder: "Two" }],
    pins: [P("a", "s1", 1), P("b", "s2", 1), P("c", "s1", 2), P("d", "s2", 2)],
    slides: [], taskIndex: 0,
    grades: {
      groups: { k: { id: "k", taskId: "Q2|A", status: "correct", text: "", pinIds: ["d"], createdAt: 0, by: KEY } }, pinGroup: { d: "k" }, assign: {},
      checks: {
        a: { taskId: "Q1|A", graders: [HOST, "Jo"], state: "agreed", verdicts: [{ by: HOST, status: "correct", text: "", at: 0 }, { by: "Jo", status: "correct", text: "", at: 0 }] },
        b: { taskId: "Q1|A", graders: [HOST, "Jo"], state: "conflict", verdicts: [{ by: HOST, status: "correct", text: "", at: 0 }, { by: "Jo", status: "wrong", text: "Mast cell", at: 0 }] },
      },
    },
    timeLog: [
      { at: 1, taskId: "Q1|A", pinIds: ["a", "b"], secs: 20 }, // you: 10 s each
      { at: 2, taskId: "Q2|A", pinIds: ["c"], secs: 30 },
      { at: 3, taskId: "Q1|A", pinIds: ["a"], secs: 8, by: "Jo", pack: "p" },
      { at: 4, taskId: "Q1|A", pinIds: ["b"], secs: 2, by: "Jo", pack: "p" },
    ],
  };
  const tr = timeReport(ts);
  ok(tr.totalSecs === 60 && tr.pins === 3 && tr.keyPins === 1, `totals: ${tr.totalSecs} s over ${tr.pins} pins, ${tr.keyPins} by the key`);
  ok(tr.byQuestion.map((r) => `${r.label}:${r.secs}/${r.pins}/${r.students}`).join() === "Q1:30/2/2,Q2:30/1/1", `by question: ${tr.byQuestion.map((r) => `${r.label}:${r.secs}/${r.pins}/${r.students}`).join()}`);
  ok(tr.byGrader.map((r) => `${r.label}:${r.secs}`).join() === "You:50,Jo:10", `by grader: ${tr.byGrader.map((r) => `${r.label}:${r.secs}`).join()}`);
  ok(tr.matrix[0].graders[HOST] === 10 && tr.matrix[0].graders.Jo === 5 && tr.matrix[1].graders.Jo === null, "question × grader seconds per pin");
  ok(tr.byStudent[0].label === "One" && tr.byStudent[0].secs === 48, `slowest student: ${tr.byStudent[0].label} ${tr.byStudent[0].secs} s`);
  const pr = tr.pairs[0];
  ok(!!pr && pr.pins === 2 && pr.aPerPin === 10 && pr.bPerPin === 5 && pr.agreedPerPin === 9 && pr.disagreedPerPin === 6, `pair: ${JSON.stringify(pr)}`);
  const csv = timeCsv(tr);
  ok(csv.some((r) => r[0] === "Q1" && r[4] === "15.0") && csv.some((r) => r[0] === "You & Jo"), "time-stats.csv has the tables");
  // a guest's results bring their time; sending again replaces it
  const host: Session = { ...ts, timeLog: [ts.timeLog![0]], handoffs: [{ id: "p", guest: "Jo", createdAt: 0, taskIds: ["Q1|A"], pinIds: ["a", "b"], status: "out" }], grades: { groups: {}, pinGroup: {}, assign: {} } };
  const res = (secs: number) => parseResult(JSON.stringify({ kind: "msg-handoff-result", version: 1, packId: "p", guest: "Jo", sentAt: 1, assign: {}, groups: [], timeLog: [{ at: 1, taskId: "Q1|A", pinIds: ["a", "zzz"], secs }] }));
  const m1 = mergeResult(host, res(9999));
  ok(m1.timeLog.length === 2 && m1.timeLog[1].by === "Jo" && m1.timeLog[1].secs === IDLE_CAP && m1.timeLog[1].pinIds.join() === "a", "guest time merged, capped, only the pack's pins");
  const m2 = mergeResult({ ...host, timeLog: m1.timeLog, handoffs: m1.handoffs }, res(12));
  ok(m2.timeLog.length === 2 && m2.timeLog[1].secs === 12, "a re-sent results file replaces the earlier time");
}

// ---- ruler: lengths, areas and how they read ----
{
  const sq = [{ x: 0, y: 0 }, { x: 100_000, y: 0 }, { x: 100_000, y: 100_000 }, { x: 0, y: 100_000 }]; // 100 µm square
  ok(area(sq) === 1e10 && fmtArea(area(sq)) === "10,000 µm²", `area of a 100 µm square: ${fmtArea(area(sq))}`);
  ok(fmtLength(perimeter(sq)) === "400 µm" && fmtLength(dist(sq[0], sq[2])) === "141 µm", "perimeter and diagonal");
  ok(fmtLength(8_400) === "8.40 µm" && fmtLength(24_500) === "24.5 µm" && fmtLength(1_240_000) === "1.24 mm", "lengths read as µm or mm");
  ok(fmtArea(3.1e10) === "31,000 µm²" && fmtArea(3.1e11) === "0.31 mm²", "areas switch to mm² from 100,000 µm²");
  ok(area([...sq].reverse()) === 1e10, "outline drawn either way round");
  ok(measureLabel({ kind: "line", pts: [sq[0], sq[1]] }) === "100 µm" && measureLabel({ kind: "area", pts: sq }).startsWith("10,000 µm² · perimeter 400 µm"), "labels");
}

// ---- the stylesheet is well-formed (a broken merge once nested every rule after it) ----
{
  const css = fs.readFileSync(path.resolve("src/App.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  let depth = 0, bad = 0, line = 1, at: number[] = [];
  for (const ln of css.split("\n")) {
    const t = ln.trim();
    if (t.startsWith("@") && t.endsWith("{")) at.push(depth);
    // a plain rule opening while inside another plain rule means a missing "}"
    if (depth > 0 && !at.length && /^[.#a-z\[*:][^;]*\{$/i.test(t) && !bad) bad = line;
    depth += (t.match(/\{/g)?.length ?? 0) - (t.match(/\}/g)?.length ?? 0);
    while (at.length && depth <= at[at.length - 1]) at.pop();
    line++;
  }
  ok(depth === 0 && !bad, `App.css braces balance${bad ? ` (unclosed rule before line ${bad})` : ""}`);
}

process.exit(fails ? 1 : 0);
