import type { QuestionResult } from "./grading";
import type { Student } from "./types";

// ---------- student names ----------

/**
 * Split a submission folder name into id / surname / first name.
 * Handles "1028899 - Okafor, Hana", "Okafor, Hana (1028899)", "Hana Okafor", "okafor_hana_1028899".
 */
export function parseStudentName(folder: string): { uid: string; surname: string; first: string } {
  let s = folder.replace(/_/g, " ").replace(/\s+/g, " ").trim();
  let uid = "";
  const lead = s.match(/^(\d+)\s*[-–—:]\s*(.*)$/) ?? s.match(/^(\d{3,})\s+(.*)$/);
  const paren = s.match(/^(.*?)\s*[([](\d{3,})[)\]]\s*$/);
  const trail = s.match(/^(.*?)\s*[-–—]?\s*(\d{3,})$/);
  if (lead) [uid, s] = [lead[1], lead[2]];
  else if (paren) [uid, s] = [paren[2], paren[1]];
  else if (trail) [uid, s] = [trail[2], trail[1]];
  s = s.trim();
  if (s.includes(",")) {
    const [sur, ...rest] = s.split(",");
    return { uid, surname: sur.trim(), first: rest.join(",").trim() };
  }
  const parts = s.split(" ");
  if (parts.length === 1) return { uid, surname: parts[0], first: "" };
  return { uid, surname: parts[parts.length - 1], first: parts.slice(0, -1).join(" ") };
}

// ---------- columns ----------

export type ColumnId =
  | "uid"
  | "surname"
  | "first"
  | "student"
  | "correct"
  | "total"
  | "grade"
  | "percent"
  | "comment"
  | "items";

export interface ExportColumn {
  id: ColumnId;
  /** header text written to the CSV (for "items" a prefix: "Q" → Q1, Q2 …) */
  header: string;
  on: boolean;
}

export const COLUMN_INFO: Record<ColumnId, { label: string; hint: string; header: string }> = {
  uid: { label: "UID", hint: "student ID", header: "UID" },
  surname: { label: "Surname", hint: "last name", header: "Surname" },
  first: { label: "First name", hint: "", header: "First_name" },
  student: { label: "Student", hint: "full name as in the folder", header: "Student" },
  correct: { label: "Correct answers", hint: "number correct", header: "Number_of_correct_answers" },
  total: { label: "Questions asked", hint: "number of questions", header: "Total_questions_asked" },
  grade: { label: "Grade", hint: "e.g. 4/5", header: "Grade" },
  percent: { label: "Percent", hint: "0–100", header: "Percent" },
  comment: { label: "Comment", hint: "the feedback text", header: "Comment" },
  items: { label: "Item scores", hint: "one column per question: 1 correct, 0 incorrect", header: "Q" },
};

const col = (id: ColumnId, on = true): ExportColumn => ({ id, header: COLUMN_INFO[id].header, on });

export const EXPORT_PRESETS: { id: string; label: string; columns: ExportColumn[] }[] = [
  {
    id: "items",
    label: "Item analysis",
    columns: [
      col("uid"),
      col("surname"),
      col("first"),
      col("correct"),
      col("total"),
      col("comment"),
      col("items"),
      col("student", false),
      col("grade", false),
      col("percent", false),
    ],
  },
  {
    id: "simple",
    label: "Simple (Student, Grade, Comment)",
    columns: [
      col("student"),
      col("grade"),
      col("comment"),
      col("uid", false),
      col("surname", false),
      col("first", false),
      col("correct", false),
      col("total", false),
      col("percent", false),
      col("items", false),
    ],
  },
];

export interface ExportOptions {
  columns: ExportColumn[];
  /** where UID comes from: the number in the folder name, or left blank (placeholder) */
  uidFrom: "folder" | "blank";
  /** how an ungraded answer shows in the item columns */
  ungradedItem: "blank" | "0";
}

export interface ExportRow {
  stu: Student;
  res: QuestionResult[];
  text: string;
  score: number;
  total: number;
}

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** header + one array of cells per student */
export function exportTable(rows: ExportRow[], qs: number[], o: ExportOptions): string[][] {
  const head: string[] = [];
  for (const c of o.columns)
    if (c.on) {
      if (c.id === "items") head.push(...qs.map((q) => `${c.header}${q}`));
      else head.push(c.header);
    }
  const body = rows.map((r) => {
    const n = parseStudentName(r.stu.folder || r.stu.name);
    const out: string[] = [];
    for (const c of o.columns) {
      if (!c.on) continue;
      switch (c.id) {
        case "uid":
          out.push(o.uidFrom === "folder" ? n.uid : "");
          break;
        case "surname":
          out.push(n.surname);
          break;
        case "first":
          out.push(n.first);
          break;
        case "student":
          out.push(r.stu.name);
          break;
        case "correct":
          out.push(String(r.score));
          break;
        case "total":
          out.push(String(r.total));
          break;
        case "grade":
          out.push(`${r.score}/${r.total}`);
          break;
        case "percent":
          out.push(r.total ? String(Math.round((r.score / r.total) * 1000) / 10) : "");
          break;
        case "comment":
          out.push(r.text);
          break;
        case "items":
          for (const q of qs) {
            const x = r.res.find((y) => y.q === q);
            out.push(!x || x.status === "ungraded" ? (o.ungradedItem === "0" ? "0" : "") : x.status === "correct" ? "1" : "0");
          }
          break;
      }
    }
    return out;
  });
  return [head, ...body];
}

export const toCsv = (table: (string | number)[][]) => "﻿" + table.map((r) => r.map(csvCell).join(",")).join("\r\n");

// ---------- item statistics / KR-20 ----------

export interface ItemStat {
  q: number;
  /** difficulty: proportion correct */
  p: number;
  /** corrected item–total (point-biserial) correlation: item vs total without the item */
  rpb: number | null;
  /** KR-20 of the test with this item left out */
  kr20IfDeleted: number | null;
  correct: number;
  incorrect: number;
}

export interface TestStats {
  /** students with every answer graded (the rest are left out) */
  n: number;
  excluded: number;
  k: number;
  mean: number;
  sd: number;
  kr20: number | null;
  items: ItemStat[];
}

/** KR-20 for a 0/1 matrix (rows = students, cols = items); population variance of totals */
export function kr20(m: number[][]): number | null {
  const n = m.length;
  const k = m[0]?.length ?? 0;
  if (n < 2 || k < 2) return null;
  const totals = m.map((r) => r.reduce((a, b) => a + b, 0));
  const mean = totals.reduce((a, b) => a + b, 0) / n;
  const varT = totals.reduce((a, t) => a + (t - mean) ** 2, 0) / n;
  if (varT === 0) return null;
  let pq = 0;
  for (let j = 0; j < k; j++) {
    const p = m.reduce((a, r) => a + r[j], 0) / n;
    pq += p * (1 - p);
  }
  return (k / (k - 1)) * (1 - pq / varT);
}

function pearson(x: number[], y: number[]): number | null {
  const n = x.length;
  if (n < 2) return null;
  const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

/** ungradedAsWrong: keep students with ungraded answers, scoring those answers 0 (else leave them out) */
export function testStats(rows: ExportRow[], qs: number[], ungradedAsWrong = false): TestStats {
  const complete = ungradedAsWrong
    ? rows
    : rows.filter((r) => qs.every((q) => r.res.find((x) => x.q === q)?.status !== "ungraded"));
  const m: number[][] = complete.map((r) => qs.map((q) => (r.res.find((x) => x.q === q)?.status === "correct" ? 1 : 0)));
  const n = m.length;
  const totals = m.map((r) => r.reduce((a, b) => a + b, 0));
  const mean = n ? totals.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n ? Math.sqrt(totals.reduce((a, t) => a + (t - mean) ** 2, 0) / n) : 0;
  const items = qs.map((q, j) => {
    const col = m.map((r) => r[j]);
    const correct = col.reduce((a, b) => a + b, 0);
    const rest = m.map((r, i) => totals[i] - r[j]);
    return {
      q,
      p: n ? correct / n : 0,
      rpb: pearson(col, rest),
      kr20IfDeleted: qs.length > 2 ? kr20(m.map((r) => r.filter((_, jj) => jj !== j))) : null,
      correct,
      incorrect: n - correct,
    };
  });
  return { n, excluded: rows.length - n, k: qs.length, mean, sd, kr20: kr20(m), items };
}

const f = (x: number | null, d = 3) => (x === null || !Number.isFinite(x) ? "" : x.toFixed(d).replace(/^-(0\.0*)$/, "$1"));

/** item-stats.csv: a summary block, then one row per question */
export function statsTable(s: TestStats): string[][] {
  return [
    ["Statistic", "Value"],
    ["Students", String(s.n)],
    ["Students left out (ungraded answers)", String(s.excluded)],
    ["Questions (k)", String(s.k)],
    ["Mean score", f(s.mean, 2)],
    ["SD (population)", f(s.sd, 2)],
    ["KR-20", f(s.kr20)],
    [],
    ["Question", "Difficulty (p)", "Point-biserial (corrected)", "KR-20 if deleted", "Correct", "Incorrect"],
    ...s.items.map((it) => [`Q${it.q}`, f(it.p), f(it.rpb), f(it.kr20IfDeleted), String(it.correct), String(it.incorrect)]),
  ];
}
