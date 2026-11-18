import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { activeTool, keyLabel, SELECT_TOOLS, useSettings, type SelectTool, BRUSH_MAX, BRUSH_MIN } from "../lib/settings";
import { pinsInPaint, type PaintOp } from "../lib/paint";
import {
  buildTasks,
  doublePinIds,
  pinState,
  pinsForTask,
  type PinState,
  parseTaskId,
  taskLabel,
} from "../lib/grading";
import { computeClusters, type Cluster } from "../lib/cluster";
import { openSlide, dirname, hasTauri, isMac, joinPath, showHelp, withExt, writeText } from "../lib/backend";
import { awayPins, awayTasks, conflictPins, guestProgress, makeResult } from "../lib/handoff";
import { safeFileName } from "../lib/exportCsv";
import { save } from "@tauri-apps/plugin-dialog";
import { HandoffDialog } from "./HandoffDialog";
import { ConflictsDialog } from "./ConflictsDialog";
import type { Session, SlideInfo } from "../lib/types";
import { SlideViewer, type ViewerApi } from "./SlideViewer";
import { ContextMenu } from "./ContextMenu";
import { Ledger } from "./Ledger";
import { RightPanel, type Progress } from "./RightPanel";
import { KeyPanel } from "./KeyPanel";
import { ExamEditor } from "./ExamEditor";
import { KeyApplyDialog } from "./KeyApplyDialog";
import { planKey, applyPlan, suggest } from "../lib/answerKey";
import type { Measure } from "../lib/measure";
import { mergeRescan, reviewPinIds, rescanMessage, reviewRows } from "../lib/rescan";
import { ChangesDialog } from "./ChangesDialog";
import { problemKey, scanSubmissions, type ScanProblem } from "../lib/loader";
import { ScanProblemsDialog, thingsToCheck, type Resolve } from "./ScanProblemsDialog";
import { ExportDialog } from "./ExportDialog";
import { StudentPanel } from "./StudentPanel";
import {
  IconCheck,
  IconChevL,
  IconChevR,
  IconChevUp,
  IconClose,
  IconCross,
  IconExport,
  IconHandoff,
  IconKey,
  IconRuler,
  IconPerson,
  IconRedo,
  IconSliders,
  IconUndo,
} from "./icons";


/** macOS window with an overlay title bar: leave room for the traffic lights */
const macOverlay = isMac && hasTauri;
const TOPBAR_H = 48;
const PANEL_W = 320;
const GAP = 10;
const TOOL_H = 40;

type KeyRow = [string[], string];
function KeySheet({ tool, swap, pinByPin, onClose }: { tool: SelectTool; swap: boolean; pinByPin: boolean; onClose: () => void }) {
  const drag = swap ? "L-drag" : "R-drag";
  const click = swap ? "L-click" : "R-click";
  const cols: [string, KeyRow[]][] = [
    [
      "Navigate",
      [
        [["["], "previous cluster"],
        [["]"], "next cluster"],
        [["F"], "refocus cluster"],
        [["H"], "whole slide"],
        [["S"], "clusters ⇄ single pins"],
        [["⌘", "←/→"], "prev / next image"],
        ...(pinByPin
          ? ([
              [["O"], "pin-by-pin mode"],
              [["←/→"], "prev / next pin"],
            ] as KeyRow[])
          : []),
      ],
    ],
    [
      "Select",
      tool === "brush"
        ? [
            [[drag], "paint"],
            [["⇧", "paint"], "add"],
            [["⌥", "paint"], "remove"],
            [["−", "="], "brush size"],
            [["B"], "next tool"],
          ]
        : tool === "polygon"
          ? [
              [[click], "add corner"],
              [["↵"], "close (or click 1st)"],
              [["⌫"], "undo corner"],
              [["⌘", click], "start: add to sel."],
              [["⇧", click], "inverse"],
              [["B"], "next tool"],
            ]
          : [
              [[drag], "lasso"],
              [["⌘", "drag"], "add to selection"],
              [["⌘", "click"], "add / remove pin"],
              [["⇧", "drag"], "inverse"],
              [["⌥", "drag"], "rectangle"],
              [["X"], "invert selection"],
              [["B"], "next tool"],
            ],
    ],
    [
      "Grade",
      [
        [["C"], "correct"],
        [["⇧", "C"], "correct + note"],
        [["W"], "wrong + reason"],
        [["↵"], "grade menu"],
        [["⌘", "Z"], "undo"],
      ],
    ],
    [
      "View",
      [
        [["Space"], "show / hide pins"],
        [["M"], "minimap"],
        [["I"], "isolate selection"],
        [["Click"], "grade one pin"],
        [["R"], "ruler: drag = distance, click corners = area"],
        [["/"], "find student"],
        [["?"], "this sheet"],
      ],
    ],
  ];
  return (
    <div className="keysheet">
      <h4>Keyboard</h4>
      <div className="cols">
        {cols.map(([title, rows]) => (
          <div key={title}>
            <div className="ks-title">{title}</div>
            {rows.map(([keys, label]) => (
              <div className="ks-row" key={label}>
                <span>{label}</span>
                <span className="k">
                  {keys.map((k) => (
                    <span className="kbd" key={k}>
                      {k}
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="ks-foot">
        <span>
          Drag the ring, tag or centre to move the cluster · drag a square
          handle to resize
        </span>
        <button className="btn ghost" onClick={onClose}>
          Close <span className="kbd">?</span>
        </button>
      </div>
    </div>
  );
}

export function Grader({ session }: { session: Session }) {
  const st = useStore();
  const settings = useSettings((s) => s.s);
  const setSettings = useSettings((s) => s.set);
  const g = session.grades;

  // ---------- derived data ----------
  const slideIds = useMemo(
    () => new Set(session.slides.map((s) => s.id)),
    [session.slides],
  );
  const guestPack = session.guestPack;
  const tasks = useMemo(() => {
    const all = buildTasks(session.questions, slideIds);
    // a second grader only sees the images they were given
    return guestPack ? all.filter((t) => guestPack.taskIds.includes(t.id)) : all;
  }, [session.questions, slideIds, guestPack]);
  // pins this grader can't touch: (host) out with someone else; (guest) not in their pack
  const locked = useMemo(() => {
    if (!guestPack) return awayPins(session);
    const mine = new Set(guestPack.pinIds);
    return new Set(session.pins.filter((p) => !mine.has(p.id)).map((p) => p.id));
  }, [session, guestPack]);
  const away = useMemo(() => awayTasks(session), [session]);
  const taskIndex = Math.min(session.taskIndex, Math.max(0, tasks.length - 1));
  const task = tasks[taskIndex];
  const question = session.questions.find((q) => q.num === task?.q);
  const studentById = useMemo(
    () => new Map(session.students.map((s) => [s.id, s])),
    [session.students],
  );
  const studentName = useCallback(
    (id: string) => studentById.get(id)?.name ?? id,
    [studentById],
  );

  const taskPins = useMemo(
    () => (task ? pinsForTask(session.pins, task, g).filter((p) => !locked.has(p.id)) : []),
    [session.pins, task, g, locked],
  );
  /** pins of this image that are out with another grader */
  const conflicts = useMemo(() => conflictPins(session.grades), [session.grades]);
  // ---- ruler: measurements on this image (not saved; cleared when the image changes) ----
  const [ruler, setRuler] = useState(false);
  const [measures, setMeasures] = useState<Measure[]>([]);
  useEffect(() => setMeasures([]), [task?.id]);
  /** Changed submissions still to review, and their new pins (badged on the slide) */
  const changes = useMemo(() => reviewRows(session), [session]);
  const changedPins = useMemo(() => reviewPinIds(changes), [changes]);
  // ---- Rescan submissions: late and changed work, graded by the key when it's set up to ----
  const rescan = async () => {
    if (guestPack || !session.submissionsDir) return;
    st.set({ notice: { kind: "info", text: "Reading the submissions folder…" } });
    try {
      const scan = await scanSubmissions(session.submissionsDir, session.questions, undefined, session.fileSlides ?? {});
      const r = mergeRescan(session, scan);
      // problems in the folder that haven't been acknowledged ("Things to check")
      const ack = new Set(session.scanAck ?? []);
      const fresh = scan.problems.filter((p) => !ack.has(problemKey(p)));
      setScanProblems(scan.problems);
      let grades = r.grades;
      const k = session.key;
      if (k && k.mode === "grade" && k.autoNew && r.added.length) {
        const next = { ...session, students: r.students, pins: r.pins, grades };
        const plan = planKey(next, k, 0, new Set(r.added));
        grades = applyPlan(next, plan);
      }
      st.applyRescan(r, grades);
      const msg = rescanMessage(r, grades);
      const pending = reviewRows({ ...session, students: r.students, pins: r.pins, retired: r.retired, grades }).length;
      st.set({ notice: { kind: "info", text: msg, review: pending > 0, ...(fresh.length ? { problems: fresh.length } : {}) } });
    } catch (e) {
      st.set({ notice: { kind: "info", text: `Could not read the submissions folder: ${e}` } });
    }
  };
  // "Things to check" found by the last rescan, fixed and acknowledged into the session
  const [scanProblems, setScanProblems] = useState<ScanProblem[] | null>(null);
  const [showScanProblems, setShowScanProblems] = useState(false);
  const scanResolve: Resolve = {
    root: session.submissionsDir,
    slides: [...new Set(session.questions.flatMap((q) => q.slides))].sort(),
    fileSlides: session.fileSlides ?? {},
    setFileSlide: (file, slide) => {
      const m = { ...(session.fileSlides ?? {}) };
      if (slide) m[file] = slide;
      else delete m[file];
      st.setScanFixes(m, session.scanAck ?? []);
    },
    acked: new Set(session.scanAck ?? []),
    setAcked: (keys, on) => {
      const a = new Set(session.scanAck ?? []);
      for (const k of keys) (on ? a.add(k) : a.delete(k));
      st.setScanFixes(session.fileSlides ?? {}, [...a]);
    },
  };
  const rescanAsk = st.rescanAsk;
  useEffect(() => {
    if (rescanAsk) void rescan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rescanAsk]);
  // notices (replaced someone's grade / new disagreements) fade on their own
  useEffect(() => {
    if (!st.notice) return;
    const t = setTimeout(() => useStore.getState().set({ notice: null }), 9000);
    return () => clearTimeout(t);
  }, [st.notice]);
  const lockedHere = useMemo(
    () => (task && !guestPack ? pinsForTask(session.pins, task, g).filter((p) => locked.has(p.id)).length : 0),
    [session.pins, task, g, locked, guestPack],
  );
  const otherPins = useMemo(
    () =>
      task
        ? session.pins.filter(
            (p) => p.slide === task.slide && !taskPins.includes(p),
          )
        : [],
    [session.pins, task, taskPins],
  );
  const doubles = useMemo(
    () => (task ? doublePinIds(session.pins, task.q, g) : new Set<string>()),
    [session.pins, task, g],
  );
  const states = useMemo(() => {
    const m = new Map<string, PinState>();
    for (const p of taskPins) m.set(p.id, pinState(p, g, doubles));
    return m;
  }, [taskPins, g, doubles]);
  const ungraded = useMemo(
    () => taskPins.filter((p) => states.get(p.id) === "ungraded"),
    [taskPins, states],
  );
  const clusters = useMemo(
    () =>
      computeClusters(
        ungraded,
        settings.clusterRadiusUm,
        settings.minClusterSize,
      ),
    [ungraded, settings.clusterRadiusUm, settings.minClusterSize],
  );
  const clusterIndex = clusters.length
    ? Math.min(st.clusterIndex, clusters.length - 1)
    : 0;
  const baseCluster = clusters[clusterIndex] ?? null;
  // a cluster the grader dragged / resized; dropped as soon as the computed cluster changes
  const baseKey = baseCluster
    ? `${task?.id}:${clusterIndex}:${baseCluster.pinIds.join(",")}`
    : "";
  const [adjusted, setAdjusted] = useState<{
    key: string;
    cluster: Cluster;
  } | null>(null);
  const liveCluster =
    adjusted && adjusted.key === baseKey ? adjusted.cluster : baseCluster;

  // ---------- pin-by-pin mode ----------
  // A snapshot of the cluster being stepped through, so grading a pin doesn't reshuffle it.
  const pinModeOn = settings.pinByPin && st.pinMode;
  const [queue, setQueue] = useState<{ key: string; cluster: Cluster; cursor: number } | null>(null);
  const queueValid =
    pinModeOn &&
    !!queue &&
    queue.key === task?.id &&
    queue.cluster.pinIds.some((id) => states.get(id) === "ungraded");
  const cluster = queueValid ? queue!.cluster : liveCluster;
  // ---- answer key ----
  const key = session.key;
  const keyHere = useMemo(() => (key && task ? key.marks.filter((m) => m.q === task.q && m.slide === task.slide) : []), [key, task]);
  const keyLayers = useMemo(() => {
    if (!keyHere.length || (!st.keyMode && !settings.showKey)) return undefined;
    const a = st.keyMode ? 0.3 : 0.2;
    return keyHere.map((m) => ({ ops: m.ops, color: m.kind === "correct" ? "#22c55e" : "#ef4444", alpha: a }));
  }, [keyHere, st.keyMode, settings.showKey]);
  /** suggest mode: what the key says about the current cluster's ungraded pins */
  const keyHint = useMemo(() => {
    if (!key || key.mode !== "suggest" || st.keyMode || !keyHere.length || !cluster) return null;
    const ids = new Set(cluster.pinIds);
    const h = suggest(key, ungraded.filter((p) => ids.has(p.id)), g);
    return h.correct.length || h.wrong.size ? h : null;
  }, [key, keyHere, st.keyMode, cluster, ungraded, g]);
  const acceptKey = () => {
    if (!keyHint || !task) return;
    st.gradeMany(
      [{ pinIds: keyHint.correct, status: "correct", text: "" }, ...[...keyHint.wrong].map(([text, pinIds]) => ({ pinIds, status: "wrong" as const, text }))],
      task.id,
      task.q,
    );
  };
  const flagged = useMemo(() => new Set(conflicts), [conflicts]);
  /** index (in the queue) of the pin being graded: first ungraded at or after the cursor */
  const pinAt = (from: number, dir: 1 | -1) => {
    if (!queueValid) return -1;
    const ids = queue!.cluster.pinIds;
    const n = ids.length;
    for (let i = 0; i < n; i++) {
      const j = (((from + dir * i) % n) + n) % n;
      if (states.get(ids[j]) === "ungraded") return j;
    }
    return -1;
  };
  const curIdx = queueValid ? pinAt(queue!.cursor, 1) : -1;
  const curPin = curIdx >= 0 ? queue!.cluster.pinIds[curIdx] : null;
  const queueLeft = queueValid ? queue!.cluster.pinIds.filter((id) => states.get(id) === "ungraded").length : 0;
  const stepPin = (dir: 1 | -1) => {
    if (curIdx < 0) return;
    const j = pinAt(curIdx + dir, dir);
    if (j >= 0) setQueue({ ...queue!, cursor: j });
  };

  const progress: Progress = useMemo(() => {
    const allDoubles = new Set<string>();
    for (const q of session.questions)
      if (q.include)
        doublePinIds(session.pins, q.num, g).forEach((id) =>
          allDoubles.add(id),
        );
    const done = (id: string) => !!g.pinGroup[id] || allDoubles.has(id);
    const pinsTotal = session.pins.length;
    const pinsDone = session.pins.filter((p) => done(p.id)).length;
    let tasksDone = 0;
    for (const t of tasks)
      if (pinsForTask(session.pins, t, g).every((p) => done(p.id))) tasksDone++;
    const taskDone = taskPins.filter(
      (p) => states.get(p.id) !== "ungraded",
    ).length;
    return {
      taskTotal: taskPins.length,
      taskDone,
      tasksDone,
      tasksTotal: tasks.length,
      pinsDone,
      pinsTotal,
    };
  }, [session.pins, session.questions, g, tasks, taskPins, states]);

  // ---------- slide loading ----------
  const [info, setInfo] = useState<SlideInfo | null>(null);
  const [slideErr, setSlideErr] = useState<string | null>(null);
  const infoCache = useRef(new Map<string, SlideInfo>());
  useEffect(() => {
    if (!task) return;
    const ref = session.slides.find((s) => s.id === task.slide);
    setSlideErr(null);
    if (!ref) return setSlideErr("slide file not found");
    const cached = infoCache.current.get(ref.path);
    if (cached) return setInfo(cached);
    setInfo(null);
    let alive = true;
    openSlide(ref.path)
      .then((i) => {
        infoCache.current.set(ref.path, i);
        if (alive) setInfo(i);
      })
      .catch((e) => alive && setSlideErr(String(e)));
    return () => {
      alive = false;
    };
  }, [task?.slide, session.slides]);

  // ---------- selection follows the current cluster ----------
  const clusterKey = cluster
    ? `${task?.id}:${cluster.pinIds.join(",")}`
    : `${task?.id}:none`;
  // area painted with pins hidden; cleared on a new cluster / image or after grading
  const [paint, setPaint] = useState<PaintOp[]>([]);
  useEffect(() => {
    setPaint([]);
    if (!pinModeOn) st.set({ selection: cluster ? cluster.pinIds : [] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterKey]);

  useEffect(() => setQueue(null), [pinModeOn]);
  // pin-by-pin: (re)start the queue from the current cluster when needed; select the current pin
  useEffect(() => {
    if (!pinModeOn || queueValid) return;
    setQueue(liveCluster && task ? { key: task.id, cluster: liveCluster, cursor: 0 } : null);
    if (liveCluster && settings.autoZoomCluster) setFocus({ pinIds: liveCluster.pinIds, nonce: Date.now() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinModeOn, queueValid, clusterKey]);
  useEffect(() => {
    if (pinModeOn) st.set({ selection: curPin ? [curPin] : [] });
    else if (cluster) st.set({ selection: cluster.pinIds });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curPin, pinModeOn]);

  // unhiding pins after painting: the ungraded pins in the painted area become the selection
  const paintedIds = useMemo(() => pinsInPaint(ungraded, paint), [ungraded, paint]);
  const prevVisible = useRef(st.flagsVisible);
  useEffect(() => {
    if (st.flagsVisible && !prevVisible.current && paint.length) st.set({ selection: paintedIds });
    prevVisible.current = st.flagsVisible;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.flagsVisible]);
  const paintActive = paint.length > 0;
  /** what "painted ✓ / rest ✗" would grade */
  const paintSplit = useMemo(() => {
    if (!paintActive) return null;
    const ok = st.flagsVisible ? st.selection : paintedIds;
    const okSet = new Set(ok);
    const rest = (cluster?.pinIds ?? []).filter((id) => states.get(id) === "ungraded" && !okSet.has(id));
    return { ok, rest };
  }, [paintActive, st.flagsVisible, st.selection, paintedIds, cluster, states]);
  const pinOnly = useMemo(
    () => (pinModeOn && curPin && !paintActive ? new Set([curPin]) : null),
    [pinModeOn, curPin, paintActive],
  );
  const pendingWrong = useMemo(() => (paintSplit ? new Set(paintSplit.rest) : undefined), [paintSplit]);
  /** painted pins ✓; the rest of the cluster ✗ once a reason is given (the reason box opens beside them) */
  const gradePainted = () => {
    if (!paintSplit || !task) return;
    if (!paintSplit.rest.length) {
      st.grade(paintSplit.ok, "correct", "", task.id, task.q);
      return setPaint([]);
    }
    const c = menuAnchor(paintSplit.rest);
    // the selection stays on the painted pins, so both groups stay visible while typing
    st.set({
      menu: {
        x: c.x,
        y: c.y,
        pinIds: paintSplit.rest,
        mode: "wrong",
        title: `Rest of cluster · ${paintSplit.ok.length} painted marked correct`,
        paintOk: paintSplit.ok,
      },
    });
  };

  // auto-zoom when navigating clusters / after grading / on new image
  const [focus, setFocus] = useState<{
    pinIds: string[];
    nonce: number;
  } | null>(null);
  useEffect(() => {
    if (pinModeOn) return; // the queue zooms once per cluster
    if (cluster && settings.autoZoomCluster) setFocus({ pinIds: cluster.pinIds, nonce: Date.now() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id, clusterIndex, ungraded.length, info?.id]);
  useEffect(() => {
    if (st.focusRequest) setFocus(st.focusRequest);
  }, [st.focusRequest]);
  const [homeNonce, setHomeNonce] = useState(0);
  const [view, setView] = useState<"slide" | "cluster">("cluster");
  useEffect(() => setView("cluster"), [focus?.nonce]);

  // wrong-answer reasons used on this question, most recent first, with pin counts
  const recentReasons = useMemo(() => {
    if (!task) return [] as { text: string; pins: number }[];
    const m = new Map<string, { text: string; pins: number; at: number }>();
    for (const gr of Object.values(g.groups)) {
      if (
        gr.status !== "wrong" ||
        !gr.text ||
        parseTaskId(gr.taskId).q !== task.q
      )
        continue;
      const e = m.get(gr.text) ?? { text: gr.text, pins: 0, at: 0 };
      e.pins += gr.pinIds.length;
      e.at = Math.max(e.at, gr.createdAt);
      m.set(gr.text, e);
    }
    return [...m.values()].sort((a, b) => b.at - a.at).slice(0, 6);
  }, [g.groups, task]);

  // ---------- actions ----------
  const selection = useMemo(() => new Set(st.selection), [st.selection]);

  const menuTitle = (ids: string[]) => {
    if (ids.length === 1) {
      const p = session.pins.find((x) => x.id === ids[0]);
      if (p)
        return `${studentName(p.studentId)} · "${p.rawTitle || "untitled"}"`;
    }
    if (
      cluster &&
      ids.length === cluster.pinIds.length &&
      ids.every((id) => cluster.pinIds.includes(id))
    )
      return cluster.single
        ? `Pin ${cluster.label}`
        : `Cluster ${cluster.label} · ${ids.length} pins`;
    return `${ids.length} pins selected`;
  };

  const openMenu = (
    ids: string[],
    x: number,
    y: number,
    mode: "root" | "correct" | "wrong" = "root",
  ) => {
    if (!ids.length) return;
    st.set({
      selection: ids,
      menu: { x, y, pinIds: ids, mode, title: menuTitle(ids) },
    });
  };

  const viewerApi = useRef<ViewerApi | null>(null);
  const [flash, setFlash] = useState<{
    kind: "correct" | "wrong";
    n: number;
  } | null>(null);
  const flashBtn = (kind: "correct" | "wrong") => {
    if (!st.selection.length) return;
    const n = Date.now();
    setFlash({ kind, n });
    setTimeout(() => setFlash((f) => (f?.n === n ? null : f)), 450);
  };
  /** where to open the grading menu: just beside the selected pins (flipped left if the inspector is in the way) */
  const menuAnchor = (ids: string[]) => {
    const b = viewerApi.current?.clientBounds(ids);
    if (!b) return viewerCenter();
    const MENU_W = 280;
    const limit = window.innerWidth - PANEL_W - 2 * GAP;
    let x = b.right + 14;
    if (x + MENU_W > limit) x = Math.max(GAP, b.left - 14 - MENU_W);
    return { x, y: Math.max(TOPBAR_H + GAP, b.top - 6) };
  };
  const viewerCenter = () => {
    const el = document.querySelector(".viewer-wrap")?.getBoundingClientRect();
    return el
      ? { x: el.left + el.width / 2 + 20, y: el.top + el.height / 2 + 20 }
      : { x: 300, y: 300 };
  };

  const gradeSelection = (status: "correct" | "wrong", text: string) => {
    if (!task || !st.menu) return;
    if (st.menu.paintOk) {
      st.gradeMany(
        [
          { pinIds: st.menu.paintOk, status: "correct", text: "" },
          { pinIds: st.menu.pinIds, status, text },
        ],
        task.id,
        task.q,
      );
      return setPaint([]);
    }
    st.grade(st.menu.pinIds, status, text, task.id, task.q);
  };

  // clusters are sorted largest-first, single pins come after the real clusters
  const onSingles = !!cluster?.single;
  /** Correct grades straight away (⇧ = add a note); Wrong asks for a reason */
  const gradeSelectionFromButton = (
    m: "correct" | "wrong",
    withNote = false,
  ) => {
    if (m === "correct" && !withNote && paintSplit && (paintSplit.ok.length || paintSplit.rest.length))
      return gradePainted();
    if (!st.selection.length) return;
    if (m === "correct" && !withNote)
      return st.grade(st.selection, "correct", "", task.id, task.q);
    const c = menuAnchor(st.selection);
    openMenu(st.selection, c.x, c.y, m);
  };
  const jumpKind = (kind: "clusters" | "singles") => {
    const i = clusters.findIndex((c) =>
      kind === "singles" ? c.single : !c.single,
    );
    if (i >= 0) (setQueue(null), st.set({ clusterIndex: i }));
  };
  const nextCluster = () =>
    clusters.length &&
    (setQueue(null),
    st.set({ clusterIndex: (clusterIndex + 1) % clusters.length }));
  const prevCluster = () =>
    clusters.length &&
    (setQueue(null),
    st.set({
      clusterIndex: (clusterIndex - 1 + clusters.length) % clusters.length,
    }));
  const nextImage = () =>
    taskIndex < tasks.length - 1 && st.setTask(taskIndex + 1);
  const prevImage = () => taskIndex > 0 && st.setTask(taskIndex - 1);

  const invertSelection = () => {
    const cur = new Set(st.menu?.pinIds ?? st.selection);
    const inv = ungraded.filter((p) => !cur.has(p.id)).map((p) => p.id);
    if (st.menu)
      st.set({
        selection: inv,
        menu: { ...st.menu, pinIds: inv, title: menuTitle(inv) },
      });
    else st.set({ selection: inv });
  };

  // ---------- floating-panel layout ----------
  // The slide fills the window; the top bar, right panel, toolbar and ledger float over it.
  // `insets` tells the viewer which part is uncovered so zoom/centring land there.
  const [winH, setWinH] = useState(window.innerHeight);
  useEffect(() => {
    const r = () => setWinH(window.innerHeight);
    window.addEventListener("resize", r);
    return () => window.removeEventListener("resize", r);
  }, []);
  const ledgerH = Math.round(Math.min(320, Math.max(170, winH * 0.27)));
  const insets = useMemo(
    () => ({
      top: TOPBAR_H,
      right: PANEL_W + 2 * GAP,
      bottom: ledgerH + TOOL_H + 3 * GAP,
      left: 0,
    }),
    [ledgerH],
  );

  // ---------- keyboard ----------
  const handlerRef = useRef<(e: KeyboardEvent) => void>(() => {});
  handlerRef.current = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (
      t &&
      (t.tagName === "INPUT" ||
        t.tagName === "TEXTAREA" ||
        t.tagName === "SELECT")
    )
      return;
    if (st.menu || st.settingsOpen || st.exportOpen || st.handoffOpen || st.conflictsOpen || st.changesOpen || st.keyApplyOpen || st.examEditOpen || showScanProblems) return;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const k = e.key;
    if (mod && k.toLowerCase() === "z") {
      e.preventDefault();
      return e.shiftKey ? st.redo() : st.undo();
    }
    if (mod && k.toLowerCase() === "y") return st.redo();
    if (mod && k === "ArrowRight") return nextImage();
    if (mod && k === "ArrowLeft") return prevImage();
    if (mod && k === ",") return st.set({ settingsOpen: true });
    if (mod || e.altKey) return;
    if (
      k === settings.toggleFlagsKey ||
      (settings.toggleFlagsKey === " " && e.code === "Space")
    ) {
      e.preventDefault();
      return st.set({ flagsVisible: !st.flagsVisible });
    }
    if (k.toLowerCase() === settings.minimapKey.toLowerCase())
      return st.set({ minimapVisible: !st.minimapVisible });
    if (k === "]" || k === "n") return nextCluster();
    if (k === "[" || k === "p") return prevCluster();
    if (k === "f" && cluster)
      return setFocus({
        pinIds: st.selection.length ? st.selection : cluster.pinIds,
        nonce: Date.now(),
      });
    if (k === "h") return (setView("slide"), setHomeNonce(Date.now()));
    if (k === "i") return st.set({ isolate: !st.isolate });
    if (k === "b") {
      const on = SELECT_TOOLS.filter((t) => settings.tools[t]);
      const i = on.indexOf(activeTool(settings));
      return on.length > 1 && setSettings({ selectTool: on[(i + 1) % on.length] });
    }
    if (k === "o" && settings.pinByPin)
      return (setQueue(null), st.set({ pinMode: !st.pinMode }));
    if (pinModeOn && k === "ArrowRight") return (e.preventDefault(), stepPin(1));
    if (pinModeOn && k === "ArrowLeft") return (e.preventDefault(), stepPin(-1));
    if (k === "-" || k === "_")
      return setSettings({ brushPx: Math.max(BRUSH_MIN, settings.brushPx - 4) });
    if (k === "=" || k === "+")
      return setSettings({ brushPx: Math.min(BRUSH_MAX, settings.brushPx + 4) });
    if (k === "x") return invertSelection();
    if (k === "s") return jumpKind(onSingles ? "clusters" : "singles");
    if (k === "/" && !guestPack) return (e.preventDefault(), st.set({ studentView: { id: "" } }));
    if (k === "?") return setSettings({ showKeyHints: !settings.showKeyHints });
    if (k === "r") return setRuler((on) => !on);
    if (ruler && (k === "Backspace" || k === "Delete") && measures.length) return (e.preventDefault(), setMeasures((m) => m.slice(0, -1)));
    if (ruler && k === "Escape") return measures.length ? setMeasures([]) : setRuler(false);
    if (k === "Escape") return (setPaint([]), st.set({ isolate: false }));
    // editing the key: the side panel handles C / W; nothing here grades
    if (st.keyMode) return;
    if (k === "k" && keyHint) return acceptKey();
    const c = menuAnchor(st.selection);
    if (k === "Enter") return openMenu(st.selection, c.x, c.y);
    if (k === "c" && paintSplit && (paintSplit.ok.length || paintSplit.rest.length) && task) {
      e.preventDefault(); // the reason box takes focus: keep the "c" out of it
      flashBtn("correct");
      return gradePainted();
    }
    if (k === "c" && st.selection.length && task) {
      flashBtn("correct");
      return st.grade(st.selection, "correct", "", task.id, task.q);
    }
    if (k === "C")
      return (flashBtn("correct"), openMenu(st.selection, c.x, c.y, "correct"));
    if (k === "w" && pinModeOn && curPin && !settings.wrongNeedsReason && task) {
      flashBtn("wrong");
      return st.grade([curPin], "wrong", settings.wrongDefaultText, task.id, task.q);
    }
    if (k.toLowerCase() === "w") {
      e.preventDefault();
      flashBtn("wrong");
      return openMenu(st.selection, c.x, c.y, "wrong");
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => handlerRef.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  if (!task)
    return (
      <div className="empty-state">
        <h2>No gradeable images</h2>
        <p>
          None of the included questions has a slide file in the slides folder.
        </p>
        <button onClick={() => st.close()}>Back</button>
      </div>
    );

  const gp = guestProgress(session);
  const allDone = guestPack ? gp.done === gp.total : progress.pinsDone === progress.pinsTotal;
  const sendResults = async () => {
    const path = await save({
      defaultPath: joinPath(dirname(session.sessionPath), `${safeFileName(`${guestPack!.host} - ${guestPack!.guest} results`)}.msgresult`),
      filters: [{ name: "Hand-off results", extensions: ["msgresult"] }],
    });
    if (!path) return;
    try {
      await writeText(withExt(path, "msgresult"), JSON.stringify(makeResult(session)));
      alert(`Results saved (${gp.done} of ${gp.total} pins graded). Send the file to ${guestPack!.host}'s grader.`);
    } catch (e) {
      alert(`Could not save results: ${e}`);
    }
  };
  const menuPinsGraded = st.menu?.pinIds.some((id) => g.pinGroup[id]) ?? false;
  const realClusters = clusters.filter((c) => !c.single).length;

  return (
    <div
      className={`grader ${macOverlay ? "mac-overlay" : ""}`}
      style={{ ["--ledger-h" as string]: `${ledgerH}px` }}
    >
      <header className="topbar" data-tauri-drag-region data-help="grading/the-grading-screen">
        <span className="session" title={session.sessionPath}>
          {session.name}
        </span>
        <span className="crumb-sep">/</span>
        <label className="selector">
          <select
            value={taskIndex}
            onChange={(e) => st.setTask(Number(e.target.value))}
          >
            {tasks.map((t, i) => (
              <option key={t.id} value={i}>
                {taskLabel(t)}
                {away.has(t.id) ? ` → ${away.get(t.id)}` : ""}
              </option>
            ))}
          </select>
          <span className="sub">
            image {taskIndex + 1} of {tasks.length}
          </span>
        </label>
        <div className="grow" />
        <button
          className="btn ghost icon"
          onClick={st.undo}
          disabled={!st.past.length}
          title="Undo (⌘Z / Ctrl+Z)"
          data-help="ledger/undo-and-redo"
        >
          <IconUndo />
        </button>
        <button
          className="btn ghost icon"
          onClick={st.redo}
          disabled={!st.future.length}
          title="Redo (⇧⌘Z / Ctrl+Y)"
          data-help="ledger/undo-and-redo"
        >
          <IconRedo />
        </button>
        <span
          className={`saved ${st.saveError ? "err" : ""}`}
          title={st.saveError ? `Save failed: ${st.saveError}` : `Saves automatically to ${session.sessionPath}`}
          data-help={st.saveError ? "troubleshooting/while-grading" : "getting-started/saving-and-backups"}
        >
          {st.saveError ? (
            "Save failed"
          ) : st.dirty ? (
            "Saving…"
          ) : (
            <>
              <IconCheck /> Saved
            </>
          )}
        </span>
        <span className="vsep" />
        {!guestPack && (
          <button
            className={`btn ghost ${st.studentView ? "on" : ""}`}
            onClick={() => st.set({ studentView: st.studentView ? null : { id: "" } })}
            title="Look up a student: all their pins and grades ( / )"
            data-help="students"
          >
            <IconPerson /> Find student
          </button>
        )}
        {guestPack ? (
          <button className={`btn ${allDone ? "light" : ""}`} onClick={sendResults} title={`Save the results file to send back (${guestPack.host})`} data-help="handoff/guest-grade-the-pack">
            <IconExport /> Send results · {gp.done}/{gp.total}
          </button>
        ) : (
          <>
            {conflicts.length > 0 && (
              <button
                className="btn conflicts-btn"
                onClick={() => st.set({ conflictsOpen: true })}
                title="Pins two graders marked differently: choose whose grade to keep"
                data-help="handoff/settle-disagreements"
              >
                Disagreements <b>{conflicts.length}</b>
              </button>
            )}
            {changes.length > 0 && (
              <button
                className="btn changes-btn"
                onClick={() => st.set({ changesOpen: true })}
                title="Pins that changed or left the files since you graded them: carry the grade over, grade them yourself, or restore them"
                data-help="getting-started/review-changed-submissions"
              >
                Changed submissions <b>{changes.length}</b>
              </button>
            )}
            <button
              className={`btn ${st.keyMode ? "light" : "ghost"}`}
              onClick={() => st.set(st.keyMode ? { keyMode: false, keyApplyOpen: !!key?.marks.length } : { keyMode: true, menu: null, selection: [] })}
              title="Mark where the right and common wrong answers are; matching pins are graded for you"
              data-help="answer-key"
            >
              <IconKey /> Answer key{key?.marks.length ? ` · ${key.marks.length}` : ""}
            </button>
            <button className="btn ghost" onClick={() => st.set({ handoffOpen: true })} title="Share the remaining work with other graders" data-help="handoff">
              <IconHandoff /> Hand off
            </button>
            <button
              className={`btn ${allDone ? "light" : ""}`}
              onClick={() => st.set({ exportOpen: true })}
              title="Export grades.csv, feedback files and item statistics (⌘E)"
              data-help="export"
            >
              <IconExport /> Export
            </button>
          </>
        )}
        <button className="btn ghost icon help-q" onClick={() => void showHelp("index")} title="Micro Speed Grader Help (⌘?)" aria-label="Help">
          ?
        </button>
        <button
          className="btn ghost icon"
          onClick={() => st.set({ settingsOpen: true })}
          title="Preferences (⌘,)"
          data-help="preferences"
        >
          <IconSliders />
        </button>
        <button
          className="btn ghost icon"
          onClick={async () => {
            await st.saveNow();
            st.close();
          }}
          title="Save and close session"
          data-help="getting-started/saving-and-backups"
        >
          <IconClose />
        </button>
      </header>

      <main className="workspace">
        <section className="left">
          <div className="viewer-pane">
            <SlideViewer
              apiRef={viewerApi}
              info={info}
              slideLabel={task.slide}
              insets={insets}
              error={slideErr}
              pins={taskPins}
              otherPins={otherPins}
              states={states}
              flagged={flagged}
              changed={changedPins}
              selection={selection}
              cluster={cluster}
              isolate={st.isolate}
              flagsVisible={st.flagsVisible}
              minimapVisible={st.minimapVisible}
              settings={settings}
              studentName={studentName}
              focus={focus}
              homeNonce={homeNonce}
              onLasso={(ids, x, y) => {
                setPaint([]);
                if (!ids.length) return st.set({ selection: [] });
                // beside the selected pins (so they stay visible), else where the drag ended
                const a = viewerApi.current?.clientBounds(ids) ? menuAnchor(ids) : { x, y };
                openMenu(ids, a.x, a.y);
              }}
              onlyPinIds={pinOnly}
              paint={paint}
              onPaint={(op) => setPaint((ops) => [...ops, op])}
              paintAlways={st.keyMode}
              ruler={ruler}
              measures={measures}
              onMeasure={(m) => setMeasures((ms) => [...ms, m])}
              layers={keyLayers}
              pendingWrong={pendingWrong}
              onSelect={(ids) => st.set({ selection: ids })}
              onPinClick={(id, x, y) => openMenu([id], x, y)}
              onEmptyRightClick={(x, y) =>
                st.selection.length && openMenu(st.selection, x, y)
              }
              onClusterAdjust={(cx, cy, radiusNm, pinIds) =>
                baseCluster &&
                setAdjusted({
                  key: baseKey,
                  cluster: {
                    ...baseCluster,
                    cx,
                    cy,
                    radiusNm,
                    pinIds,
                    single: false,
                  },
                })
              }
            />
            {(paintActive || (!st.flagsVisible && settings.hiddenPaint)) && (
              <div className="paint-hint">
                {!st.flagsVisible ? (
                  <>
                    Pins hidden · paint the structure
                    {paintActive ? "" : " (brush, lasso or polygon)"}, then{" "}
                    <span className="kbd">{keyLabel(settings.toggleFlagsKey)}</span> to show pins
                  </>
                ) : (
                  <>
                    <b>{paintSplit?.ok.length ?? 0}</b> painted ·{" "}
                    <b className="bad">{paintSplit?.rest.length ?? 0}</b> rest of cluster →{" "}
                    <span className="kbd">C</span> painted ✓, rest ✗ + reason ·{" "}
                    <span className="kbd">Esc</span> clear
                  </>
                )}
              </div>
            )}
            {settings.showKeyHints && (
              <KeySheet
                tool={activeTool(settings)}
                pinByPin={settings.pinByPin}
                swap={settings.swapMouse}
                onClose={() => setSettings({ showKeyHints: false })}
              />
            )}
            {st.notice && (
              <div className={`notice-banner ${st.notice.kind}`} role="status" data-help={
                  st.notice.kind === "conflict"
                    ? "handoff/settle-disagreements"
                    : st.notice.kind === "info"
                      ? "getting-started/new-and-changed-submissions"
                      : "handoff/replacing-another-graders-grade"
                }>
                <span>{st.notice.text}</span>
                {st.notice.kind === "conflict" ? (
                  <button className="btn ghost small" onClick={() => st.set({ conflictsOpen: true, notice: null })}>
                    Show
                  </button>
                ) : st.notice.review || st.notice.problems ? (
                  <>
                    {st.notice.review && (
                      <button className="btn ghost small" onClick={() => st.set({ changesOpen: true, notice: null })}>
                        Review
                      </button>
                    )}
                    {!!st.notice.problems && (
                      <button
                        className="btn ghost small"
                        onClick={() => {
                          setShowScanProblems(true);
                          st.set({ notice: null });
                        }}
                      >
                        ⚠ {thingsToCheck(st.notice.problems)}
                      </button>
                    )}
                  </>
                ) : st.notice.kind === "override" ? (
                  <>
                    {st.notice.undo && (
                      <button
                        className="btn ghost small"
                        onClick={() => {
                          st.undo();
                          st.set({ notice: null });
                        }}
                      >
                        Undo
                      </button>
                    )}
                    <button className="btn ghost small" onClick={() => st.set({ overrideQuiet: true, notice: null })}>
                      Don't warn again
                    </button>
                  </>
                ) : null}
                <button className="notice-x" onClick={() => st.set({ notice: null })} aria-label="Dismiss" title="Dismiss">
                  ×
                </button>
              </div>
            )}
            {keyHint && (
              <div className="key-hint" data-help="answer-key/grade-or-suggest">
                <span className="key-hint-l">Answer key</span>
                {keyHint.correct.length > 0 && <span className="ok-text">✓ {keyHint.correct.length}</span>}
                {[...keyHint.wrong].map(([t, ids]) => (
                  <span key={t} className="warn-text">
                    ✗ {t} {ids.length}
                  </span>
                ))}
                {keyHint.none > 0 && <span className="muted">{keyHint.none} not in the key</span>}
                <button className="btn small" onClick={acceptKey} title="Grade these pins as the key says (K)">
                  Use key <span className="kbd">K</span>
                </button>
              </div>
            )}
            {st.keyMode && (
              <div className="key-banner">
                Editing the answer key: paint where an answer is, then save it in the panel on the right.
              </div>
            )}
            {lockedHere > 0 && (
              <div className="handoff-banner">
                {lockedHere} pin{lockedHere > 1 ? "s" : ""} on this image {lockedHere > 1 ? "are" : "is"} with{" "}
                <b>{away.get(task.id) ?? "another grader"}</b>
                <button className="btn ghost small" onClick={() => st.set({ handoffOpen: true })}>
                  Manage
                </button>
              </div>
            )}
            {allDone && (
              <div className="done-banner">
                {guestPack ? "All your pins are graded." : "All pins graded."}
                <button
                  className="btn light"
                  onClick={() => (guestPack ? sendResults() : st.set({ exportOpen: true }))}
                >
                  {guestPack ? "Send results" : "Export grades"}
                </button>
              </div>
            )}
          </div>
          <div className="vtool" data-help="grading/grade-a-cluster">
            <div className="vside">
              <div className="cnav" data-help="clusters/moving-around">
                <button
                  className="step"
                  onClick={prevCluster}
                  disabled={!clusters.length}
                  title="Previous cluster ( [ )"
                >
                  <IconChevL />
                </button>
                <div className="cur">
                  {pinModeOn && curPin && cluster ? (
                    <>
                      <span>
                        Pin {curIdx + 1} of {cluster.pinIds.length} ·{" "}
                        {cluster.single ? "single" : `cluster ${cluster.label}`}
                      </span>
                      <span className="of">
                        {queueLeft} left · <span className="kbd">←</span>
                        <span className="kbd">→</span>
                      </span>
                    </>
                  ) : cluster ? (
                    <>
                      <span>
                        {cluster.single && cluster.pinIds.length === 1
                          ? "Single pin"
                          : `Cluster ${cluster.label}`}{" "}
                        · {cluster.pinIds.length} pin
                        {cluster.pinIds.length === 1 ? "" : "s"}
                      </span>
                      <span className="of">
                        {clusterIndex + 1} of {clusters.length}
                      </span>
                    </>
                  ) : (
                    <span className="of">Nothing left on this image</span>
                  )}
                </div>
                <button
                  className="step"
                  onClick={nextCluster}
                  disabled={!clusters.length}
                  title="Next cluster ( ] )"
                >
                  <IconChevR />
                </button>
              </div>
            </div>
            <div className="vgrade grade">
              <span className="selcount">
                <b>{st.selection.length}</b>{" "}
                <span className="lbl">selected</span>
              </span>
              <button
                key={flash?.kind === "correct" ? `c${flash.n}` : "c"}
                className={`btn ok ${flash?.kind === "correct" ? "flash" : ""}`}
                disabled={!st.selection.length}
                title="Mark all selected pins correct · ⇧-click to add a note"
                onClick={(e) => gradeSelectionFromButton("correct", e.shiftKey)}
              >
                <span className="l">
                  <IconCheck /> Correct
                </span>
                <span className="kbd">C</span>
              </button>
              <button
                key={flash?.kind === "wrong" ? `w${flash.n}` : "w"}
                className={`btn bad ${flash?.kind === "wrong" ? "flash" : ""}`}
                disabled={!st.selection.length}
                title="Mark all selected pins wrong and give a reason"
                onClick={() => gradeSelectionFromButton("wrong")}
              >
                <span className="l">
                  <IconCross /> Wrong…
                </span>
                <span className="kbd">W</span>
              </button>
            </div>
            <div className="vside end">
              <div className="seg">
                <button
                  className={view === "slide" ? "on" : ""}
                  onClick={() => (setView("slide"), setHomeNonce(Date.now()))}
                >
                  Whole slide <span className="kbd">H</span>
                </button>
                <button
                  className={view === "cluster" ? "on" : ""}
                  onClick={() =>
                    cluster &&
                    (setView("cluster"),
                    setFocus({
                      pinIds: st.selection.length
                        ? st.selection
                        : cluster.pinIds,
                      nonce: Date.now(),
                    }))
                  }
                >
                  Cluster <span className="kbd">F</span>
                </button>
              </div>
              <div className={`ruler-box${ruler ? " on" : ""}`} data-help="clusters/measure-distances-and-areas">
                <button
                  className={`ruler-btn${ruler ? " on" : ""}`}
                  onClick={() => setRuler((on) => !on)}
                  title="Ruler: drag to measure a distance, click corners to measure an area (R)"
                >
                  <IconRuler /> <span className="lbl">Ruler</span> <span className="kbd">R</span>
                </button>
                {ruler && measures.length > 0 && (
                  <>
                    <span className="ruler-n">{measures.length}</span>
                    <button className="ruler-clear" onClick={() => setMeasures([])} title="Clear the measurements (Esc)">
                      Clear
                    </button>
                  </>
                )}
              </div>
              <button
                className={`keys-toggle ${settings.showKeyHints ? "on" : ""}`}
                onClick={() =>
                  setSettings({ showKeyHints: !settings.showKeyHints })
                }
                title="Keyboard shortcuts (?)"
              >
                <span className="kbd">?</span>{" "}
                <span className="lbl">Shortcuts</span> <IconChevUp />
              </button>
            </div>
          </div>
          <Ledger
            session={session}
            task={task}
            tasks={tasks}
            settings={settings}
            studentName={studentName}
          />
        </section>
        {st.keyMode ? (
          <KeyPanel
            session={session}
            task={task}
            tasks={tasks}
            question={question}
            paint={paint}
            clearPaint={() => setPaint([])}
            onGoTask={(i) => st.setTask(i)}
          />
        ) : (
          <RightPanel
            task={task}
            question={question}
            clusters={clusters}
            selectionCount={st.selection.length}
            progress={progress}
            reasons={recentReasons}
            onPickReason={(text) => {
              if (!st.selection.length) return;
              st.grade(st.selection, "wrong", text, task.id, task.q);
            }}
            realClusters={realClusters}
            onSingles={onSingles}
            onJumpKind={jumpKind}
            onNextImage={nextImage}
            onPrevImage={prevImage}
            hasPrev={taskIndex > 0}
            hasNext={taskIndex < tasks.length - 1}
          />
        )}
        {st.studentView && !guestPack && <StudentPanel session={session} tasks={tasks} settings={settings} />}
      </main>

      {st.menu && (
        <ContextMenu
          menu={st.menu}
          grades={g}
          q={task.q}
          settings={settings}
          anyGraded={menuPinsGraded}
          onGrade={gradeSelection}
          onInvert={invertSelection}
          onIsolate={() =>
            st.set({ isolate: true, selection: st.menu!.pinIds, menu: null })
          }
          onUngrade={() => {
            st.ungrade(st.menu!.pinIds);
            st.set({ menu: null });
          }}
          onMode={(mode) => st.set({ menu: { ...st.menu!, mode } })}
          onClose={() => st.set({ menu: null })}
          paintRest={paintSplit?.rest.length ?? 0}
          onPaintGrade={gradePainted}
        />
      )}
      {showScanProblems && scanProblems && (
        <ScanProblemsDialog
          problems={scanProblems}
          resolve={scanResolve}
          onClose={() => setShowScanProblems(false)}
          onRecheck={() => st.set({ rescanAsk: Date.now() })}
        />
      )}
      {st.examEditOpen && !guestPack && (
        <ExamEditor questions={session.questions} slides={session.slides} examName={session.name} session={session} onClose={() => st.set({ examEditOpen: false })} />
      )}
      {st.keyApplyOpen && <KeyApplyDialog session={session} onClose={() => st.set({ keyApplyOpen: false })} />}
      {st.changesOpen && <ChangesDialog session={session} tasks={tasks} onClose={() => st.set({ changesOpen: false })} />}
      {st.conflictsOpen && <ConflictsDialog session={session} tasks={tasks} onClose={() => st.set({ conflictsOpen: false })} />}
      {st.handoffOpen && (
        <HandoffDialog session={session} tasks={tasks} onClose={() => st.set({ handoffOpen: false })} />
      )}
      {st.exportOpen && (
        <ExportDialog
          session={session}
          onClose={() => st.set({ exportOpen: false })}
        />
      )}
    </div>
  );
}
