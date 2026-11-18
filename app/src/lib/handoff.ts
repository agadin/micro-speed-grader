/**
 * Hand-off packs: the host splits the remaining work, sends a pack file to a second grader,
 * and later merges the results file they send back. No server: files go by email/Drive/USB.
 *
 *   host  ── <name>.msgpack ──▶  guest grades only the handed-off tasks
 *   host  ◀── <name>.msgresult ──  guest
 */
import type { GradeState, Group, Pin, Session, SlideRef, Task } from "./types";
import { doublePinIds, pinsForTask } from "./grading";

/** One pack the host has sent out (kept in the host's session). */
export interface Handoff {
  id: string;
  guest: string;
  createdAt: number;
  taskIds: string[];
  /** ungraded pins in those tasks when the pack was made: locked on the host until returned/recalled */
  pinIds: string[];
  status: "out" | "returned" | "recalled";
  returnedAt?: number;
  /** pins graded by the guest that were merged in */
  mergedCount?: number;
}

/** Present in a guest's session: what they were given. */
export interface GuestPack {
  id: string;
  host: string;
  guest: string;
  taskIds: string[];
  pinIds: string[];
  createdAt: number;
}

export interface PackFile {
  kind: "msg-handoff";
  version: 1;
  id: string;
  createdAt: number;
  host: string;
  guest: string;
  taskIds: string[];
  pinIds: string[];
  session: Pick<Session, "name" | "questions" | "students" | "pins" | "grades"> & {
    /** slide ids and the host's file names: the guest relinks them to their own folder */
    slides: { id: string; file: string }[];
  };
}

export interface ResultFile {
  kind: "msg-handoff-result";
  version: 1;
  packId: string;
  guest: string;
  sentAt: number;
  groups: Group[];
  assign: Record<string, number>;
}

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

/** Pins the host can't grade right now because they are out with a guest. */
export function awayPins(s: Session): Set<string> {
  const out = new Set<string>();
  for (const h of s.handoffs ?? []) if (h.status === "out") h.pinIds.forEach((id) => out.add(id));
  return out;
}

/** Tasks currently out with someone, task id → guest name. */
export function awayTasks(s: Session): Map<string, string> {
  const m = new Map<string, string>();
  for (const h of s.handoffs ?? []) if (h.status === "out") h.taskIds.forEach((t) => m.set(t, h.guest));
  return m;
}

/** Ungraded pins per task (excluding pins already handed out and auto-wrong double pins). */
export function remainingByTask(s: Session, tasks: Task[]): { task: Task; pinIds: string[] }[] {
  const g = s.grades;
  const away = awayPins(s);
  const doubles = new Map<number, Set<string>>();
  return tasks.map((task) => {
    if (!doubles.has(task.q)) doubles.set(task.q, doublePinIds(s.pins, task.q, g));
    const dbl = doubles.get(task.q)!;
    const pinIds = pinsForTask(s.pins, task, g)
      .filter((p) => !g.pinGroup[p.id] && !dbl.has(p.id) && !away.has(p.id))
      .map((p) => p.id);
    return { task, pinIds };
  });
}

/**
 * Split items evenly (by pin count) across `k` people, keeping each item whole.
 * Largest first, each to whoever has the least so far. Returns item id → person index (0..k-1).
 */
export function splitEven(items: { id: string; n: number }[], k: number): Map<string, number> {
  const out = new Map<string, number>();
  if (k < 1) return out;
  const load = new Array(k).fill(0);
  for (const it of [...items].sort((a, b) => b.n - a.n || a.id.localeCompare(b.id))) {
    let best = 0;
    for (let i = 1; i < k; i++) if (load[i] < load[best]) best = i;
    out.set(it.id, best);
    load[best] += it.n;
  }
  return out;
}

/** Build the pack the guest opens. */
export function makePack(s: Session, guest: string, taskIds: string[], pinIds: string[]): PackFile {
  return {
    kind: "msg-handoff",
    version: 1,
    id: uid(),
    createdAt: Date.now(),
    host: s.name,
    guest,
    taskIds,
    pinIds,
    session: {
      name: s.name,
      questions: s.questions,
      students: s.students,
      pins: s.pins,
      grades: s.grades,
      slides: s.slides.map((r) => ({ id: r.id, file: r.path.split(/[\\/]/).pop() ?? r.path })),
    },
  };
}

export function parsePack(raw: string): PackFile {
  const p = JSON.parse(raw) as PackFile;
  if (p?.kind !== "msg-handoff" || p.version !== 1 || !Array.isArray(p.pinIds) || !p.session?.pins)
    throw new Error("This isn't a Micro Speed Grader hand-off pack.");
  return p;
}

/** The guest's working session, with slides relinked to their own folder. */
export function guestSession(p: PackFile, slides: SlideRef[], sessionPath: string, slidesDir: string): Session {
  const now = Date.now();
  return {
    version: 1,
    name: `${p.session.name} — ${p.guest}`,
    createdAt: now,
    savedAt: now,
    sessionPath,
    submissionsDir: "",
    slidesDir,
    questions: p.session.questions,
    students: p.session.students,
    pins: p.session.pins,
    slides: slides.filter((r) => p.session.slides.some((x) => x.id === r.id)),
    grades: p.session.grades,
    taskIndex: 0,
    guestPack: { id: p.id, host: p.host, guest: p.guest, taskIds: p.taskIds, pinIds: p.pinIds, createdAt: p.createdAt },
  };
}

/** What the guest sends back: only their grades on the pins they were given. */
export function makeResult(s: Session): ResultFile {
  const gp = s.guestPack;
  if (!gp) throw new Error("This session isn't a hand-off pack.");
  const mine = new Set(gp.pinIds);
  const groups: Group[] = [];
  for (const grp of Object.values(s.grades.groups)) {
    const pinIds = grp.pinIds.filter((id) => mine.has(id));
    if (pinIds.length) groups.push({ ...grp, pinIds });
  }
  const assign: Record<string, number> = {};
  for (const [id, q] of Object.entries(s.grades.assign)) if (mine.has(id)) assign[id] = q;
  return { kind: "msg-handoff-result", version: 1, packId: gp.id, guest: gp.guest, sentAt: Date.now(), groups, assign };
}

export function parseResult(raw: string): ResultFile {
  const r = JSON.parse(raw) as ResultFile;
  if (r?.kind !== "msg-handoff-result" || r.version !== 1 || !Array.isArray(r.groups))
    throw new Error("This isn't a Micro Speed Grader results file.");
  return r;
}

/** How many of the pack's pins the guest has graded (for the guest's "send back" button). */
export function guestProgress(s: Session): { done: number; total: number } {
  const gp = s.guestPack;
  if (!gp) return { done: 0, total: 0 };
  return { done: gp.pinIds.filter((id) => s.grades.pinGroup[id]).length, total: gp.pinIds.length };
}

/**
 * Merge a guest's results into the host's grades.
 * Only pins that were in the pack are taken; anything the host graded meanwhile (e.g. after a recall) wins.
 */
export function mergeResult(
  s: Session,
  r: ResultFile,
): { grades: GradeState; handoffs: Handoff[]; merged: number; skipped: number } {
  const hs = s.handoffs ?? [];
  const h = hs.find((x) => x.id === r.packId);
  if (!h) throw new Error("These results are for a pack that wasn't made from this session.");
  const allowed = new Set(h.pinIds);
  const g: GradeState = { groups: { ...s.grades.groups }, pinGroup: { ...s.grades.pinGroup }, assign: { ...s.grades.assign } };
  const pinById = new Map(s.pins.map((p) => [p.id, p] as [string, Pin]));
  let merged = 0;
  let skipped = 0;
  for (const grp of r.groups) {
    if (grp.status !== "correct" && grp.status !== "wrong") continue;
    const pinIds = grp.pinIds.filter((id) => {
      const ok = allowed.has(id) && pinById.has(id) && !g.pinGroup[id];
      if (!ok && allowed.has(id)) skipped++;
      return ok;
    });
    if (!pinIds.length) continue;
    const id = uid();
    g.groups[id] = {
      id,
      taskId: String(grp.taskId),
      status: grp.status,
      text: String(grp.text ?? "").slice(0, 2000),
      pinIds,
      createdAt: Number(grp.createdAt) || Date.now(),
    };
    for (const p of pinIds) {
      g.pinGroup[p] = id;
      const q = r.assign?.[p];
      if (pinById.get(p)!.q === null && typeof q === "number") g.assign[p] = q;
    }
    merged += pinIds.length;
  }
  const handoffs = hs.map((x) =>
    x.id === h.id ? { ...x, status: "returned" as const, returnedAt: Date.now(), mergedCount: (x.mergedCount ?? 0) + merged } : x,
  );
  return { grades: g, handoffs, merged, skipped };
}
