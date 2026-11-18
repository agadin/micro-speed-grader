/**
 * Rescan submissions: merge a fresh read of the submissions folder into a session.
 *
 * Pins are matched by student folder, slide, title and position, so unchanged pins keep their id
 * (and their grade). New students and pins are added. Pins that are no longer in the files are
 * *retired*: moved out of `session.pins` (so they stop counting anywhere: clustering, grading,
 * the double-pin rule, progress, export, hand-off, the answer key) into `session.retired`, with the
 * grade they had. A retired pin whose student has a new pin for the same question is "changed"
 * (linked to its replacement); otherwise it's "removed".
 *
 * Changed submissions (the review): carry the old grade over to the new pin, grade it yourself,
 * restore a removed pin, or accept its removal.
 */
import type { GradeState, Group, Pin, RetiredPin, Session, Student } from "./types";
import { cloneGrades, detach, doublePinIds, effectiveQ, pinMap, taskId } from "./grading";
import { applyVerdicts, HOST, KEY } from "./handoff";

export interface RescanResult {
  students: Student[];
  pins: Pin[];
  grades: GradeState;
  retired: RetiredPin[];
  newStudents: number;
  /** ids of pins that weren't there before (new and changed) */
  added: string[];
  /** of `added`: pins that replace one of the student's earlier pins */
  replacements: string[];
  /** pins that left the files with nothing in their place */
  removed: number;
}

const pinKey = (folder: string, p: Pin) => `${folder}\u0000${p.slide}\u0000${p.rawTitle}\u0000${Math.round(p.xNm)}\u0000${Math.round(p.yNm)}`;

/** could new pin `np` be the student's answer to question `q` (which old pin `old` answered)? */
function answers(np: Pin, q: number | null, old: Pin) {
  if (q !== null) return np.q === q || (np.q === null && np.candidates.includes(q));
  // the old pin was never assigned a question: same slide, overlapping candidates
  return np.slide === old.slide && (np.q === null ? np.candidates.some((c) => old.candidates.includes(c)) : old.candidates.includes(np.q));
}

export function mergeRescan(s: Session, scan: { students: Student[]; pins: Pin[] }): RescanResult {
  // students: keep existing ids, add new folders
  const byFolder = new Map(s.students.map((st) => [st.folder, st]));
  const scanFolder = new Map(scan.students.map((st) => [st.id, st.folder]));
  let nextS = s.students.reduce((m, st) => Math.max(m, Number(st.id.slice(1)) || 0), 0);
  const students = [...s.students];
  let newStudents = 0;
  for (const st of scan.students)
    if (!byFolder.has(st.folder)) {
      const ns = { ...st, id: `s${++nextS}` };
      byFolder.set(st.folder, ns);
      students.push(ns);
      newStudents++;
    }
  students.sort((a, b) => a.name.localeCompare(b.name));

  // pins: match by student folder + slide + title + position
  const folderOf = new Map(s.students.map((st) => [st.id, st.folder]));
  const old = new Map<string, Pin[]>();
  for (const p of s.pins) {
    const k = pinKey(folderOf.get(p.studentId) ?? "", p);
    old.set(k, [...(old.get(k) ?? []), p]);
  }
  // ids are never reused, including retired pins' ids
  const allIds = [...s.pins, ...(s.retired ?? []).map((r) => r.pin)];
  let nextP = allIds.reduce((m, p) => Math.max(m, Number(p.id.slice(1)) || 0), 0);
  const pins: Pin[] = [];
  const added: Pin[] = [];
  for (const p of scan.pins) {
    const folder = scanFolder.get(p.studentId) ?? "";
    const same = old.get(pinKey(folder, p))?.shift();
    if (same) pins.push(same);
    else {
      const np = { ...p, id: `p${++nextP}`, studentId: byFolder.get(folder)!.id };
      pins.push(np);
      added.push(np);
    }
  }
  const kept = new Set(pins.map((p) => p.id));
  // a pin the grader restored stays, even though the files don't have it
  for (const p of s.pins) if (!kept.has(p.id) && p.restored) pins.push(p);
  const gone = s.pins.filter((p) => !kept.has(p.id) && !p.restored);

  // link each gone pin to the student's new pin for the same question (same slide first)
  const g0 = s.grades;
  const link = new Map<string, string>();
  const free = new Set(added.map((p) => p.id));
  for (const sameSlide of [true, false])
    for (const p of gone) {
      if (link.has(p.id)) continue;
      const q = effectiveQ(p, g0);
      const np = added.find((n) => free.has(n.id) && n.studentId === p.studentId && (!sameSlide || n.slide === p.slide) && answers(n, q, p));
      if (np) {
        link.set(p.id, np.id);
        free.delete(np.id);
      }
    }

  const now = Date.now();
  const goneIds = new Set(gone.map((p) => p.id));
  const personGraded = (id: string) => {
    const grp = g0.groups[g0.pinGroup[id]];
    return !!grp && grp.by !== KEY;
  };
  const fresh: RetiredPin[] = gone.map((p) => {
    const grp = g0.groups[g0.pinGroup[p.id]];
    const replacedBy = link.get(p.id);
    return {
      pin: p,
      q: effectiveQ(p, g0),
      ...(grp ? { grade: { taskId: grp.taskId, status: grp.status, text: grp.text, ...(grp.by ? { by: grp.by } : {}), createdAt: grp.createdAt } } : {}),
      retiredAt: now,
      ...(replacedBy ? { replacedBy } : {}),
      // a changed pin with no grade has nothing to carry over; a removed pin can always be restored
      review: !!grp || !replacedBy,
    };
  });
  // earlier changes whose new pin changed again: follow it to the newest pin, unless a person graded
  // the one in between (then that grade is what's reviewed)
  const freshById = new Map(fresh.map((r) => [r.pin.id, r]));
  const earlier = (s.retired ?? []).map((r) => {
    if (!r.review || !r.replacedBy || !goneIds.has(r.replacedBy)) return r;
    const mid = freshById.get(r.replacedBy)!;
    if (personGraded(r.replacedBy)) return { ...r, review: false };
    mid.review = false;
    const { replacedBy: _, ...rest } = r;
    return mid.replacedBy ? { ...rest, replacedBy: mid.replacedBy } : rest;
  });

  const grades = cloneGrades(g0);
  const goneList = [...goneIds];
  detach(grades, goneList);
  for (const id of goneList) {
    delete grades.assign[id];
    if (grades.checks) delete grades.checks[id];
  }
  const replacements = [...link.values()];
  return {
    students,
    pins,
    grades,
    retired: [...earlier, ...fresh],
    newStudents,
    added: added.map((p) => p.id),
    replacements,
    removed: gone.length - link.size,
  };
}

/** "Rescan: 2 new students, 9 new pins (7 graded by the answer key), 3 changed, 1 removed." (`grades`: after the key) */
export function rescanMessage(r: RescanResult, grades: GradeState): string {
  const keyed = (ids: string[]) => ids.filter((id) => grades.groups[grades.pinGroup[id]]?.by === KEY).length;
  const repl = new Set(r.replacements);
  const fresh = r.added.filter((id) => !repl.has(id));
  const byKey = (n: number) => (n ? ` (${n} graded by the answer key)` : "");
  const parts = [
    r.newStudents ? `${r.newStudents} new student${r.newStudents === 1 ? "" : "s"}` : "",
    fresh.length ? `${fresh.length} new pin${fresh.length === 1 ? "" : "s"}${byKey(keyed(fresh))}` : "",
    repl.size ? `${repl.size} changed${byKey(keyed(r.replacements))}` : "",
    r.removed ? `${r.removed} removed` : "",
  ].filter(Boolean);
  return parts.length ? `Rescan: ${parts.join(", ")}.` : "Rescan: no new or changed submissions.";
}

// ---------------------------------------------------------------- Changed submissions (the review)

export interface ReviewRow {
  /** the retired pin's id */
  id: string;
  kind: "changed" | "removed";
  q: number | null;
  studentId: string;
  old: RetiredPin;
  /** changed: the student's new pin, and its grade if the answer key gave one */
  newPin?: Pin;
  newGrade?: Group;
  /** the student now has more than one pin for the question (the double-pin rule decides) */
  double: boolean;
}

/** What's waiting in Changed submissions, in question order. */
export function reviewRows(s: Session): ReviewRow[] {
  const pins = pinMap(s.pins);
  const g = s.grades;
  const doubles = new Map<number, Set<string>>();
  const isDouble = (p: Pin, q: number | null) => {
    if (q === null) return false;
    if (!doubles.has(q)) doubles.set(q, doublePinIds(s.pins, q, g));
    return doubles.get(q)!.has(p.id);
  };
  const rows: ReviewRow[] = [];
  for (const r of s.retired ?? []) {
    if (!r.review) continue;
    const np = r.replacedBy ? pins.get(r.replacedBy) : undefined;
    if (np) {
      const grp = g.groups[g.pinGroup[np.id]];
      if (grp && grp.by !== KEY) continue; // a person graded the new pin: done
      if (!r.grade) continue;
      rows.push({ id: r.pin.id, kind: "changed", q: r.q, studentId: r.pin.studentId, old: r, newPin: np, newGrade: grp, double: isDouble(np, r.q) });
    } else rows.push({ id: r.pin.id, kind: "removed", q: r.q, studentId: r.pin.studentId, old: r, double: false });
  }
  return rows.sort((a, b) => (a.q ?? 1e9) - (b.q ?? 1e9));
}

/** the new pins waiting for review (drawn with a badge on the slide) */
export const reviewPinIds = (rows: ReviewRow[]) => new Set(rows.flatMap((r) => (r.newPin ? [r.newPin.id] : [])));

/** can this row's old grade be given to the new pin? (never over a person's grade, never on a double pin) */
export const canCarry = (r: ReviewRow) => r.kind === "changed" && !!r.old.grade && r.q !== null && !r.double && (!r.newGrade || r.newGrade.by === KEY);

export interface ReviewChange {
  grades: GradeState;
  pins: Pin[];
  retired: RetiredPin[];
}

const mark = (s: Session, ids: Set<string>, patch: (r: RetiredPin) => RetiredPin | null) =>
  (s.retired ?? []).flatMap((r) => (ids.has(r.pin.id) ? (patch(r) ?? []) : [r]));

/** Give these rows' new pins the old grade (who gave it stays with it). */
export function carryOver(s: Session, rows: ReviewRow[]): ReviewChange {
  const ok = rows.filter(canCarry);
  const grades = cloneGrades(s.grades);
  applyVerdicts(
    grades,
    ok.map((r) => {
      const gr = r.old.grade!;
      const np = r.newPin!;
      return { pinId: np.id, taskId: taskId(r.q!, np.slide), v: { by: gr.by ?? HOST, status: gr.status, text: gr.text }, assignQ: r.q!, pin: np };
    }),
  );
  return { grades, pins: s.pins, retired: mark(s, new Set(ok.map((r) => r.id)), (r) => ({ ...r, review: false })) };
}

/** Removed pins count again, with the grades they had. */
export function restorePins(s: Session, rows: ReviewRow[]): ReviewChange {
  const ok = rows.filter((r) => r.kind === "removed");
  const back = ok.map((r) => ({ ...r.old.pin, restored: true }));
  const grades = cloneGrades(s.grades);
  applyVerdicts(
    grades,
    ok.flatMap((r, i) => {
      const gr = r.old.grade;
      return gr ? [{ pinId: back[i].id, taskId: gr.taskId, v: { by: gr.by ?? HOST, status: gr.status, text: gr.text }, assignQ: r.q ?? undefined, pin: back[i] }] : [];
    }),
  );
  for (let i = 0; i < ok.length; i++) if (back[i].q === null && ok[i].q !== null) grades.assign[back[i].id] = ok[i].q!;
  return { grades, pins: [...s.pins, ...back], retired: mark(s, new Set(ok.map((r) => r.id)), () => null) };
}

/** Done with these rows without changing any grade (accept a removal, keep the key's grade). */
export function dismissRows(s: Session, rows: ReviewRow[]): ReviewChange {
  return { grades: s.grades, pins: s.pins, retired: mark(s, new Set(rows.map((r) => r.id)), (r) => ({ ...r, review: false })) };
}
