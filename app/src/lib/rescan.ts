/**
 * Rescan submissions: merge a fresh read of the submissions folder into a session.
 * Pins are matched by student folder, slide, title and position, so unchanged pins keep their id
 * (and their grade). New students and pins are added; pins that are gone lose their grade.
 */
import type { GradeState, Pin, Session, Student } from "./types";
import { cloneGrades, detach } from "./grading";

export interface RescanResult {
  students: Student[];
  pins: Pin[];
  grades: GradeState;
  newStudents: number;
  /** ids of pins that weren't there before */
  added: string[];
  removed: number;
}

const pinKey = (folder: string, p: Pin) => `${folder}\u0000${p.slide}\u0000${p.rawTitle}\u0000${Math.round(p.xNm)}\u0000${Math.round(p.yNm)}`;

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
  let nextP = s.pins.reduce((m, p) => Math.max(m, Number(p.id.slice(1)) || 0), 0);
  const pins: Pin[] = [];
  const added: string[] = [];
  for (const p of scan.pins) {
    const folder = scanFolder.get(p.studentId) ?? "";
    const k = pinKey(folder, p);
    const same = old.get(k)?.shift();
    if (same) pins.push(same);
    else {
      const np = { ...p, id: `p${++nextP}`, studentId: byFolder.get(folder)!.id };
      pins.push(np);
      added.push(np.id);
    }
  }
  const kept = new Set(pins.map((p) => p.id));
  const gone = s.pins.filter((p) => !kept.has(p.id)).map((p) => p.id);
  const grades = cloneGrades(s.grades);
  detach(grades, gone);
  for (const id of gone) {
    delete grades.assign[id];
    if (grades.checks) delete grades.checks[id];
  }
  return { students, pins, grades, newStudents, added, removed: gone.length };
}
