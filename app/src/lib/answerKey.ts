/**
 * Answer key: the instructor paints where the right answer (and common wrong answers) are for each
 * question on each slide. Student pins that land in a mark are graded by the key, now and as new
 * submissions are added, or (in "suggest" mode) only suggested to the grader.
 *
 * Marks are painted areas in slide coordinates (nm), the same shapes as "paint with pins hidden".
 */
import type { GradeState, Pin, Session } from "./types";
import { cloneGrades, detach, doublePinIds, effectiveQ, pinMap, taskId } from "./grading";
import { applyVerdicts, awayPins, KEY } from "./handoff";
import { isPainted, type PaintOp } from "./paint";
import { uid } from "./util";

export interface KeyMark {
  id: string;
  q: number;
  slide: string;
  kind: "correct" | "wrong";
  /** for wrong answers: what the students marked instead (goes into their feedback) */
  reason: string;
  ops: PaintOp[];
  createdAt: number;
}

export interface AnswerKey {
  marks: KeyMark[];
  /** grade matching pins outright, or only suggest them to the grader */
  mode: "grade" | "suggest";
  /** grade new submissions with the key when they're added (Rescan submissions) */
  autoNew: boolean;
}

export const emptyKey = (): AnswerKey => ({ marks: [], mode: "grade", autoNew: true });

export const newMark = (q: number, slide: string, kind: KeyMark["kind"], reason: string, ops: PaintOp[]): KeyMark => ({
  id: uid(),
  q,
  slide,
  kind,
  reason: kind === "wrong" ? reason.trim().slice(0, 2000) : "",
  ops,
  createdAt: Date.now(),
});

/** What the key says about one pin. */
export type KeyMatch =
  | { kind: "none" }
  /** the pin is in marks that disagree (a correct and a wrong area, or two different reasons, or two questions) */
  | { kind: "conflict"; marks: KeyMark[] }
  | { kind: "match"; mark: KeyMark; q: number };

/** marks on this pin's slide for a question the pin could be answering */
function marksFor(key: AnswerKey, p: Pin, g: GradeState) {
  const q = effectiveQ(p, g);
  const qs = q !== null ? [q] : p.candidates;
  return key.marks.filter((m) => m.slide === p.slide && qs.includes(m.q));
}

export function matchPin(key: AnswerKey, p: Pin, g: GradeState): KeyMatch {
  const hits = marksFor(key, p, g).filter((m) => isPainted(m.ops, p.xNm, p.yNm));
  if (!hits.length) return { kind: "none" };
  const same = (a: KeyMark, b: KeyMark) =>
    a.q === b.q && a.kind === b.kind && (a.kind === "correct" || a.reason.trim().toLowerCase() === b.reason.trim().toLowerCase());
  if (hits.every((m) => same(m, hits[0]))) return { kind: "match", mark: hits[0], q: hits[0].q };
  return { kind: "conflict", marks: hits };
}

/**
 * How far applying the key reaches, from least to most:
 *  0 nothing now (only new submissions) · 1 ungraded pins · 2 + pins the key graded before
 *  3 + other graders' grades (keep mine) · 4 everything, including my own grades
 */
export type KeyLevel = 0 | 1 | 2 | 3 | 4;

export interface KeyPlan {
  /** pins to grade by the key */
  grade: { pinId: string; mark: KeyMark; q: number }[];
  /** key grades to remove: pins the key graded before that no longer land in any mark */
  clear: string[];
  /** pins the plan leaves for a person because marks disagree on them */
  conflicts: number;
  /** pins in reach that land in no mark */
  unmatched: number;
  /** grades by people this plan replaces */
  replaces: number;
}

/**
 * Work out what applying the key would do. `only` limits it to some pins (new submissions).
 * Never touched: students with more than one pin for the question, pins out with another grader,
 * and pins graded twice.
 */
export function planKey(s: Session, key: AnswerKey, level: KeyLevel, only?: Set<string>): KeyPlan {
  const plan: KeyPlan = { grade: [], clear: [], conflicts: 0, unmatched: 0, replaces: 0 };
  if (level === 0 && !only) return plan;
  const g = s.grades;
  const away = awayPins(s);
  const doubles = new Map<number, Set<string>>();
  const isDouble = (p: Pin, q: number) => {
    if (!doubles.has(q)) doubles.set(q, doublePinIds(s.pins, q, g));
    return doubles.get(q)!.has(p.id);
  };
  for (const p of s.pins) {
    if (only && !only.has(p.id)) continue;
    if (away.has(p.id) || g.checks?.[p.id]) continue;
    const grp = g.groups[g.pinGroup[p.id]];
    // who gave the current grade decides whether this level may change it
    const reach = !grp ? 1 : grp.by === KEY ? 2 : grp.by ? 3 : 4;
    if (reach > Math.max(level, only ? 1 : 0)) continue;
    const m = matchPin(key, p, g);
    if (m.kind === "match") {
      if (isDouble(p, m.q)) continue;
      if (grp && grp.by === KEY && grp.status === m.mark.kind && grp.text === m.mark.reason) continue; // already so
      plan.grade.push({ pinId: p.id, mark: m.mark, q: m.q });
      if (grp && grp.by !== KEY) plan.replaces++;
    } else if (m.kind === "conflict") plan.conflicts++;
    else {
      plan.unmatched++;
      if (grp?.by === KEY) plan.clear.push(p.id); // its mark was removed or moved
    }
  }
  return plan;
}

/** Carry out a plan: one new grade state (one undo step). */
export function applyPlan(s: Session, plan: KeyPlan): GradeState {
  const g = cloneGrades(s.grades);
  detach(g, plan.clear);
  for (const id of plan.clear) delete g.assign[id];
  const pins = pinMap(s.pins);
  applyVerdicts(
    g,
    plan.grade.map(({ pinId, mark, q }) => {
      const pin = pins.get(pinId)!;
      return { pinId, taskId: taskId(q, pin.slide), v: { by: KEY, status: mark.kind, text: mark.reason }, assignQ: q, pin };
    }),
  );
  return g;
}

/**
 * Suggest mode: what the key says about some pins (e.g. the current cluster's ungraded ones),
 * grouped so the grader can accept it in one go.
 */
export function suggest(key: AnswerKey, pins: Pin[], g: GradeState) {
  const correct: string[] = [];
  const wrong = new Map<string, string[]>();
  let none = 0;
  for (const p of pins) {
    const m = matchPin(key, p, g);
    if (m.kind !== "match") none++;
    else if (m.mark.kind === "correct") correct.push(p.id);
    else wrong.set(m.mark.reason, [...(wrong.get(m.mark.reason) ?? []), p.id]);
  }
  return { correct, wrong, none };
}

/** How many of these pins land in a mark. */
export const markPins = (mark: KeyMark, pins: Pin[]) =>
  pins.filter((p) => p.slide === mark.slide && isPainted(mark.ops, p.xNm, p.yNm)).length;

// ---------------------------------------------------------------- key files (.msgkey)

export interface KeyFile {
  kind: "msg-key";
  version: 1;
  exam: string;
  savedAt: number;
  mode: AnswerKey["mode"];
  marks: KeyMark[];
}

export const makeKeyFile = (s: Session, key: AnswerKey): KeyFile => ({
  kind: "msg-key",
  version: 1,
  exam: s.name,
  savedAt: Date.now(),
  mode: key.mode,
  marks: key.marks,
});

const isOps = (ops: unknown): ops is PaintOp[] =>
  Array.isArray(ops) &&
  ops.length <= 500 &&
  ops.every(
    (o) =>
      o &&
      (o.kind === "brush" || o.kind === "poly") &&
      (o.mode === "add" || o.mode === "remove") &&
      Array.isArray(o.pts) &&
      o.pts.length <= 5000 &&
      o.pts.every((p: { x: unknown; y: unknown }) => Number.isFinite(p?.x) && Number.isFinite(p?.y)) &&
      (o.kind === "poly" || Number.isFinite(o.rNm)),
  );

/**
 * Read a key file for this session. Marks for questions or slides the session doesn't have are skipped.
 * Returns the usable marks and how many were skipped.
 */
export function parseKeyFile(raw: string, s: Pick<Session, "questions">): { file: KeyFile; marks: KeyMark[]; skipped: number } {
  const f = JSON.parse(raw) as KeyFile;
  if (f?.kind !== "msg-key") throw new Error("This isn't a Micro Speed Grader answer key.");
  if (typeof f.version === "number" && f.version > 1)
    throw new Error("This answer key was made by a newer version of Micro Speed Grader. Update the app and try again.");
  if (f.version !== 1 || !Array.isArray(f.marks)) throw new Error("This answer key file is damaged.");
  const slidesOf = new Map(s.questions.map((q) => [q.num, new Set(q.slides)]));
  const marks: KeyMark[] = [];
  let skipped = 0;
  for (const m of f.marks.slice(0, 5000)) {
    const ok =
      m &&
      Number.isInteger(m.q) &&
      typeof m.slide === "string" &&
      (m.kind === "correct" || m.kind === "wrong") &&
      isOps(m.ops) &&
      slidesOf.get(m.q)?.has(m.slide);
    if (!ok) {
      skipped++;
      continue;
    }
    marks.push({ ...newMark(m.q, m.slide, m.kind, String(m.reason ?? ""), m.ops), createdAt: Number(m.createdAt) || Date.now() });
  }
  return { file: f, marks, skipped };
}
