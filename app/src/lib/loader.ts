import { DEFAULT_READING_RULES, type Pin, type Question, type SlideRef, type Student, type ReadingRules } from "./types";
import { basename, listFiles, readText } from "./backend";
import { matchTitle, namedQuestion, parseNdpa, slideIdFromFilename } from "./ndpa";

export const SLIDE_EXTS = [".ndpi", ".svs", ".tif", ".tiff", ".mrxs", ".scn", ".vms"];

export async function scanSlides(dir: string): Promise<SlideRef[]> {
  const files = await listFiles(dir, SLIDE_EXTS);
  const out: SlideRef[] = [];
  for (const f of files) {
    const id = slideIdFromFilename(basename(f));
    if (id && !out.some((s) => s.id === id)) out.push({ id, path: f });
  }
  return out;
}

/**
 * Assumed D2L layout (to be adapted once we see a real export):
 *   <submissionsDir>/<student folder>/.../<VMSxxx>.ndpi.ndpa
 * Student identity = first-level folder name.
 */
export interface ScanResult {
  students: Student[];
  pins: Pin[];
  /** things the instructor should check before grading (the wizard's "N things to check") */
  problems: ScanProblem[];
  /** the problems as one line each (logs) */
  warnings: string[];
}

/** What can be wrong in a submissions folder, in the order the list shows them. */
export const SCAN_PROBLEM_KINDS = [
  "no-submission", // a student folder with nothing gradeable
  "missing-slide", // a student has files, but none for an included question's slide
  "no-slide-id", // file name has no slide ID (VMS…), so its pins are left out
  "other-slide", // file for a slide no question in the exam uses
  "unknown-question", // a pin's title names a question that isn't on that slide
  "too-many-pins", // over MAX_PINS_PER_STUDENT_SLIDE: the rest were dropped
  "too-large", // over MAX_NDPA_BYTES: skipped
  "unreadable", // not valid annotation data: skipped
] as const;
export type ScanProblemKind = (typeof SCAN_PROBLEM_KINDS)[number];
export interface ScanProblem {
  kind: ScanProblemKind;
  /** the student's display name */
  student?: string;
  /** path inside the submissions folder (the student's folder for student-level problems) */
  file?: string;
  detail: string;
}

/** A problem's identity across scans (for "acknowledged"): kind + file or folder + what was found. */
export const problemKey = (p: ScanProblem) => `${p.kind}|${p.file ?? p.student ?? ""}|${p.detail}`;

/** Problems grouped by kind, in SCAN_PROBLEM_KINDS order, empty kinds left out. */
export function groupProblems(problems: ScanProblem[]): { kind: ScanProblemKind; items: ScanProblem[] }[] {
  return SCAN_PROBLEM_KINDS.map((kind) => ({ kind, items: problems.filter((p) => p.kind === kind) })).filter((g) => g.items.length);
}

/** What the new-session wizard still needs before it can start (empty when ready). */
export function startBlockers(w: { examPath: string; questions: Question[]; subDir: string; slidesDir: string; sessionPath: string }): string[] {
  const out: string[] = [];
  if (!w.examPath && !w.questions.length) out.push("the exam (or questions set up by hand)");
  else if (!w.questions.some((q) => q.include)) out.push("at least one included question");
  if (!w.subDir) out.push("the submissions folder");
  if (!w.slidesDir) out.push("the slides folder");
  if (!w.sessionPath) out.push("a save location");
  return out;
}

/** File access for the scan: the app's backend by default (the logic tests pass Node's). */
export interface ScanIO {
  listFiles(dir: string, suffixes?: string[]): Promise<string[]>;
  readText(path: string, maxBytes?: number): Promise<string>;
}

/** Student annotation files are a few KB; refuse anything absurd before parsing. */
export const MAX_NDPA_BYTES = 2 * 1024 * 1024;
export const MAX_PINS_PER_STUDENT_SLIDE = 50;

const LOOSE = "(loose files)";
const qList = (nums: number[]) => nums.map((n) => `Q${n}`).join(", ");
const firstFew = (xs: string[], n = 3) => xs.slice(0, n).join(", ") + (xs.length > n ? "…" : "");

/**
 * Read a submissions folder.
 * `fileSlides` says which slide a file is for when its name doesn't (or names the wrong one):
 * path inside the folder → slide ID, as chosen in "Things to check".
 */
/** NDP.view annotation types that mark an area (a pin's position is their centre) */
const AREA_TYPES = new Set(["circle", "rectangle", "freehand", "polygon", "ellipse"]);
/** does an annotation of this type count as an answer under Preferences ▸ Reading submissions? */
export function countsAsAnswer(type: string, count: ReadingRules["count"]): boolean {
  const t = (type || "pin").toLowerCase();
  if (t === "pin") return true;
  if (count === "all") return true;
  return count === "shapes" && AREA_TYPES.has(t);
}

export async function scanSubmissions(
  dir: string,
  questions: Question[],
  io: ScanIO = { listFiles, readText },
  fileSlides: Record<string, string> = {},
  rules: ReadingRules = DEFAULT_READING_RULES,
): Promise<ScanResult> {
  // every file, so a student folder holding only a PDF or a screenshot still shows up as "no submission"
  const all = await io.listFiles(dir, []);
  const files = all.filter((f) => f.toLowerCase().endsWith(".ndpa"));
  const problems: ScanProblem[] = [];
  const root = dir.replace(/[\\/]+$/, "");
  const studentsByFolder = new Map<string, Student>();
  const pins: Pin[] = [];
  const pinsPerStudentSlide = new Map<string, number>();

  const included = questions.filter((q) => q.include);
  const questionsBySlide = new Map<string, number[]>();
  for (const q of included)
    for (const s of q.slides) questionsBySlide.set(s, [...(questionsBySlide.get(s) ?? []), q.num]);
  // every question (included or not) per slide: a file or pin for a left-out question is not a problem
  const examSlides = new Map<string, number[]>();
  for (const q of questions) for (const s of q.slides) examSlides.set(s, [...(examSlides.get(s) ?? []), q.num]);

  const relOf = (f: string) => f.slice(root.length).replace(/^[\\/]+/, "");
  const folderOf = (rel: string) => {
    const segs = rel.split(/[\\/]/);
    return segs.length > 1 ? segs[0] : LOOSE;
  };
  /** per student folder: the included slides they handed a file in for, and their other (non-.ndpa) files */
  const handedIn = new Map<string, Set<string>>();
  const otherFiles = new Map<string, string[]>();
  const isNdpa = new Set(files);
  for (const f of all) {
    const folder = folderOf(relOf(f));
    if (folder === LOOSE && !isNdpa.has(f)) continue; // e.g. the exam PDF next to the student folders
    if (!handedIn.has(folder)) handedIn.set(folder, new Set());
    if (!isNdpa.has(f)) otherFiles.set(folder, [...(otherFiles.get(folder) ?? []), basename(f)]);
  }

  for (const f of files) {
    const rel = relOf(f);
    const folder = folderOf(rel);
    let student = studentsByFolder.get(folder);
    if (!student) {
      student = { id: `s${studentsByFolder.size + 1}`, name: prettyName(folder), folder };
      studentsByFolder.set(folder, student);
    }
    const name = student.name;
    const problem = (kind: ScanProblemKind, detail: string) => problems.push({ kind, student: name, file: rel, detail });
    const slide = fileSlides[rel] ?? slideIdFromFilename(basename(f));
    const slideQs = slide ? questionsBySlide.get(slide) : undefined;
    if (!slide || !slideQs) {
      // slide not used by any included question (one only a left-out question uses is fine)
      if (!slide || !examSlides.has(slide)) {
        if (!slide || !/^VMS\d+$/.test(slide)) problem("no-slide-id", "Its pins were left out");
        else problem("other-slide", `No question in the exam uses ${slide}`);
      }
      continue;
    }
    handedIn.get(folder)!.add(slide);
    let anns;
    try {
      anns = parseNdpa(await io.readText(f, MAX_NDPA_BYTES));
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      if (/larger than/i.test(msg)) problem("too-large", `Larger than ${MAX_NDPA_BYTES / 1024 / 1024} MB`);
      else problem("unreadable", "Not valid annotation data");
      continue;
    }
    // Preferences ▸ Reading submissions: which kinds of annotation count as an answer
    anns = anns.filter((a) => countsAsAnswer(a.type, rules.count));
    // one student can't flood a slide with pins (keeps clustering and grading responsive)
    const key = `${student.id}|${slide}`;
    const have = pinsPerStudentSlide.get(key) ?? 0;
    if (have + anns.length > MAX_PINS_PER_STUDENT_SLIDE) {
      problem("too-many-pins", `${have + anns.length} pins on ${slide}; the first ${MAX_PINS_PER_STUDENT_SLIDE} were kept`);
      anns = anns.slice(0, Math.max(0, MAX_PINS_PER_STUDENT_SLIDE - have));
    }
    pinsPerStudentSlide.set(key, have + anns.length);
    /** pins whose title names a question this slide isn't for */
    const misnamed: { title: string; q: number }[] = [];
    for (const a of anns) {
      const m = matchTitle(a.title, slideQs, rules.bareNumbers);
      const named = m.q === null ? namedQuestion(a.title) : null;
      const elsewhere = named !== null && !examSlides.get(slide)!.includes(named);
      if (elsewhere) misnamed.push({ title: a.title, q: named });
      let q = m.q;
      let guessed = !m.clean;
      let candidates: number[] = [];
      if (q === null) {
        if (elsewhere && rules.otherQuestion === "omit") continue;
        if (slideQs.length === 1) q = slideQs[0];
        // unlabelled: decided after the leftover-question step below
        else candidates = [...slideQs];
        guessed = true;
      }
      pins.push({
        id: `p${pins.length + 1}`,
        studentId: student.id,
        slide,
        rawTitle: a.title,
        details: a.details,
        q,
        candidates,
        titleGuessed: guessed,
        xNm: a.xNm,
        yNm: a.yNm,
        annotationType: a.type,
      });
    }
    if (misnamed.length) {
      const one = misnamed.length === 1 ? misnamed[0] : null;
      const where = one && questions.find((q) => q.num === one.q)?.slides;
      problem(
        "unknown-question",
        `${one ? "Pin" : `${misnamed.length} pins`} titled ${firstFew(misnamed.map((x) => `“${x.title}”`))}, but ${slide} is for ${qList(slideQs)}` +
          (one ? (where ? ` (Q${one.q} uses ${where.join(" or ")})` : ` (there is no Q${one.q})`) : "") +
          (rules.otherQuestion === "omit" ? `. ${one ? "It's" : "They're"} left out (Preferences ▸ Reading submissions).` : ""),
      );
    }
  }

  // student folders with nothing to grade, and students with no file for a slide an included question needs
  const pinCount = new Map<string, number>();
  for (const p of pins) pinCount.set(p.studentId, (pinCount.get(p.studentId) ?? 0) + 1);
  for (const [folder, handed] of handedIn) {
    const student = studentsByFolder.get(folder);
    const name = student?.name ?? prettyName(folder);
    if (!student || !pinCount.get(student.id)) {
      const other = otherFiles.get(folder) ?? [];
      const detail = !student
        ? `No .ndpa files${other.length ? ` (only ${firstFew(other)})` : ""}`
        : handed.size
          ? "Their files have no pins"
          : "None of their .ndpa files is for a slide in the exam";
      problems.push({ kind: "no-submission", student: name, file: folder, detail });
      continue;
    }
    const missing = new Map<string, number[]>();
    for (const q of included)
      if (!q.slides.some((s) => handed.has(s))) {
        const k = q.slides.join(" or ");
        missing.set(k, [...(missing.get(k) ?? []), q.num]);
      }
    if (missing.size && folder !== LOOSE)
      problems.push({
        kind: "missing-slide",
        student: name,
        file: folder,
        detail: `No file for ${[...missing].map(([s, nums]) => `${s} (${qList(nums)})`).join(", ")}`,
      });
  }

  // Ambiguous pins: if the student already answered every other candidate
  // question on this slide, the leftover one is the obvious match.
  // (indexed once per student+slide: a per-pin scan of all pins is quadratic)
  // (Preferences ▸ Reading submissions can turn this off)
  if (rules.leftover) {
    const answeredBy = new Map<string, Set<number>>();
    for (const o of pins)
      if (o.q !== null) {
        const k = `${o.studentId}|${o.slide}`;
        if (!answeredBy.has(k)) answeredBy.set(k, new Set());
        answeredBy.get(k)!.add(o.q);
      }
    for (const p of pins) {
      if (p.q !== null) continue;
      const answered = answeredBy.get(`${p.studentId}|${p.slide}`) ?? new Set<number>();
      const left = p.candidates.filter((c) => !answered.has(c));
      if (left.length === 1) {
        p.q = left[0];
        p.candidates = [];
      } else if (left.length > 1) p.candidates = left;
    }
  }
  // Preferences ▸ Reading submissions: what's still unlabelled goes to the lowest-numbered question, or is left out
  if (rules.unlabelled === "first")
    for (const p of pins)
      if (p.q === null && p.candidates.length) {
        p.q = Math.min(...p.candidates);
        p.candidates = [];
      }
  if (rules.unlabelled === "omit") for (let i = pins.length - 1; i >= 0; i--) if (pins[i].q === null) pins.splice(i, 1);

  const students = [...studentsByFolder.values()].sort((a, b) => a.name.localeCompare(b.name));
  const warnings = problems.map((p) => `${p.file ?? p.student ?? ""}: ${p.detail}`);
  return { students, pins, problems, warnings };
}

function prettyName(folder: string): string {
  // "123456-Smith, Jane" / "Smith, Jane (123456)" -> keep readable
  return folder.replace(/_/g, " ").trim();
}
