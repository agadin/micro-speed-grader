import { autoWrongDoubles, type GradeState, type Pin, type Question, type Session, type Student, type Task } from "./types";
import { defaultSettings, type Settings } from "./settings";

export const taskId = (q: number, slide: string) => `Q${q}|${slide}`;
/** "Q3|VMS109" → { q: 3, slide: "VMS109" } */
export const parseTaskId = (id: string) => {
  const [q, slide = ""] = id.split("|");
  return { q: Number(q.replace(/^Q/, "")), slide };
};
/** how an image is named in the UI: "Q1 · VMS109", "Q4 · VMS133 (2/2)" */
export const taskLabel = (t: Task) => `Q${t.q} · ${t.slide}${t.slideCount > 1 ? ` (${t.slideIndex + 1}/${t.slideCount})` : ""}`;
/** the same, from just an id (when the task isn't at hand) */
export const taskIdLabel = (id: string, tasks?: Task[]) => {
  const t = tasks?.find((x) => x.id === id);
  return t ? taskLabel(t) : id.replace("|", " · ");
};

/** pin id → pin */
export const pinMap = (pins: Pin[]) => new Map(pins.map((p) => [p.id, p] as [string, Pin]));

/** a copy of the grades that can be changed without touching the original (one level deep) */
export const cloneGrades = (g: GradeState): GradeState => ({
  groups: { ...g.groups },
  pinGroup: { ...g.pinGroup },
  assign: { ...g.assign },
  ...(g.checks ? { checks: { ...g.checks } } : {}),
  ...(g.later ? { later: [...g.later] } : {}),
});

/** Remove pins from whatever group they're in, deleting groups left empty. Changes `g`. */
export function detach(g: GradeState, pinIds: string[]) {
  const set = new Set(pinIds);
  const touched = new Set<string>();
  for (const id of pinIds) {
    const gid = g.pinGroup[id];
    if (gid) touched.add(gid);
    delete g.pinGroup[id];
  }
  for (const gid of touched) {
    const grp = g.groups[gid];
    if (!grp) continue;
    const rest = grp.pinIds.filter((p) => !set.has(p));
    if (rest.length) g.groups[gid] = { ...grp, pinIds: rest };
    else delete g.groups[gid];
  }
}

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
  /** what the student handed in: no pin, several pins, or one answer (statistics only) */
  kind?: "none" | "double" | "answer";
  /** the grader's own note, before the feedback wording is applied (statistics only) */
  note?: string;
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
          ? { q: q.num, status: "ungraded", text: `${settings.fbUngraded} (unlabelled pin)` }
          : { q: q.num, status: "wrong", text: settings.noAnswerMessage, kind: "none" },
      );
      continue;
    }
    if (qp.length > 1) {
      // a grader override on any of the pins wins (most recent), else auto-wrong
      const latest = graded
        .map((p) => g.groups[g.pinGroup[p.id]])
        .filter(Boolean)
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      if (latest)
        out.push({ q: q.num, status: latest.status, text: resultText(latest.status, latest.text, settings), kind: "double", note: latest.text.trim() });
      else if (autoWrongDoubles(session)) out.push({ q: q.num, status: "wrong", text: settings.doubleMessage, kind: "double" });
      // Preferences ▸ Reading submissions: several pins are left for the grader
      else out.push({ q: q.num, status: "ungraded", text: settings.fbUngraded, kind: "double" });
      continue;
    }
    const grp = graded.length ? g.groups[g.pinGroup[qp[0].id]] : undefined;
    if (!grp) out.push({ q: q.num, status: "ungraded", text: settings.fbUngraded, kind: "answer" });
    else out.push({ q: q.num, status: grp.status, text: resultText(grp.status, grp.text, settings), kind: "answer", note: grp.text.trim() });
  }
  return out;
}

type Wording = Pick<
  Settings,
  | "fbHeader"
  | "fbLine"
  | "fbCorrect"
  | "fbCorrectNote"
  | "fbWrongNote"
  | "fbScore"
  | "fbScoreOn"
  | "fbShow"
  | "fbAllCorrect"
  | "wrongDefaultText"
>;

/** fill {name} placeholders; unknown names are left as typed */
export const fillTemplate = (t: string, vars: Record<string, string | number>) =>
  t.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

/** the text one graded question reads as: grader's note run through the correct / wrong wording */
export function resultText(status: "correct" | "wrong", note: string, w: Wording) {
  note = note.trim();
  if (status === "correct") return note ? fillTemplate(w.fbCorrectNote, { note }) : w.fbCorrect;
  return note ? fillTemplate(w.fbWrongNote, { note }) : w.wrongDefaultText || "Incorrect";
}

export function feedbackText(results: QuestionResult[], w: Wording = defaultSettings): { text: string; score: number; total: number } {
  const score = results.filter((r) => r.status === "correct").length;
  const total = results.length;
  const percent = total ? Math.round((score / total) * 100) : 0;
  const shown = w.fbShow === "notCorrect" ? results.filter((r) => r.status !== "correct") : results;
  const lines: string[] = [];
  if (w.fbHeader.trim()) lines.push(fillTemplate(w.fbHeader, { score, total, percent }));
  lines.push(...shown.map((r) => fillTemplate(w.fbLine, { q: r.q, text: r.text })));
  if (!shown.length && w.fbAllCorrect.trim()) lines.push(w.fbAllCorrect);
  if (w.fbScoreOn && w.fbScore.trim()) lines.push("", fillTemplate(w.fbScore, { score, total, percent }));
  return { text: lines.join("\n").replace(/^\n+/, ""), score, total };
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
