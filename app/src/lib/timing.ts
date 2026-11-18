/**
 * Time spent grading. Every grading action logs the time since the grader's previous action (or since
 * they opened the image), capped so breaks don't count, with the pins it graded. Shown only on export
 * (the Time tab): per question, per grader, per student, and, when pins were graded twice, how the
 * graders' time compares.
 */
import type { Session } from "./types";
import { parseTaskId } from "./grading";
import { graderLabel, HOST, KEY, sameVerdict } from "./handoff";

export interface TimeEvent {
  at: number;
  taskId: string;
  pinIds: string[];
  /** active seconds this action took (capped at IDLE_CAP) */
  secs: number;
  /** a hand-off grader's name; absent = the session's own grader */
  by?: string;
  /** the hand-off pack these came back in (so a re-sent results file replaces them) */
  pack?: string;
}

/** longer gaps than this count as a break: only this much of them is grading time */
export const IDLE_CAP = 120;

/** seconds since `since`, capped */
export const activeSecs = (since: number, now: number) => Math.max(0, Math.min(IDLE_CAP, (now - since) / 1000));

/** keep the log a sensible size (one entry per grading action) */
export const MAX_EVENTS = 50000;

export interface Row {
  key: string;
  label: string;
  secs: number;
  pins: number;
  students: number;
}
export interface PairTime {
  a: string;
  b: string;
  pins: number;
  /** seconds per pin each spent on the pins both graded */
  aPerPin: number;
  bPerPin: number;
  /** seconds per pin (both graders together) on pins they agreed on / disagreed on */
  agreedPerPin: number | null;
  disagreedPerPin: number | null;
  agreed: number;
  disagreed: number;
}
export interface TimeReport {
  totalSecs: number;
  pins: number;
  actions: number;
  /** pins the answer key graded (no time) */
  keyPins: number;
  byQuestion: Row[];
  byGrader: Row[];
  /** question × grader: seconds per pin */
  matrix: { q: number; graders: Record<string, number | null> }[];
  byStudent: Row[];
  pairs: PairTime[];
}

const who = (by?: string) => (by && by !== HOST ? by : HOST);

/** Seconds per pin for every (pin, grader): each action's time shared equally by the pins it graded. */
function pinTimes(log: TimeEvent[]) {
  const m = new Map<string, Map<string, number>>(); // pin → grader → secs
  for (const e of log) {
    if (!e.pinIds.length) continue;
    const share = e.secs / e.pinIds.length;
    for (const id of e.pinIds) {
      const g = m.get(id) ?? new Map<string, number>();
      g.set(who(e.by), (g.get(who(e.by)) ?? 0) + share);
      m.set(id, g);
    }
  }
  return m;
}

export function timeReport(s: Session): TimeReport {
  const log = s.timeLog ?? [];
  const pins = new Map(s.pins.map((p) => [p.id, p]));
  for (const r of s.retired ?? []) if (!pins.has(r.pin.id)) pins.set(r.pin.id, r.pin);
  const studentName = new Map(s.students.map((st) => [st.id, st.name]));
  const per = pinTimes(log);

  const rows = new Map<string, Map<string, { secs: number; pins: Set<string>; students: Set<string>; label: string }>>();
  const add = (table: string, key: string, label: string, secs: number, pinId: string) => {
    const t = rows.get(table) ?? new Map();
    const r = t.get(key) ?? { secs: 0, pins: new Set<string>(), students: new Set<string>(), label };
    r.secs += secs;
    r.pins.add(pinId);
    const st = pins.get(pinId)?.studentId;
    if (st) r.students.add(st);
    t.set(key, r);
    rows.set(table, t);
  };
  const matrix = new Map<number, Map<string, { secs: number; pins: Set<string> }>>();
  for (const e of log) {
    if (!e.pinIds.length) continue;
    const q = parseTaskId(e.taskId).q;
    const g = who(e.by);
    const share = e.secs / e.pinIds.length;
    for (const id of e.pinIds) {
      add("q", String(q), `Q${q}`, share, id);
      add("g", g, graderLabel(g), share, id);
      const st = pins.get(id)?.studentId ?? "?";
      add("s", st, studentName.get(st) ?? st, share, id);
      const mq = matrix.get(q) ?? new Map();
      const c = mq.get(g) ?? { secs: 0, pins: new Set<string>() };
      c.secs += share;
      c.pins.add(id);
      mq.set(g, c);
      matrix.set(q, mq);
    }
  }
  const out = (table: string, sort: (a: Row, b: Row) => number) =>
    [...(rows.get(table)?.entries() ?? [])]
      .map(([key, r]) => ({ key, label: r.label, secs: r.secs, pins: r.pins.size, students: r.students.size }))
      .sort(sort);
  const graders = out("g", (a, b) => b.secs - a.secs);

  // grade twice: time each grader spent on the pins both graded, and on agreements vs disagreements
  const pairs = new Map<string, { a: string; b: string; n: number; at: number; bt: number; ag: number[]; dis: number[] }>();
  for (const [id, c] of Object.entries(s.grades.checks ?? {})) {
    if (c.verdicts.length < 2) continue;
    const vs = [...c.verdicts].sort((x, y) => x.by.localeCompare(y.by));
    const t = per.get(id);
    for (let i = 0; i < vs.length; i++)
      for (let j = i + 1; j < vs.length; j++) {
        const ta = t?.get(who(vs[i].by)), tb = t?.get(who(vs[j].by));
        if (ta === undefined || tb === undefined) continue; // no time for one of them (e.g. an older app)
        const k = `${vs[i].by}\u0000${vs[j].by}`;
        const p = pairs.get(k) ?? { a: vs[i].by, b: vs[j].by, n: 0, at: 0, bt: 0, ag: [], dis: [] };
        p.n++;
        p.at += ta;
        p.bt += tb;
        (sameVerdict(vs[i], vs[j]) ? p.ag : p.dis).push((ta + tb) / 2);
        pairs.set(k, p);
      }
  }
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  const total = log.reduce((a, e) => a + e.secs, 0);
  const keyPins = Object.values(s.grades.groups)
    .filter((g) => g.by === KEY)
    .reduce((n, g) => n + g.pinIds.length, 0);
  return {
    totalSecs: total,
    pins: per.size,
    actions: log.length,
    keyPins,
    byQuestion: out("q", (a, b) => Number(a.key) - Number(b.key)),
    byGrader: graders,
    matrix: [...matrix.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([q, m]) => ({
        q,
        graders: Object.fromEntries(graders.map((g) => [g.key, m.get(g.key) ? m.get(g.key)!.secs / m.get(g.key)!.pins.size : null])),
      })),
    byStudent: out("s", (a, b) => b.secs - a.secs),
    pairs: [...pairs.values()].map((p) => ({
      a: graderLabel(p.a),
      b: graderLabel(p.b),
      pins: p.n,
      aPerPin: p.at / p.n,
      bPerPin: p.bt / p.n,
      agreedPerPin: avg(p.ag),
      disagreedPerPin: avg(p.dis),
      agreed: p.ag.length,
      disagreed: p.dis.length,
    })),
  };
}

/** 3725 → "1 h 2 min", 95 → "1 min 35 s", 7.4 → "7.4 s" */
export function fmtDuration(secs: number) {
  if (secs < 60) return `${secs < 10 ? secs.toFixed(1) : Math.round(secs)} s`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m} min ${Math.round(secs - m * 60)} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** time-stats.csv: the same tables, one after another */
export function timeCsv(r: TimeReport): string[][] {
  const n = (x: number | null) => (x === null ? "" : x.toFixed(1));
  const rows: string[][] = [
    ["Total active grading time (s)", n(r.totalSecs)],
    ["Pins graded by people", String(r.pins)],
    ["Pins graded by the answer key", String(r.keyPins)],
    ["Grading actions", String(r.actions)],
    [],
    ["Question", "Seconds", "Pins", "Students", "Seconds per pin", "Seconds per student"],
    ...r.byQuestion.map((x) => [x.label, n(x.secs), String(x.pins), String(x.students), n(x.secs / x.pins), n(x.students ? x.secs / x.students : null)]),
    [],
    ["Grader", "Seconds", "Pins", "Seconds per pin"],
    ...r.byGrader.map((x) => [x.label, n(x.secs), String(x.pins), n(x.secs / x.pins)]),
    [],
    ["Question", ...r.byGrader.map((g) => `${g.label}: seconds per pin`)],
    ...r.matrix.map((m) => [`Q${m.q}`, ...r.byGrader.map((g) => n(m.graders[g.key]))]),
    [],
    ["Student", "Seconds", "Pins"],
    ...r.byStudent.map((x) => [x.label, n(x.secs), String(x.pins)]),
  ];
  if (r.pairs.length)
    rows.push(
      [],
      ["Graders (pins graded twice)", "Pins both graded", "Seconds per pin (first)", "Seconds per pin (second)", "Agreed", "Seconds per pin when they agreed", "Disagreed", "Seconds per pin when they disagreed"],
      ...r.pairs.map((p) => [`${p.a} & ${p.b}`, String(p.pins), n(p.aPerPin), n(p.bPerPin), String(p.agreed), n(p.agreedPerPin), String(p.disagreed), n(p.disagreedPerPin)]),
    );
  return rows;
}
