/**
 * The exam question editor: check questions, save them as an exam file, and (inside a session)
 * work out and apply what changing the questions does to the students' pins and grades.
 *
 * Questions are identified by number everywhere: a student's pin titled "Q3" answers question 3, and
 * grades are filed under "Q3|VMS133". So inside a session numbers of existing questions are fixed;
 * questions can be added, have their prompt or slides changed, be left out, or be removed.
 */
import type { GradeState, Pin, Question, Session, Student } from "./types";
import { cloneGrades, detach, parseTaskId } from "./grading";
import { mergeRescan, type RescanResult } from "./rescan";

export const SLIDE_RE = /^VMS\d+$/;

/** Problems that stop the questions being used, and softer warnings. */
export function checkQuestions(qs: Question[], available?: Set<string>): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const seen = new Map<number, number>();
  for (const q of qs) seen.set(q.num, (seen.get(q.num) ?? 0) + 1);
  for (const [n, k] of seen) if (k > 1) errors.push(`Q${n} is used ${k} times: give each question its own number.`);
  for (const q of qs) {
    if (!Number.isInteger(q.num) || q.num < 1) errors.push(`A question has no number (it needs a whole number from 1).`);
    if (!q.slides.length) errors.push(`Q${q.num} has no slide.`);
    for (const s of q.slides) {
      if (!SLIDE_RE.test(s)) errors.push(`Q${q.num}: “${s}” isn't a slide ID like VMS109.`);
      else if (available && !available.has(s)) warnings.push(`Q${q.num}: ${s} isn't in the slides folder, so it can't be graded.`);
    }
    if (q.include && !q.prompt.trim()) warnings.push(`Q${q.num} has no prompt text.`);
  }
  if (!qs.some((q) => q.include)) errors.push("Include at least one question.");
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

/** "vms 109", "VMS-109" → "VMS109" */
export const normSlide = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** the next free question number */
export const nextNum = (qs: Question[]) => qs.reduce((m, q) => Math.max(m, q.num), 0) + 1;

/** Questions in a new order, numbered 1…n in that order (only before grading starts). */
export const renumbered = (qs: Question[]) => qs.map((q, i) => ({ ...q, num: i + 1 }));

/** The exam file: the same format "Choose exam PDF / JSON…" reads. */
export const examJson = (name: string, qs: Question[]) =>
  JSON.stringify(
    { name, questions: [...qs].sort((a, b) => a.num - b.num).map((q) => ({ num: q.num, slides: q.slides, prompt: q.prompt, include: q.include })) },
    null,
    2,
  );

// ---------------------------------------------------------------- inside a session

export interface QuestionChange {
  q: number;
  kind: "added" | "removed" | "slides" | "prompt" | "included" | "left-out";
  detail: string;
}

/** What differs between the session's questions and the edited ones, in plain words. */
export function questionChanges(before: Question[], after: Question[]): QuestionChange[] {
  const out: QuestionChange[] = [];
  const b = new Map(before.map((q) => [q.num, q]));
  const a = new Map(after.map((q) => [q.num, q]));
  for (const q of after) {
    const o = b.get(q.num);
    if (!o) {
      out.push({ q: q.num, kind: "added", detail: `New question on ${q.slides.join(" or ")}` });
      continue;
    }
    const added = q.slides.filter((s) => !o.slides.includes(s));
    const gone = o.slides.filter((s) => !q.slides.includes(s));
    if (added.length || gone.length)
      out.push({
        q: q.num,
        kind: "slides",
        detail: [added.length ? `adds ${added.join(", ")}` : "", gone.length ? `drops ${gone.join(", ")}` : ""].filter(Boolean).join(", "),
      });
    if (q.prompt.trim() !== o.prompt.trim()) out.push({ q: q.num, kind: "prompt", detail: "Prompt reworded" });
    if (q.include !== o.include) out.push({ q: q.num, kind: q.include ? "included" : "left-out", detail: q.include ? "Now counted in the score" : "No longer counted in the score (its grades are kept)" });
  }
  for (const o of before) if (!a.has(o.num)) out.push({ q: o.num, kind: "removed", detail: "Removed from the exam" });
  return out.sort((x, y) => x.q - y.q);
}

export interface QuestionEditPlan {
  changes: QuestionChange[];
  merged: RescanResult;
  /** grades after the edit */
  grades: GradeState;
  /** pins that weren't part of the session and now are (e.g. on a slide a question now uses) */
  newPins: number;
  /** graded pins that now answer a different question: their old grade no longer applies */
  regraded: number;
  /** pins no longer used (e.g. their slide was taken off the question); their grades are kept aside */
  retired: number;
  /** grades filed under a removed question */
  removedGrades: number;
}

/**
 * Work out an edit. `scan` is the submissions folder read again with the edited questions
 * (scanSubmissions(session.submissionsDir, after)).
 */
export function planQuestionEdit(s: Session, after: Question[], scan: { students: Student[]; pins: Pin[] }): QuestionEditPlan {
  const changes = questionChanges(s.questions, after);
  const merged = mergeRescan({ ...s, questions: after }, scan, { quiet: true });
  const grades = cloneGrades(merged.grades);
  // a graded pin that now answers another question: its grade was for the old one
  const moved: string[] = [];
  for (const p of merged.pins) {
    const gid = grades.pinGroup[p.id];
    if (!gid) continue;
    // an unlabelled pin keeps the question the grader assigned it to
    const now = p.q ?? grades.assign[p.id] ?? null;
    if (now !== null && now !== parseTaskId(grades.groups[gid].taskId).q) moved.push(p.id);
  }
  detach(grades, moved);
  for (const id of moved) delete grades.assign[id];
  const removed = new Set(changes.filter((c) => c.kind === "removed").map((c) => c.q));
  const removedGrades = Object.values(grades.groups)
    .filter((g) => removed.has(parseTaskId(g.taskId).q))
    .reduce((n, g) => n + g.pinIds.length, 0);
  return {
    changes,
    merged,
    grades,
    newPins: merged.added.length,
    regraded: moved.length,
    retired: merged.retired.length - (s.retired?.length ?? 0),
    removedGrades,
  };
}
