import { create } from "zustand";
import type { GradeState, GradeStatus, Group, Pin, RetiredPin, Session, Question } from "./types";
import { graderLabel, hostGraded, type Handoff } from "./handoff";
import type { AnswerKey } from "./answerKey";
import type { RescanResult, ReviewChange } from "./rescan";
import { activeSecs, MAX_EVENTS, type TimeEvent } from "./timing";
import { writeText } from "./backend";
import { cloneGrades, detach, pinMap } from "./grading";
import { uid } from "./util";


export interface MenuState {
  x: number;
  y: number;
  pinIds: string[];
  mode: "root" | "correct" | "wrong";
  title: string;
  /** "painted ✓ / rest ✗": these (painted) pins are marked correct along with the wrong reason for menu.pinIds */
  paintOk?: string[];
}

/** what one undo step puts back: the grades, and the pins (Changed submissions can restore pins) */
interface Snap {
  grades: GradeState;
  pins: Pin[];
  retired?: RetiredPin[];
}
const snap = (s: Session): Snap => ({ grades: s.grades, pins: s.pins, retired: s.retired });

interface Store {
  session: Session | null;
  past: Snap[];
  future: Snap[];
  dirty: boolean;
  saveError: string | null;

  // ephemeral UI state
  selection: string[];
  isolate: boolean;
  clusterIndex: number;
  flagsVisible: boolean;
  /** pin-by-pin mode: show and grade one pin of the cluster at a time */
  pinMode: boolean;
  minimapVisible: boolean;
  ledgerAllTasks: boolean;
  menu: MenuState | null;
  focusRequest: { pinIds: string[]; nonce: number } | null;
  settingsOpen: boolean;
  exportOpen: boolean;
  handoffOpen: boolean;
  conflictsOpen: boolean;
  /** the Changed submissions review */
  changesOpen: boolean;
  /** the exam question editor (inside a session) */
  examEditOpen: boolean;
  /** editing the answer key instead of grading */
  keyMode: boolean;
  /** the "what should the key apply to?" dialog */
  keyApplyOpen: boolean;
  /** the student panel: null = closed, id "" = pick a student; q = the question to point at */
  studentView: { id: string; q?: number } | null;
  /** a one-line notice over the slide (e.g. "you replaced Jamie's grade") with optional undo */
  notice: { kind: "override" | "conflict" | "info"; text: string; undo?: boolean; review?: boolean; problems?: number } | null;
  /** File ▸ Rescan Submissions… (a request the grading screen acts on) */
  rescanAsk: number;
  /** "don't warn me again" for replacing other graders' grades, until the app is closed */
  overrideQuiet: boolean;
  /** help viewer: null = closed, "" = topic list, else a topic id */
  help: string | null;
  startupIntent: null | "new" | "open";

  load: (s: Session) => void;
  close: () => void;
  setTask: (i: number) => void;
  grade: (pinIds: string[], status: GradeStatus, text: string, taskId: string, assignQ: number) => void;
  /** several grades as one undo step (e.g. painted pins correct + the rest wrong); a batch may name its own image */
  gradeMany: (batches: { pinIds: string[]; status: GradeStatus; text: string; taskId?: string }[], taskId: string, assignQ: number) => void;
  ungrade: (pinIds: string[]) => void;
  editGroup: (groupId: string, patch: Partial<Pick<Group, "status" | "text">>) => void;
  undo: () => void;
  redo: () => void;
  set: (patch: Partial<Store>) => void;
  focusPins: (pinIds: string[]) => void;
  /** go to an image (by index) and select + zoom to these pins */
  showPins: (taskIndex: number, pinIds: string[]) => void;
  saveNow: () => Promise<void>;
  /** host: record packs sent out / recalled */
  setHandoffs: (h: Handoff[]) => void;
  /** host: merge a guest's results (one undo step); `retired`: grades for pins changed since the pack was sent */
  applyResult: (grades: GradeState, h: Handoff[], timeLog?: TimeEvent[], retired?: RetiredPin[]) => void;
  /** the exam's questions were edited inside the session (clears undo; a copy was saved at `backup`) */
  applyQuestionEdit: (questions: Question[], r: RescanResult, grades: GradeState, backup: string) => void;
  /** "Things to check" after a rescan: files whose slide was chosen, and acknowledged problems */
  setScanFixes: (fileSlides: Record<string, string>, scanAck: string[]) => void;
  /** save the answer key (marks aren't part of undo; applying them is) */
  setKey: (key: AnswerKey) => void;
  /** grades changed by applying the answer key (one undo step) */
  applyGrades: (grades: GradeState) => void;
  /** new students/pins from Rescan submissions (clears undo: earlier steps refer to the old pins) */
  applyRescan: (r: RescanResult, grades: GradeState) => void;
  /** carry over / restore / dismiss in Changed submissions (one undo step) */
  applyReview: (c: ReviewChange) => void;
}

/** other graders whose grades on these pins are about to be replaced, e.g. ["Jamie"] and how many pins */
function othersOn(g: GradeState, pinIds: string[]) {
  const names = new Map<string, number>();
  for (const id of pinIds) {
    const by = g.groups[g.pinGroup[id]]?.by;
    if (by) names.set(by, (names.get(by) ?? 0) + 1);
  }
  return names;
}
const overrideText = (names: Map<string, number>) => {
  const n = [...names.values()].reduce((a, b) => a + b, 0);
  const who = [...names.keys()].map(graderLabel).join(", ");
  return `${n} pin${n === 1 ? " was" : "s were"} graded by ${who}. Your grade replaced theirs.`;
};

let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** when the grader last graded (or opened an image): the start of the next grading action's time */
let lastActivity = Date.now();

export const useStore = create<Store>((set, get) => {
  const commit = (next: GradeState, more?: Omit<Snap, "grades">) => {
    const s = get().session;
    if (!s) return;
    set({
      session: { ...s, ...more, grades: next },
      past: [...get().past.slice(-199), snap(s)],
      future: [],
      dirty: true,
    });
    scheduleSave();
  };

  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void get().saveNow(), 600);
  };

  return {
    session: null,
    past: [],
    future: [],
    dirty: false,
    saveError: null,
    selection: [],
    isolate: false,
    clusterIndex: 0,
    flagsVisible: true,
    pinMode: false,
    minimapVisible: true,
    ledgerAllTasks: false,
    menu: null,
    focusRequest: null,
    settingsOpen: false,
    exportOpen: false,
    handoffOpen: false,
    conflictsOpen: false,
    changesOpen: false,
    keyMode: false,
    keyApplyOpen: false,
    examEditOpen: false,
    studentView: null,
    notice: null,
    rescanAsk: 0,
    overrideQuiet: false,
    help: null,
    startupIntent: null,

    load: (session) => {
      lastActivity = Date.now();
      set({ session, past: [], future: [], dirty: false, selection: [], clusterIndex: 0, menu: null, isolate: false, keyMode: false, keyApplyOpen: false, changesOpen: false, studentView: null, notice: null });
    },
    close: () => set({ session: null, past: [], future: [], studentView: null }),

    setTask: (i) => {
      const s = get().session;
      if (!s) return;
      lastActivity = Date.now();
      set({ session: { ...s, taskIndex: i }, selection: [], clusterIndex: 0, menu: null, isolate: false, dirty: true });
      scheduleSave();
    },

    grade: (pinIds, status, text, tId, assignQ) => get().gradeMany([{ pinIds, status, text }], tId, assignQ),

    gradeMany: (batches, tId, assignQ) => {
      const s = get().session;
      batches = batches.filter((b) => b.pinIds.length);
      if (!s || !batches.length) return;
      const g = cloneGrades(s.grades);
      const all = batches.flatMap((b) => b.pinIds);
      const others = othersOn(g, all);
      for (const { pinIds, status, text, taskId } of batches) {
        detach(g, pinIds);
        const id = uid();
        g.groups[id] = { id, taskId: taskId ?? tId, status, text: text.trim(), pinIds: [...pinIds], createdAt: Date.now() };
        for (const p of pinIds) {
          g.pinGroup[p] = id;
          const pin = s.pins.find((x) => x.id === p);
          if (pin && pin.q === null) g.assign[p] = assignQ;
        }
      }
      // pins graded twice: record your verdict, or settle a disagreement with your grade
      const conflicts = g.checks ? hostGraded(g, all, pinMap(s.pins)) : 0;
      commit(g);
      // time spent (export only): since the last grade, or since this image was opened; breaks capped
      const now = Date.now();
      const ev: TimeEvent = { at: now, taskId: batches[0].taskId ?? tId, pinIds: all, secs: activeSecs(lastActivity, now) };
      lastActivity = now;
      const cur = get().session!;
      set({ session: { ...cur, timeLog: [...(cur.timeLog ?? []), ev].slice(-MAX_EVENTS) } });
      const notice = conflicts
        ? { kind: "conflict" as const, text: `${conflicts} pin${conflicts === 1 ? "" : "s"} you graded disagree${conflicts === 1 ? "s" : ""} with another grader. They're flagged in Disagreements.` }
        : others.size && !get().overrideQuiet
          ? { kind: "override" as const, text: overrideText(others), undo: true }
          : null;
      set({ selection: [], menu: null, isolate: false, ...(notice ? { notice } : {}) });
    },

    ungrade: (pinIds) => {
      const s = get().session;
      if (!s) return;
      const g = cloneGrades(s.grades);
      const others = othersOn(g, pinIds);
      detach(g, pinIds);
      for (const p of pinIds) delete g.assign[p];
      commit(g);
      if (others.size && !get().overrideQuiet)
        set({ notice: { kind: "override", text: overrideText(others).replace("Your grade replaced theirs.", "You removed their grade."), undo: true } });
    },

    editGroup: (groupId, patch) => {
      const s = get().session;
      if (!s || !s.grades.groups[groupId]) return;
      const g = cloneGrades(s.grades);
      const by = g.groups[groupId].by;
      g.groups[groupId] = { ...g.groups[groupId], ...patch, by: undefined };
      commit(g);
      if (by && !get().overrideQuiet)
        set({ notice: { kind: "override", text: `You changed a grade ${graderLabel(by)} gave. It's now yours.`, undo: true } });
    },

    undo: () => {
      const { past, session } = get();
      if (!session || !past.length) return;
      set({
        session: { ...session, ...past[past.length - 1] },
        past: past.slice(0, -1),
        future: [snap(session), ...get().future],
        dirty: true,
        menu: null,
      });
      scheduleSave();
    },
    redo: () => {
      const { future, session } = get();
      if (!session || !future.length) return;
      set({
        session: { ...session, ...future[0] },
        future: future.slice(1),
        past: [...get().past, snap(session)],
        dirty: true,
        menu: null,
      });
      scheduleSave();
    },

    set: (patch) => set(patch),
    setHandoffs: (handoffs) => {
      const s = get().session;
      if (!s) return;
      set({ session: { ...s, handoffs }, dirty: true });
      scheduleSave();
    },
    applyResult: (grades, handoffs, timeLog, retired) => {
      const s = get().session;
      if (!s) return;
      set({ session: { ...s, handoffs, ...(timeLog ? { timeLog } : {}) } });
      commit(grades, retired ? { pins: s.pins, retired } : undefined);
    },
    applyQuestionEdit: (questions, r, grades, backup) => {
      const s = get().session;
      if (!s) return;
      set({
        session: { ...s, questions, students: r.students, pins: r.pins, retired: r.retired, grades, taskIndex: 0 },
        past: [],
        future: [],
        selection: [],
        menu: null,
        dirty: true,
        notice: { kind: "info", text: `Questions updated. A copy of the session from before was saved as “${backup.split(/[\\/]/).pop()}”.` },
      });
      scheduleSave();
    },
    setScanFixes: (fileSlides, scanAck) => {
      const s = get().session;
      if (!s) return;
      set({ session: { ...s, fileSlides, scanAck }, dirty: true });
      scheduleSave();
    },
    setKey: (key) => {
      const s = get().session;
      if (!s) return;
      set({ session: { ...s, key }, dirty: true });
      scheduleSave();
    },
    applyGrades: (grades) => commit(grades),
    applyRescan: (r, grades) => {
      const s = get().session;
      if (!s) return;
      set({
        session: { ...s, students: r.students, pins: r.pins, retired: r.retired, grades },
        past: [],
        future: [],
        selection: [],
        menu: null,
        dirty: true,
      });
      scheduleSave();
    },
    applyReview: (c) => commit(c.grades, { pins: c.pins, retired: c.retired }),
    focusPins: (pinIds) => set({ focusRequest: { pinIds, nonce: Date.now() } }),
    showPins: (taskIndex, pinIds) => {
      const s = get().session;
      if (s && taskIndex >= 0 && taskIndex !== s.taskIndex) get().setTask(taskIndex);
      set({ selection: pinIds, focusRequest: { pinIds, nonce: Date.now() } });
    },

    saveNow: async () => {
      const s = get().session;
      if (!s) return;
      const toSave: Session = { ...s, savedAt: Date.now() };
      try {
        await writeText(s.sessionPath, JSON.stringify(toSave), true);
        set({ dirty: false, saveError: null });
        rememberRecent(s.sessionPath, s.name);
      } catch (e) {
        set({ saveError: String(e) });
      }
    },
  };
});

// ---- recent sessions (for the start screen) ----
const RECENT_KEY = "msg.recent.v1";
export interface Recent {
  path: string;
  name: string;
  at: number;
}
export function recentSessions(): Recent[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  } catch {
    return [];
  }
}
export function rememberRecent(path: string, name: string) {
  try {
    const list = recentSessions().filter((r) => r.path !== path);
    list.unshift({ path, name, at: Date.now() });
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 10)));
  } catch {
    /* ignore */
  }
}
export function forgetRecent(path: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recentSessions().filter((r) => r.path !== path)));
  } catch {
    /* ignore */
  }
}
