/**
 * Review helpers: one student's answers across the exam (for regrade requests and appeals),
 * and searching / filtering the ledger.
 */
import type { Group, Pin, Session, Student, Task } from "./types";
import { doublePinIds, effectiveQ, feedbackText, studentResults, taskId, type QuestionResult } from "./grading";
import { awayPins, conflictPins, graderLabel, HOST } from "./handoff";
import { parseStudentName } from "./exportCsv";
import type { Settings } from "./settings";

// ---------------- one student ----------------

/** what a student's answer to one question is, in a word */
export type AnswerKind = "correct" | "wrong" | "double" | "none" | "ungraded" | "unlabelled" | "away" | "conflict";

export interface StudentPin {
  pin: Pin;
  /** the image this pin is graded on */
  taskId: string;
  status: "correct" | "wrong" | null;
  groupId?: string;
  /** who graded it ("You", a hand-off grader…), when graded */
  by?: string;
  /** out with this grader right now: can't be regraded here */
  away?: string;
  conflict: boolean;
  /** no question in its title: grading it here assigns it to this question */
  unlabelled: boolean;
}

export interface StudentAnswer {
  q: number;
  kind: AnswerKind;
  /** the answer in plain words: "Correct", "Wrong", "No answer", "Not graded yet"… */
  label: string;
  /** the grader's reason or note (or the rule's message) */
  reason: string;
  /** who decided it: "You", "Jamie", "AUTO" (the double-pin rule); absent when nobody has */
  by?: string;
  /** the line the student reads in their feedback */
  result: QuestionResult;
  pins: StudentPin[];
}

export interface StudentSummary {
  student: Student;
  /** "Okafor, Hana" */
  name: string;
  uid: string;
  answers: StudentAnswer[];
  score: number;
  total: number;
  feedback: string;
}

/** pin id → the grader it is out with (host side: packs not back yet) */
export function awayWho(s: Session): Map<string, string> {
  const away = awayPins(s);
  const m = new Map<string, string>();
  for (const h of s.handoffs ?? []) if (h.status === "out") for (const id of h.pinIds) if (away.has(id)) m.set(id, h.guest);
  return m;
}

/** pins grouped by student, for summarising many students quickly */
export const pinsByStudent = (pins: Pin[]) => {
  const m = new Map<string, Pin[]>();
  for (const p of pins) {
    const list = m.get(p.studentId);
    if (list) list.push(p);
    else m.set(p.studentId, [p]);
  }
  return m;
};

/**
 * Everything about one student: every included question in order, what they answered,
 * how it was graded and by whom, their pins, score and feedback text.
 * `mine` (optional) is that student's pins, when already at hand.
 */
export function studentSummary(
  session: Session,
  student: Student,
  settings: Settings,
  opts: { mine?: Pin[]; away?: Map<string, string> } = {},
): StudentSummary {
  const g = session.grades;
  const mine = opts.mine ?? session.pins.filter((p) => p.studentId === student.id);
  const away = opts.away ?? awayWho(session);
  const conflicts = new Set(conflictPins(g));
  const results = studentResults({ ...session, pins: mine }, student, settings);
  const answers: StudentAnswer[] = results.map((result) => {
    const q = result.q;
    const qPins = mine.filter((p) => {
      const eq = effectiveQ(p, g);
      return eq === null ? p.candidates.includes(q) : eq === q;
    });
    const pins: StudentPin[] = qPins.map((pin) => {
      const grp = g.groups[g.pinGroup[pin.id]];
      return {
        pin,
        taskId: grp?.taskId ?? taskId(q, pin.slide),
        status: grp?.status ?? null,
        groupId: grp?.id,
        by: grp ? graderLabel(grp.by) : undefined,
        away: away.get(pin.id),
        conflict: conflicts.has(pin.id),
        unlabelled: effectiveQ(pin, g) === null,
      };
    });
    const labelled = pins.filter((p) => !p.unlabelled);
    // the grade that counts: the newest grader's grade among this question's pins
    const latest = labelled
      .map((p) => (p.groupId ? g.groups[p.groupId] : undefined))
      .filter((x): x is Group => !!x)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    const base = { q, result, pins };
    if (latest)
      return {
        ...base,
        kind: latest.status,
        label: latest.status === "correct" ? "Correct" : "Wrong",
        reason: latest.text,
        by: graderLabel(latest.by),
      };
    if (labelled.length > 1)
      return { ...base, kind: "double", label: `Marked wrong: ${labelled.length} pins`, reason: settings.doubleMessage, by: "AUTO" };
    if (!pins.length) return { ...base, kind: "none", label: "No answer", reason: settings.noAnswerMessage };
    const out = pins.find((p) => p.away)?.away;
    if (out) return { ...base, kind: "away", label: `With ${out}`, reason: "" };
    if (pins.some((p) => p.conflict)) return { ...base, kind: "conflict", label: "Graders disagree", reason: "" };
    if (!labelled.length) return { ...base, kind: "unlabelled", label: "Unlabelled pin, not graded", reason: "" };
    return { ...base, kind: "ungraded", label: "Not graded yet", reason: "" };
  });
  const fb = feedbackText(results, settings);
  return { student, ...studentLabel(student), answers, score: fb.score, total: fb.total, feedback: fb.text };
}

/** how a student is listed: "Okafor, Hana" and their UID (from the folder name), else the name as it is */
export function studentLabel(s: Student): { name: string; uid: string } {
  const p = parseStudentName(s.folder || s.name);
  return { name: p.surname && p.first ? `${p.surname}, ${p.first}` : p.surname || s.name, uid: p.uid };
}

/** students whose name, folder or UID contains every word typed (case-insensitive), sorted by surname */
export function findStudents(students: Student[], query: string): Student[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return students
    .map((s) => ({ s, label: studentLabel(s) }))
    .filter(({ s, label }) => {
      const hay = `${label.name} ${s.name} ${s.folder}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .sort((a, b) => a.label.name.localeCompare(b.label.name) || a.label.uid.localeCompare(b.label.uid))
    .map((x) => x.s);
}

// ---------------- ledger search and filters ----------------

export interface LedgerFilter {
  query: string;
  status: "all" | "wrong" | "correct";
  /** "" = everyone, HOST = you, AUTO = the double-pin rule rows, else a group's `by` */
  grader: string;
}
export const AUTO = "@auto";
export const noFilter: LedgerFilter = { query: "", status: "all", grader: "" };
export const isFiltered = (f: LedgerFilter) => !!f.query.trim() || f.status !== "all" || !!f.grader;

/** who gave a group (HOST for you) */
export const graderOf = (g: Group) => g.by ?? HOST;

/** the graders present in these groups, you first, then by name; plus AUTO when there are rule rows */
export function graderOptions(groups: Group[], hasAuto: boolean): { key: string; label: string }[] {
  const keys = new Set(groups.map(graderOf));
  const others = [...keys].filter((k) => k !== HOST).sort((a, b) => a.localeCompare(b));
  return [
    ...(keys.has(HOST) ? [{ key: HOST, label: graderLabel(HOST) }] : []),
    ...others.map((k) => ({ key: k, label: graderLabel(k) })),
    ...(hasAuto ? [{ key: AUTO, label: "AUTO (double pins)" }] : []),
  ];
}

/** every word of the query appears somewhere in these texts (case-insensitive) */
export const textMatches = (query: string, texts: string[]) => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = texts.join("\n").toLowerCase();
  return words.every((w) => hay.includes(w));
};

/** does a ledger row pass the filter? `names` are the students in it; `text` its reason. */
export function rowPasses(
  f: LedgerFilter,
  row: { status: "correct" | "wrong"; grader: string; text: string; names: string[] },
): boolean {
  if (f.status !== "all" && row.status !== f.status) return false;
  if (f.grader && row.grader !== f.grader) return false;
  return !f.query.trim() || textMatches(f.query, [row.text, ...row.names]);
}

export function filterGroups(groups: Group[], f: LedgerFilter, nameOfPin: (pinId: string) => string): Group[] {
  if (!isFiltered(f)) return groups;
  return groups.filter((g) =>
    rowPasses(f, {
      status: g.status,
      grader: graderOf(g),
      text: `${g.status === "correct" ? "Correct" : ""} ${g.text}`,
      names: f.query.trim() ? g.pinIds.map(nameOfPin) : [],
    }),
  );
}

/** the AUTO rows: per image, ungraded pins of students with more than one pin for that question */
export function autoRows(session: Session, tasks: Task[]): { task: Task; pins: Pin[] }[] {
  const g = session.grades;
  const byQ = new Map<number, Set<string>>();
  const out: { task: Task; pins: Pin[] }[] = [];
  for (const task of tasks) {
    if (!byQ.has(task.q)) byQ.set(task.q, doublePinIds(session.pins, task.q, g));
    const d = byQ.get(task.q)!;
    const pins = session.pins.filter((p) => d.has(p.id) && p.slide === task.slide && !g.pinGroup[p.id]);
    if (pins.length) out.push({ task, pins });
  }
  return out;
}
