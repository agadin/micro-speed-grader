import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { useSettings } from "../lib/settings";
import {
  buildTasks,
  doublePinIds,
  pinState,
  pinsForTask,
  type PinState,
} from "../lib/grading";
import { computeClusters, type Cluster } from "../lib/cluster";
import { openSlide } from "../lib/backend";
import type { Session, SlideInfo } from "../lib/types";
import { SlideViewer, type ViewerApi } from "./SlideViewer";
import { ContextMenu } from "./ContextMenu";
import { Ledger } from "./Ledger";
import { RightPanel, type Progress } from "./RightPanel";
import { ExportDialog } from "./ExportDialog";
import {
  IconCheck,
  IconChevL,
  IconChevR,
  IconChevUp,
  IconClose,
  IconCross,
  IconExport,
  IconRedo,
  IconSliders,
  IconUndo,
} from "./icons";

const isMac = navigator.userAgent.includes("Mac");
/** macOS window with an overlay title bar: leave room for the traffic lights */
const macOverlay = isMac && "__TAURI_INTERNALS__" in window;
const TOPBAR_H = 48;
const PANEL_W = 320;
const GAP = 10;
const TOOL_H = 40;

type KeyRow = [string[], string];
function KeySheet({ brush, swap, onClose }: { brush: boolean; swap: boolean; onClose: () => void }) {
  const drag = swap ? "L-drag" : "R-drag";
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
      ],
    ],
    [
      "Select",
      brush
        ? [
            [[drag], "paint"],
            [["⇧", "paint"], "add"],
            [["⌥", "paint"], "remove"],
            [["−", "="], "brush size"],
            [["B"], "lasso tool"],
          ]
        : [
            [[drag], "lasso"],
            [["⌘", "drag"], "add to selection"],
            [["⌘", "click"], "add / remove pin"],
            [["⇧", "drag"], "inverse"],
            [["⌥", "drag"], "rectangle"],
            [["X"], "invert selection"],
            [["B"], "brush tool"],
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
  const tasks = useMemo(
    () => buildTasks(session.questions, slideIds),
    [session.questions, slideIds],
  );
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
    () => (task ? pinsForTask(session.pins, task, g) : []),
    [session.pins, task, g],
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
  const cluster =
    adjusted && adjusted.key === baseKey ? adjusted.cluster : baseCluster;

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
  useEffect(() => {
    st.set({ selection: cluster ? cluster.pinIds : [] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterKey]);

  // auto-zoom when navigating clusters / after grading / on new image
  const [focus, setFocus] = useState<{
    pinIds: string[];
    nonce: number;
  } | null>(null);
  useEffect(() => {
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
        Number(gr.taskId.split("|")[0].slice(1)) !== task.q
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
    st.grade(st.menu.pinIds, status, text, task.id, task.q);
  };

  // clusters are sorted largest-first, single pins come after the real clusters
  const onSingles = !!cluster?.single;
  /** Correct grades straight away (⇧ = add a note); Wrong asks for a reason */
  const gradeSelectionFromButton = (
    m: "correct" | "wrong",
    withNote = false,
  ) => {
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
    if (i >= 0) st.set({ clusterIndex: i });
  };
  const nextCluster = () =>
    clusters.length &&
    st.set({ clusterIndex: (clusterIndex + 1) % clusters.length });
  const prevCluster = () =>
    clusters.length &&
    st.set({
      clusterIndex: (clusterIndex - 1 + clusters.length) % clusters.length,
    });
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
    if (st.menu || st.settingsOpen || st.exportOpen) return;
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
    if (k === "b")
      return setSettings({
        selectTool: settings.selectTool === "brush" ? "lasso" : "brush",
      });
    if (k === "-" || k === "_")
      return setSettings({ brushPx: Math.max(6, settings.brushPx - 4) });
    if (k === "=" || k === "+")
      return setSettings({ brushPx: Math.min(200, settings.brushPx + 4) });
    if (k === "x") return invertSelection();
    if (k === "s") return jumpKind(onSingles ? "clusters" : "singles");
    if (k === "?") return setSettings({ showKeyHints: !settings.showKeyHints });
    if (k === "Escape") return st.set({ isolate: false });
    const c = menuAnchor(st.selection);
    if (k === "Enter") return openMenu(st.selection, c.x, c.y);
    if (k === "c" && st.selection.length && task) {
      flashBtn("correct");
      return st.grade(st.selection, "correct", "", task.id, task.q);
    }
    if (k === "C")
      return (flashBtn("correct"), openMenu(st.selection, c.x, c.y, "correct"));
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

  const allDone = progress.pinsDone === progress.pinsTotal;
  const menuPinsGraded = st.menu?.pinIds.some((id) => g.pinGroup[id]) ?? false;
  const realClusters = clusters.filter((c) => !c.single).length;

  return (
    <div
      className={`grader ${macOverlay ? "mac-overlay" : ""}`}
      style={{ ["--ledger-h" as string]: `${ledgerH}px` }}
    >
      <header className="topbar" data-tauri-drag-region>
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
                Q{t.q} · {t.slide}
                {t.slideCount > 1
                  ? ` (${t.slideIndex + 1}/${t.slideCount})`
                  : ""}
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
        >
          <IconUndo />
        </button>
        <button
          className="btn ghost icon"
          onClick={st.redo}
          disabled={!st.future.length}
          title="Redo (⇧⌘Z / Ctrl+Y)"
        >
          <IconRedo />
        </button>
        <span
          className={`saved ${st.saveError ? "err" : ""}`}
          title={st.saveError ?? session.sessionPath}
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
        <button
          className={`btn ${allDone ? "light" : ""}`}
          onClick={() => st.set({ exportOpen: true })}
        >
          <IconExport /> Export
        </button>
        <button
          className="btn ghost icon"
          onClick={() => st.set({ settingsOpen: true })}
          title="Preferences (⌘,)"
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
              selection={selection}
              cluster={cluster}
              isolate={st.isolate}
              flagsVisible={st.flagsVisible}
              minimapVisible={st.minimapVisible}
              settings={settings}
              studentName={studentName}
              focus={focus}
              homeNonce={homeNonce}
              onLasso={(ids, _inv, x, y) =>
                ids.length ? openMenu(ids, x, y) : st.set({ selection: [] })
              }
              onSelect={(ids) => st.set({ selection: ids })}
              onPinClick={(id, x, y) => openMenu([id], x, y)}
              onEmptyRightClick={(x, y) =>
                st.selection.length && openMenu(st.selection, x, y)
              }
              onEmptyClick={() => {}}
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
            {settings.showKeyHints && (
              <KeySheet
                brush={settings.selectTool === "brush"}
                swap={settings.swapMouse}
                onClose={() => setSettings({ showKeyHints: false })}
              />
            )}
            {allDone && (
              <div className="done-banner">
                All pins graded.
                <button
                  className="btn light"
                  onClick={() => st.set({ exportOpen: true })}
                >
                  Export grades
                </button>
              </div>
            )}
          </div>
          <div className="vtool">
            <div className="vside">
              <div className="cnav">
                <button
                  className="step"
                  onClick={prevCluster}
                  disabled={!clusters.length}
                  title="Previous cluster ( [ )"
                >
                  <IconChevL />
                </button>
                <div className="cur">
                  {cluster ? (
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
            doubles={doubles}
            settings={settings}
            studentName={studentName}
          />
        </section>
        <RightPanel
          task={task}
          question={question}
          clusters={clusters}
          clusterIndex={clusterIndex}
          current={cluster}
          selectionCount={st.selection.length}
          progress={progress}
          reasons={recentReasons}
          onPickReason={(text) => {
            if (!st.selection.length) return;
            st.grade(st.selection, "wrong", text, task.id, task.q);
          }}
          onPrevCluster={prevCluster}
          onNextCluster={nextCluster}
          realClusters={realClusters}
          onSingles={onSingles}
          onJumpKind={jumpKind}
          onNextImage={nextImage}
          onPrevImage={prevImage}
          hasPrev={taskIndex > 0}
          hasNext={taskIndex < tasks.length - 1}
        />
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
        />
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
