import type { GradeState, Pin, Question, Session, Student, Task } from "./types";
import type { Settings } from "./settings";

export const taskId = (q: number, slide: string) => `Q${q}|${slide}`;

export function buildTasks(questions: Question[], availableSlides: Set<string>): Task[] {
  const tasks: Task[] = [];
  for (const q of [...questions].filter((q) => q.include).sort((a, b) => a.num - b.num)) {
    const slides = q.slides.filter((s) => availableSlides.has(s));
    slides.forEach((slide, i) =>
      tasks.push({ id: taskId(q.num, slide), q: q.num, slide, slideIndex: i, slideCount: slides.length }),
    );
  }
  return tasks;
}

/** The question a pin currently belongs to (title match, inference, or grader assignment). */
export const effectiveQ = (p: Pin, g: GradeState): number | null => p.q ?? g.assign[p.id] ?? null;

/** Pins shown while grading a task: those for this question, plus ambiguous ones that could be. */
export function pinsForTask(pins: Pin[], task: Task, g: GradeState): Pin[] {
  return pins.filter((p) => {
    if (p.slide !== task.slide) return false;
    const q = effectiveQ(p, g);
    if (q !== null) return q === task.q;
    return p.candidates.includes(task.q);
  });
}

/** Student ids with more than one pin for a question (across all of its slides). */
export function doublePinIds(pins: Pin[], q: number, g: GradeState): Set<string> {
  const byStudent = new Map<string, string[]>();
  for (const p of pins) {
    if (effectiveQ(p, g) !== q) continue;
    byStudent.set(p.studentId, [...(byStudent.get(p.studentId) ?? []), p.id]);
  }
  const out = new Set<string>();
  for (const ids of byStudent.values()) if (ids.length > 1) ids.forEach((id) => out.add(id));
  return out;
}

export type PinState = "ungraded" | "correct" | "wrong" | "double";

export function pinState(p: Pin, g: GradeState, doubles: Set<string>): PinState {
  const gid = g.pinGroup[p.id];
  if (gid) return g.groups[gid]?.status ?? "ungraded";
  if (doubles.has(p.id)) return "double";
  return "ungraded";
}

export interface QuestionResult {
  q: number;
  status: "correct" | "wrong" | "ungraded";
  text: string;
}

export function studentResults(session: Session, student: Student, settings: Settings): QuestionResult[] {
  const g = session.grades;
  const out: QuestionResult[] = [];
  const mine = session.pins.filter((p) => p.studentId === student.id);
  for (const q of session.questions.filter((q) => q.include).sort((a, b) => a.num - b.num)) {
    const qp = mine.filter((p) => effectiveQ(p, g) === q.num);
    const pending = mine.some((p) => effectiveQ(p, g) === null && p.candidates.includes(q.num));
    const graded = qp.filter((p) => g.pinGroup[p.id]);
    if (qp.length === 0) {
      out.push(
        pending
          ? { q: q.num, status: "ungraded", text: "Ungraded (unlabelled pin)" }
          : { q: q.num, status: "wrong", text: settings.noAnswerMessage },
      );
      continue;
    }
    if (qp.length > 1) {
      // a grader override on any of the pins wins (most recent), else auto-wrong
      const latest = graded
        .map((p) => g.groups[g.pinGroup[p.id]])
        .filter(Boolean)
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      if (latest) out.push({ q: q.num, status: latest.status, text: resultText(latest.status, latest.text) });
      else out.push({ q: q.num, status: "wrong", text: settings.doubleMessage });
      continue;
    }
    const grp = graded.length ? g.groups[g.pinGroup[qp[0].id]] : undefined;
    if (!grp) out.push({ q: q.num, status: "ungraded", text: "Ungraded" });
    else out.push({ q: q.num, status: grp.status, text: resultText(grp.status, grp.text) });
  }
  return out;
}

function resultText(status: "correct" | "wrong", text: string) {
  if (status === "correct") return text ? `Correct (${text})` : "Correct";
  return text || "Incorrect";
}

export function feedbackText(results: QuestionResult[]): { text: string; score: number; total: number } {
  const score = results.filter((r) => r.status === "correct").length;
  const total = results.length;
  const lines = ["Overall Feedback", ...results.map((r) => `Q${r.q}: ${r.text}`), "", `Score: ${score}/${total}`];
  return { text: lines.join("\n"), score, total };
}

/** Autocomplete suggestions: this question's recent reasons first, then the rest of the exam. */
export function reasonSuggestions(g: GradeState, currentQ: number, status: "correct" | "wrong", query: string): string[] {
  const groups = Object.values(g.groups).filter((x) => x.status === status && x.text.trim());
  const score = new Map<string, { local: number; recent: number; count: number }>();
  for (const x of groups) {
    const local = Number(x.taskId.startsWith(`Q${currentQ}|`));
    const cur = score.get(x.text) ?? { local: 0, recent: 0, count: 0 };
    score.set(x.text, {
      local: Math.max(cur.local, local),
      recent: Math.max(cur.recent, x.createdAt),
      count: cur.count + x.pinIds.length,
    });
  }
  const qn = query.trim().toLowerCase();
  return [...score.entries()]
    .filter(([t]) => !qn || t.toLowerCase().includes(qn))
    .sort(
      (a, b) =>
        Number(b[0].toLowerCase().startsWith(qn)) - Number(a[0].toLowerCase().startsWith(qn)) ||
        b[1].local - a[1].local ||
        b[1].recent - a[1].recent,
    )
    .map(([t]) => t)
    .slice(0, 9);
}
