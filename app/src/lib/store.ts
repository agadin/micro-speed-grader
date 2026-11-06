import { create } from "zustand";
import type { GradeState, GradeStatus, Group, Session } from "./types";
import { writeText } from "./backend";

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export interface MenuState {
  x: number;
  y: number;
  pinIds: string[];
  mode: "root" | "correct" | "wrong";
  title: string;
}

interface Store {
  session: Session | null;
  past: GradeState[];
  future: GradeState[];
  dirty: boolean;
  lastSaved: number | null;
  saveError: string | null;

  // ephemeral UI state
  selection: string[];
  isolate: boolean;
  clusterIndex: number;
  flagsVisible: boolean;
  minimapVisible: boolean;
  ledgerAllTasks: boolean;
  menu: MenuState | null;
  focusRequest: { pinIds: string[]; nonce: number } | null;
  settingsOpen: boolean;
  exportOpen: boolean;
  startupIntent: null | "new" | "open";

  load: (s: Session) => void;
  close: () => void;
  setTask: (i: number) => void;
  grade: (pinIds: string[], status: GradeStatus, text: string, taskId: string, assignQ: number) => void;
  ungrade: (pinIds: string[]) => void;
  editGroup: (groupId: string, patch: Partial<Pick<Group, "status" | "text">>) => void;
  undo: () => void;
  redo: () => void;
  set: (patch: Partial<Store>) => void;
  focusPins: (pinIds: string[]) => void;
  saveNow: () => Promise<void>;
}

const cloneGrades = (g: GradeState): GradeState => ({
  groups: { ...g.groups },
  pinGroup: { ...g.pinGroup },
  assign: { ...g.assign },
});

/** Remove pins from whatever group they're in (deleting emptied groups). */
function detach(g: GradeState, pinIds: string[]) {
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

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export const useStore = create<Store>((set, get) => {
  const commit = (next: GradeState) => {
    const s = get().session;
    if (!s) return;
    set({
      session: { ...s, grades: next },
      past: [...get().past.slice(-199), s.grades],
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
    lastSaved: null,
    saveError: null,
    selection: [],
    isolate: false,
    clusterIndex: 0,
    flagsVisible: true,
    minimapVisible: true,
    ledgerAllTasks: false,
    menu: null,
    focusRequest: null,
    settingsOpen: false,
    exportOpen: false,
    startupIntent: null,

    load: (session) =>
      set({ session, past: [], future: [], dirty: false, selection: [], clusterIndex: 0, menu: null, isolate: false }),
    close: () => set({ session: null, past: [], future: [] }),

    setTask: (i) => {
      const s = get().session;
      if (!s) return;
      set({ session: { ...s, taskIndex: i }, selection: [], clusterIndex: 0, menu: null, isolate: false, dirty: true });
      scheduleSave();
    },

    grade: (pinIds, status, text, tId, assignQ) => {
      const s = get().session;
      if (!s || !pinIds.length) return;
      const g = cloneGrades(s.grades);
      detach(g, pinIds);
      const id = uid();
      g.groups[id] = { id, taskId: tId, status, text: text.trim(), pinIds: [...pinIds], createdAt: Date.now() };
      for (const p of pinIds) {
        g.pinGroup[p] = id;
        const pin = s.pins.find((x) => x.id === p);
        if (pin && pin.q === null) g.assign[p] = assignQ;
      }
      commit(g);
      set({ selection: [], menu: null, isolate: false });
    },

    ungrade: (pinIds) => {
      const s = get().session;
      if (!s) return;
      const g = cloneGrades(s.grades);
      detach(g, pinIds);
      for (const p of pinIds) delete g.assign[p];
      commit(g);
    },

    editGroup: (groupId, patch) => {
      const s = get().session;
      if (!s || !s.grades.groups[groupId]) return;
      const g = cloneGrades(s.grades);
      g.groups[groupId] = { ...g.groups[groupId], ...patch };
      commit(g);
    },

    undo: () => {
      const { past, session } = get();
      if (!session || !past.length) return;
      set({
        session: { ...session, grades: past[past.length - 1] },
        past: past.slice(0, -1),
        future: [session.grades, ...get().future],
        dirty: true,
        menu: null,
      });
      scheduleSave();
    },
    redo: () => {
      const { future, session } = get();
      if (!session || !future.length) return;
      set({
        session: { ...session, grades: future[0] },
        future: future.slice(1),
        past: [...get().past, session.grades],
        dirty: true,
        menu: null,
      });
      scheduleSave();
    },

    set: (patch) => set(patch),
    focusPins: (pinIds) => set({ focusRequest: { pinIds, nonce: Date.now() } }),

    saveNow: async () => {
      const s = get().session;
      if (!s) return;
      const toSave: Session = { ...s, savedAt: Date.now() };
      try {
        await writeText(s.sessionPath, JSON.stringify(toSave), true);
        set({ dirty: false, lastSaved: toSave.savedAt, saveError: null });
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
