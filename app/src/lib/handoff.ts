/**
 * Hand-off packs: the host splits the remaining work, sends a pack file to each other grader,
 * and later merges the results file they send back. No server: files go by email/Drive/USB.
 *
 *   host  ── <name>.msgpack ──▶  guest grades only the handed-off pins
 *   host  ◀── <name>.msgresult ──  guest
 *
 * Optionally some pins are graded twice ("checks"): by two guests, or by the host and a guest.
 * Neither sees the other's grade. When both verdicts are in they're compared; agreements become
 * the grade, disagreements are left ungraded and flagged for the host to resolve.
 */
import type { GradeState, Group, Pin, Session, SlideRef, Task } from "./types";
import { cloneGrades, detach, doublePinIds, pinMap, pinsForTask } from "./grading";
import { uid } from "./util";

/** the host's name inside checks and verdicts (shown as "You") */
export const HOST = "@host";
export const graderLabel = (by: string | undefined) => (!by || by === HOST ? "You" : by);

/** One pack the host has sent out (kept in the host's session). */
export interface Handoff {
  id: string;
  guest: string;
  createdAt: number;
  taskIds: string[];
  /** pins in the pack: locked on the host until returned/recalled (except checks the host also grades) */
  pinIds: string[];
  /** the pack's pins that someone else grades too */
  checkPins?: string[];
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

/** one grader's grade for a pin that is graded twice */
export interface Verdict {
  by: string;
  status: "correct" | "wrong";
  text: string;
  at: number;
}

/** a pin graded twice */
export interface Check {
  taskId: string;
  /** who must grade it (HOST for the host) */
  graders: string[];
  verdicts: Verdict[];
  /** waiting for verdicts · they agreed (the grade is set) · they disagree (pin left ungraded, flagged) · host decided */
  state: "waiting" | "agreed" | "conflict" | "resolved";
  /** for unlabelled pins: the question the graders assigned it to */
  assignQ?: number;
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

/** Pins the host can't grade right now because they are out with a guest (and the host isn't one of their graders). */
export function awayPins(s: Session): Set<string> {
  const out = new Set<string>();
  const checks = s.grades.checks ?? {};
  for (const h of s.handoffs ?? [])
    if (h.status === "out")
      for (const id of h.pinIds) {
        const c = checks[id];
        if (c && c.graders.includes(HOST) && c.state === "waiting") continue;
        out.add(id);
      }
  return out;
}

/** Tasks currently out with someone, task id → guest name(s). */
export function awayTasks(s: Session): Map<string, string> {
  const m = new Map<string, string>();
  const away = awayPins(s);
  for (const h of s.handoffs ?? [])
    if (h.status === "out")
      for (const t of h.taskIds) {
        // a task where the guest only has a few overlap pins isn't "out" as a whole
        const whole = !h.checkPins?.length || h.pinIds.some((p) => away.has(p) && !h.checkPins!.includes(p));
        if (whole) m.set(t, m.has(t) ? `${m.get(t)}, ${h.guest}` : h.guest);
      }
  return m;
}

/** Ungraded pins per task (excluding pins already handed out and auto-wrong double pins). */
export function remainingByTask(s: Session, tasks: Task[]): { task: Task; pinIds: string[] }[] {
  const g = s.grades;
  const away = awayPins(s);
  const checks = g.checks ?? {};
  const doubles = new Map<number, Set<string>>();
  return tasks.map((task) => {
    if (!doubles.has(task.q)) doubles.set(task.q, doublePinIds(s.pins, task.q, g));
    const dbl = doubles.get(task.q)!;
    const pinIds = pinsForTask(s.pins, task, g)
      .filter((p) => !g.pinGroup[p.id] && !dbl.has(p.id) && !away.has(p.id) && !checks[p.id])
      .map((p) => p.id);
    return { task, pinIds };
  });
}

/**
 * Split items between people in proportion to `weights` (e.g. [50, 30, 20]), by pin count, keeping each
 * item whole. Largest first, each to whoever is furthest below their share. A weight of 0 gets nothing.
 * Returns item id → person index.
 */
export function splitWeighted(items: { id: string; n: number }[], weights: number[]): Map<string, number> {
  const out = new Map<string, number>();
  const sum = weights.reduce((a, b) => a + Math.max(0, b), 0);
  if (!weights.length || sum <= 0) return out;
  const w = weights.map((x) => Math.max(0, x) / sum);
  const load = new Array(weights.length).fill(0);
  for (const it of [...items].sort((a, b) => b.n - a.n || a.id.localeCompare(b.id))) {
    // give it to whoever would end up least over their share
    let best = -1;
    let bestScore = Infinity;
    for (let i = 0; i < w.length; i++) {
      if (w[i] <= 0) continue;
      const score = (load[i] + it.n) / w[i];
      if (score < bestScore - 1e-9) (best = i), (bestScore = score);
    }
    out.set(it.id, best);
    load[best] += it.n;
  }
  return out;
}

/** a small seeded random generator, so a plan is repeatable (tests) */
export function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Choose pins to grade twice. From each image, `share` of its pins (at least one when share > 0) are
 * also given to a second person: someone in `partners` other than the image's own grader, picking
 * whoever has the fewest overlap pins so far. Images whose grader isn't in `partners` (the host's own
 * images when the host isn't taking part) are graded once.
 * Returns pin id → [first grader column, second grader column].
 */
export function planOverlap(
  images: { taskId: string; pinIds: string[]; col: number }[],
  partners: number[],
  share: number,
  rand: () => number = Math.random,
): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  if (share <= 0) return out;
  const load = new Map(partners.map((c) => [c, 0]));
  for (const im of images) {
    if (!partners.includes(im.col)) continue;
    const others = partners.filter((c) => c !== im.col);
    if (!others.length || !im.pinIds.length) continue;
    const k = Math.min(im.pinIds.length, Math.max(1, Math.round(im.pinIds.length * share)));
    const pool = [...im.pinIds];
    for (let i = 0; i < k; i++) {
      const j = i + Math.floor(rand() * (pool.length - i));
      [pool[i], pool[j]] = [pool[j], pool[i]];
      let best = others[0];
      for (const c of others) if (load.get(c)! < load.get(best)!) best = c;
      load.set(best, load.get(best)! + 1);
      out.set(pool[i], [im.col, best]);
    }
  }
  return out;
}

/** Build the pack the guest opens. Grades for pins someone else grades too are left out, so the guest grades blind. */
export function makePack(s: Session, guest: string, taskIds: string[], pinIds: string[]): PackFile {
  const mine = new Set(pinIds);
  const groups: Record<string, Group> = {};
  const pinGroup: Record<string, string> = {};
  for (const grp of Object.values(s.grades.groups)) {
    const keep = grp.pinIds.filter((id) => !mine.has(id));
    if (!keep.length) continue;
    groups[grp.id] = { ...grp, pinIds: keep };
    for (const id of keep) pinGroup[id] = grp.id;
  }
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
      grades: { groups, pinGroup, assign: { ...s.grades.assign } },
      slides: s.slides.map((r) => ({ id: r.id, file: r.path.split(/[\\/]/).pop() ?? r.path })),
    },
  };
}

const newer = "It was made by a newer version of Micro Speed Grader. Update the app (Micro Speed Grader ▸ Check for Updates…) and try again.";

export function parsePack(raw: string): PackFile {
  const p = JSON.parse(raw) as PackFile;
  if (p?.kind !== "msg-handoff") throw new Error("This isn't a Micro Speed Grader hand-off pack.");
  if (typeof p.version === "number" && p.version > 1) throw new Error(`Can't open this pack. ${newer}`);
  if (p.version !== 1 || !Array.isArray(p.pinIds) || !p.session?.pins) throw new Error("This hand-off pack is damaged.");
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
    grades: { groups: p.session.grades.groups, pinGroup: p.session.grades.pinGroup, assign: p.session.grades.assign },
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
    if (pinIds.length) groups.push({ ...grp, pinIds, by: undefined });
  }
  const assign: Record<string, number> = {};
  for (const [id, q] of Object.entries(s.grades.assign)) if (mine.has(id)) assign[id] = q;
  return { kind: "msg-handoff-result", version: 1, packId: gp.id, guest: gp.guest, sentAt: Date.now(), groups, assign };
}

export function parseResult(raw: string): ResultFile {
  const r = JSON.parse(raw) as ResultFile;
  if (r?.kind !== "msg-handoff-result") throw new Error("This isn't a Micro Speed Grader results file.");
  if (typeof r.version === "number" && r.version > 1) throw new Error(`Can't import these results. ${newer}`);
  if (r.version !== 1 || !Array.isArray(r.groups)) throw new Error("This results file is damaged.");
  return r;
}

/** How many of the pack's pins the guest has graded (for the guest's "send back" button). */
export function guestProgress(s: Session): { done: number; total: number } {
  const gp = s.guestPack;
  if (!gp) return { done: 0, total: 0 };
  return { done: gp.pinIds.filter((id) => s.grades.pinGroup[id]).length, total: gp.pinIds.length };
}

// ---------------------------------------------------------------- comparing two graders

const STOP = new Set(["the", "and", "not", "with", "but", "this", "that", "are", "was", "its", "has", "for", "from", "into", "pin", "pinned", "marked", "instead", "incorrect", "wrong"]);
const stem = (w: string) => w.replace(/(ies)$/, "y").replace(/(es|s)$/, (m, _g, i) => (i > 3 ? "" : m));
/** the main words of a reason: lower case, no punctuation, no filler words, plurals folded */
export const reasonWords = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/[\s-]+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map(stem);

function close(a: string, b: string) {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 2) return false;
  // edit distance ≤ 2 (typos)
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length] <= 2;
}

/**
 * Do two wrong-answer reasons say the same thing? Only clearly different reasons disagree:
 * case, punctuation, plurals and small typos are ignored, and sharing any main word counts as the same.
 * A blank reason agrees with anything.
 */
export function sameReason(a: string, b: string) {
  const x = reasonWords(a), y = reasonWords(b);
  if (!x.length || !y.length) return true;
  return x.some((w) => y.some((v) => close(w, v)));
}

export const sameVerdict = (a: Verdict, b: Verdict) => a.status === b.status && (a.status === "correct" || sameReason(a.text, b.text));

/** give pins a grade, as one group per (task, status, text, by) */
function applyVerdicts(g: GradeState, items: { pinId: string; taskId: string; v: Omit<Verdict, "at">; assignQ?: number; pin?: Pin }[]) {
  const byKey = new Map<string, Group>();
  for (const it of items) {
    detach(g, [it.pinId]);
    const k = `${it.taskId}\u0000${it.v.status}\u0000${it.v.text}\u0000${it.v.by}`;
    let grp = byKey.get(k);
    if (!grp) {
      grp = { id: uid(), taskId: it.taskId, status: it.v.status, text: it.v.text.slice(0, 2000), pinIds: [], createdAt: Date.now(), ...(it.v.by && it.v.by !== HOST ? { by: it.v.by } : {}) };
      byKey.set(k, grp);
      g.groups[grp.id] = grp;
    }
    grp.pinIds.push(it.pinId);
    g.pinGroup[it.pinId] = grp.id;
    if (it.pin?.q === null && typeof it.assignQ === "number") g.assign[it.pinId] = it.assignQ;
  }
}

/** names as they're shown on a grade both graders agreed on */
const joinNames = (vs: Verdict[]) => [...new Set(vs.map((v) => graderLabel(v.by)))].join(" & ");

/**
 * Settle the checks on these pins: when every grader's verdict is in, agreeing pins get the grade
 * and disagreeing ones are left ungraded and flagged. Returns how many became disagreements.
 */
export function reconcile(g: GradeState, pinIds: Iterable<string>, pins: Map<string, Pin>): number {
  const checks = g.checks ?? {};
  let conflicts = 0;
  const agreed: Parameters<typeof applyVerdicts>[1] = [];
  for (const id of pinIds) {
    const c = checks[id];
    if (!c || c.state === "resolved") continue;
    const graders = c.graders.length ? c.graders : [...new Set(c.verdicts.map((v) => v.by))];
    const vs = graders.map((by) => c.verdicts.find((v) => v.by === by)).filter((v): v is Verdict => !!v);
    if (vs.length < graders.length) {
      checks[id] = { ...c, state: "waiting" };
      continue;
    }
    if (vs.every((v) => sameVerdict(v, vs[0]))) {
      checks[id] = { ...c, state: "agreed" };
      // keep the host's own group if the host was one of the graders; otherwise give it the joint grade
      const gid = g.pinGroup[id];
      const hostGraded = gid && !g.groups[gid]?.by && graders.includes(HOST);
      if (!hostGraded) agreed.push({ pinId: id, taskId: c.taskId, v: { by: vs.length > 1 ? joinNames(vs) : vs[0].by, status: vs[0].status, text: vs.find((v) => v.text)?.text ?? "" }, assignQ: c.assignQ, pin: pins.get(id) });
    } else {
      if (c.state !== "conflict") conflicts++;
      checks[id] = { ...c, state: "conflict" };
      detach(g, [id]);
    }
  }
  if (agreed.length) applyVerdicts(g, agreed);
  g.checks = checks;
  return conflicts;
}

/** A guest's pack was recalled: they no longer count as a grader on its pins that are graded twice. */
export function recallChecks(g: GradeState, guest: string, pinIds: string[], pins: Map<string, Pin>): GradeState {
  const next: GradeState = { ...cloneGrades(g), checks: { ...(g.checks ?? {}) } };
  const touched: string[] = [];
  for (const id of pinIds) {
    const c = next.checks![id];
    if (!c || c.state !== "waiting" || !c.graders.includes(guest)) continue;
    const graders = c.graders.filter((x) => x !== guest);
    if (!graders.length) delete next.checks![id];
    else {
      next.checks![id] = { ...c, graders, verdicts: c.verdicts.filter((v) => v.by !== guest) };
      touched.push(id);
    }
  }
  reconcile(next, touched, pins);
  return next;
}

/**
 * The host graded (or regraded) pins. For pins graded twice: record the host's verdict if the host is
 * one of the graders, or, for a disagreement, take the host's grade as the decision.
 * Call after the host's grade is in `g`. Returns how many became disagreements.
 */
export function hostGraded(g: GradeState, pinIds: string[], pins: Map<string, Pin>): number {
  if (!g.checks) return 0;
  const checks = { ...g.checks };
  g.checks = checks;
  const toReconcile: string[] = [];
  for (const id of pinIds) {
    const c = checks[id];
    if (!c) continue;
    const grp = g.groups[g.pinGroup[id]];
    if (c.state === "conflict" || c.state === "agreed" || !c.graders.includes(HOST)) {
      checks[id] = { ...c, state: "resolved" };
      continue;
    }
    if (!grp) continue;
    const v: Verdict = { by: HOST, status: grp.status, text: grp.text, at: Date.now() };
    checks[id] = { ...c, verdicts: [...c.verdicts.filter((x) => x.by !== HOST), v], assignQ: c.assignQ ?? g.assign[id] };
    toReconcile.push(id);
  }
  return reconcile(g, toReconcile, pins);
}

/** pins that are disagreements waiting for the host */
export const conflictPins = (g: GradeState) => Object.entries(g.checks ?? {}).filter(([, c]) => c.state === "conflict").map(([id]) => id);

/** Resolve disagreements by taking one grader's verdict. */
export function resolveWith(g: GradeState, pinIds: string[], by: string, pins: Map<string, Pin>): GradeState {
  const next: GradeState = { ...cloneGrades(g), checks: { ...(g.checks ?? {}) } };
  const items: Parameters<typeof applyVerdicts>[1] = [];
  for (const id of pinIds) {
    const c = next.checks![id];
    const v = c?.verdicts.find((x) => x.by === by);
    if (!c || !v) continue;
    items.push({ pinId: id, taskId: c.taskId, v, assignQ: c.assignQ, pin: pins.get(id) });
    next.checks![id] = { ...c, state: "resolved" };
  }
  applyVerdicts(next, items);
  return next;
}

/**
 * Merge a guest's results into the host's grades.
 *  - Only pins that were in the pack are taken.
 *  - Pins graded twice: the guest's verdict is recorded and compared once the other grader's is in.
 *  - Pins the host graded meanwhile (e.g. after a recall) keep the host's grade.
 *  - Pins this guest graded before (an earlier results file) are updated.
 *  - Pins another guest graded meanwhile (after a recall) become a check between the two.
 */
export function mergeResult(
  s: Session,
  r: ResultFile,
): { grades: GradeState; handoffs: Handoff[]; merged: number; updated: number; skipped: number; conflicts: number; waiting: number } {
  const hs = s.handoffs ?? [];
  const h = hs.find((x) => x.id === r.packId);
  if (!h) throw new Error("These results are for a pack that wasn't made from this session.");
  const allowed = new Set(h.pinIds);
  const g: GradeState = { ...cloneGrades(s.grades), checks: { ...(s.grades.checks ?? {}) } };
  const pinById = pinMap(s.pins);
  const fresh: Parameters<typeof applyVerdicts>[1] = [];
  const touched = new Set<string>();
  let merged = 0, updated = 0, skipped = 0;
  const now = Date.now();
  for (const grp of r.groups) {
    if (grp.status !== "correct" && grp.status !== "wrong") continue;
    const v: Verdict = { by: r.guest, status: grp.status, text: String(grp.text ?? "").slice(0, 2000), at: Number(grp.createdAt) || now };
    for (const id of grp.pinIds) {
      if (!allowed.has(id) || !pinById.has(id)) continue;
      const assignQ = typeof r.assign?.[id] === "number" ? r.assign[id] : undefined;
      const c = g.checks![id];
      if (c && c.graders.includes(r.guest) && c.state !== "resolved") {
        g.checks![id] = { ...c, verdicts: [...c.verdicts.filter((x) => x.by !== r.guest), v], assignQ: c.assignQ ?? assignQ };
        touched.add(id);
        merged++;
        continue;
      }
      const cur = g.groups[g.pinGroup[id]];
      if (!cur) {
        fresh.push({ pinId: id, taskId: String(grp.taskId), v, assignQ, pin: pinById.get(id) });
        merged++;
      } else if (cur.by === r.guest) {
        if (cur.status !== v.status || cur.text !== v.text) {
          fresh.push({ pinId: id, taskId: String(grp.taskId), v, assignQ, pin: pinById.get(id) });
          updated++;
        }
      } else if (!cur.by || c?.state === "resolved") {
        skipped++; // the host's own grade (or the host's decision) wins
      } else {
        // another guest graded it too (the pack was recalled and handed on): compare the two
        const other: Verdict = { by: cur.by, status: cur.status, text: cur.text, at: cur.createdAt };
        g.checks![id] = { taskId: cur.taskId, graders: [cur.by, r.guest], verdicts: [other, v], state: "waiting", assignQ: g.assign[id] ?? assignQ };
        touched.add(id);
        merged++;
      }
    }
  }
  applyVerdicts(g, fresh);
  const conflicts = reconcile(g, touched, pinById);
  const waiting = [...touched].filter((id) => g.checks![id]?.state === "waiting").length;
  const handoffs = hs.map((x) =>
    x.id === h.id ? { ...x, status: "returned" as const, returnedAt: now, mergedCount: (x.mergedCount ?? 0) + merged } : x,
  );
  return { grades: g, handoffs, merged, updated, skipped, conflicts, waiting };
}

// ---------------------------------------------------------------- how well graders agree

export interface PairStats {
  a: string;
  b: string;
  pins: number;
  agree: number;
  /** Cohen's kappa on correct/wrong (null when it can't be computed) */
  kappa: number | null;
}

/** Agreement between each pair of graders over every pin both graded (before the host's decision). */
export function agreement(g: GradeState): PairStats[] {
  const pairs = new Map<string, { a: string; b: string; n: number; agree: number; t: [number, number, number, number] }>();
  for (const c of Object.values(g.checks ?? {})) {
    if (c.verdicts.length < 2 || c.state === "waiting") continue;
    const vs = [...c.verdicts].sort((x, y) => x.by.localeCompare(y.by));
    for (let i = 0; i < vs.length; i++)
      for (let j = i + 1; j < vs.length; j++) {
        const k = `${vs[i].by}\u0000${vs[j].by}`;
        const p = pairs.get(k) ?? { a: vs[i].by, b: vs[j].by, n: 0, agree: 0, t: [0, 0, 0, 0] as [number, number, number, number] };
        p.n++;
        if (sameVerdict(vs[i], vs[j])) p.agree++;
        // 2×2 table on correct(0)/wrong(1)
        p.t[(vs[i].status === "wrong" ? 2 : 0) + (vs[j].status === "wrong" ? 1 : 0)]++;
        pairs.set(k, p);
      }
  }
  return [...pairs.values()].map((p) => {
    const [cc, cw, wc, ww] = p.t;
    const n = p.n;
    const po = (cc + ww) / n;
    const pe = ((cc + cw) / n) * ((cc + wc) / n) + ((wc + ww) / n) * ((cw + ww) / n);
    // if either grader gave the same grade to every shared pin, kappa says nothing useful
    const oneSided = cc + cw === 0 || wc + ww === 0 || cc + wc === 0 || cw + ww === 0;
    return { a: p.a, b: p.b, pins: n, agree: p.agree, kappa: oneSided || pe >= 1 ? null : (po - pe) / (1 - pe) };
  });
}
