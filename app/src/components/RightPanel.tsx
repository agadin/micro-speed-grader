import type { ReactNode } from "react";
import type { Cluster } from "../lib/cluster";
import type { Question, Task } from "../lib/types";
import { keyLabel, useSettings } from "../lib/settings";
import { useStore } from "../lib/store";
import { IconBrush, IconCheck, IconChevL, IconChevR, IconCross, IconLasso, IconTri } from "./icons";

export interface Progress {
  taskTotal: number;
  taskDone: number;
  tasksDone: number;
  tasksTotal: number;
  pinsDone: number;
  pinsTotal: number;
}

interface Props {
  task: Task;
  question: Question | undefined;
  clusters: Cluster[];
  clusterIndex: number;
  /** the current cluster as shown (may have been dragged/resized) */
  current: Cluster | null;
  selectionCount: number;
  progress: Progress;
  reasons: { text: string; pins: number }[];
  onPickReason: (text: string) => void;
  onPrevCluster: () => void;
  onNextCluster: () => void;
  /** correct: grade straight away (⇧ = add a note); wrong: ask for a reason */
  onGradeSelection: (mode: "correct" | "wrong", withNote?: boolean) => void;
  onNextImage: () => void;
  onPrevImage: () => void;
  hasPrev: boolean;
  hasNext: boolean;
  /** briefly highlight the Correct / Wrong button when its key is pressed */
  flash: { kind: "correct" | "wrong"; n: number } | null;
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 100);

/** collapsible side panel with a disclosure-triangle header */
function Panel({ id, title, meta, children, fixed }: { id: string; title: string; meta?: ReactNode; children: ReactNode; fixed?: boolean }) {
  const { s, set } = useSettings();
  const closed = !fixed && s.collapsedPanels.includes(id);
  if (fixed)
    return (
      <section className="panel">
        <div className="phead">
          {title}
          <span className="sp" />
          {meta && <span className="meta">{meta}</span>}
        </div>
        <div className="pbody">{children}</div>
      </section>
    );
  return (
    <section className="panel">
      <button
        className="phead"
        onClick={() =>
          set({ collapsedPanels: closed ? s.collapsedPanels.filter((x) => x !== id) : [...s.collapsedPanels, id] })
        }
      >
        <span className="tri">
          <IconTri open={!closed} />
        </span>
        {title}
        <span className="sp" />
        {meta && <span className="meta">{meta}</span>}
      </button>
      {!closed && <div className="pbody">{children}</div>}
    </section>
  );
}

/** slim slider + numeric field with unit */
export function SliderRow(p: { label: string; value: number; min: number; max: number; unit: string; onChange: (v: number) => void }) {
  return (
    <div className="prow">
      <span className="plabel">{p.label}</span>
      <input
        type="range"
        min={p.min}
        max={p.max}
        value={p.value}
        onChange={(e) => p.onChange(Number(e.target.value))}
        style={{ ["--fill" as string]: `${((p.value - p.min) / (p.max - p.min)) * 100}%` }}
      />
      <label className="num">
        <input
          type="number"
          min={p.min}
          max={p.max}
          value={p.value}
          onChange={(e) => e.target.value !== "" && p.onChange(Math.max(p.min, Math.min(p.max, Number(e.target.value))))}
        />
        <u>{p.unit}</u>
      </label>
    </div>
  );
}

export function RightPanel(p: Props) {
  const { s, set } = useSettings();
  const ui = useStore();
  const sel = p.selectionCount;

  return (
    <aside className="right">
      <Panel id="question" title="Question" meta={p.task.slideCount > 1 ? `slide ${p.task.slideIndex + 1} / ${p.task.slideCount}` : undefined}>
        <div className="qid">
          <span className="qn">Q{p.task.q}</span>
          <span className="slide">{p.task.slide}</span>
        </div>
        <p className="prompt">{p.question?.prompt || <span className="muted">No prompt text.</span>}</p>
        {p.question && p.question.slides.length > 1 && (
          <p className="help">Either slide: {p.question.slides.join(" or ")}. One pin in total; pins on both count as multiple.</p>
        )}
      </Panel>

      <Panel id="clusters" title="Clusters" meta={`${p.clusters.length} groups`}>
        <SliderRow label="Radius" value={s.clusterRadiusUm} min={2} max={300} unit="µm" onChange={(v) => set({ clusterRadiusUm: v })} />
        <SliderRow label="Min size" value={s.minClusterSize} min={2} max={20} unit="pins" onChange={(v) => set({ minClusterSize: v })} />
        <div className="prow tool">
          <span className="plabel">Tool</span>
          <div className="seg wide">
            <button className={s.selectTool === "lasso" ? "on acc" : ""} onClick={() => set({ selectTool: "lasso" })}>
              <IconLasso /> Lasso
            </button>
            <button className={s.selectTool === "brush" ? "on acc" : ""} onClick={() => set({ selectTool: "brush" })}>
              <IconBrush /> Brush
            </button>
          </div>
          <span className="kbd">B</span>
        </div>
        {s.selectTool === "brush" && (
          <SliderRow label="Brush" value={s.brushPx} min={6} max={200} unit="px" onChange={(v) => set({ brushPx: v })} />
        )}
        <div className="selbox">
          <div className="selline">
            <span className="big">
              {sel}
              <small>pin{sel === 1 ? "" : "s"} selected</small>
            </span>
            <span className="hint">⇧ Correct = add note</span>
          </div>
          <div className="grade">
            <button
              key={p.flash?.kind === "correct" ? `c${p.flash.n}` : "c"}
              className={`btn ok ${p.flash?.kind === "correct" ? "flash" : ""}`}
              disabled={!sel}
              title="Mark all selected pins correct · ⇧-click to add a note"
              onClick={(e) => p.onGradeSelection("correct", e.shiftKey)}
            >
              <span className="l">
                <IconCheck /> Correct
              </span>
              <span className="kbd">C</span>
            </button>
            <button
              key={p.flash?.kind === "wrong" ? `w${p.flash.n}` : "w"}
              className={`btn bad ${p.flash?.kind === "wrong" ? "flash" : ""}`}
              disabled={!sel}
              onClick={() => p.onGradeSelection("wrong")}
            >
              <span className="l">
                <IconCross /> Wrong…
              </span>
              <span className="kbd">W</span>
            </button>
          </div>
        </div>
      </Panel>

      <Panel id="display" title="Display">
        <label className="drow">
          <span className="check">
            <input type="checkbox" checked={ui.flagsVisible} onChange={(e) => ui.set({ flagsVisible: e.target.checked })} />
            Show pins
          </span>
          <span className="kbd">{keyLabel(s.toggleFlagsKey)}</span>
        </label>
        <label className="drow">
          <span className="check">
            <input type="checkbox" checked={ui.minimapVisible} onChange={(e) => ui.set({ minimapVisible: e.target.checked })} />
            Minimap
          </span>
          <span className="kbd">{keyLabel(s.minimapKey)}</span>
        </label>
        <label className="drow">
          <span className="check">
            <input type="checkbox" checked={ui.isolate} onChange={(e) => ui.set({ isolate: e.target.checked })} />
            Isolate selection
          </span>
          <span className="kbd">I</span>
        </label>
        <label className="drow">
          <span className="check">
            <input type="checkbox" checked={s.showOtherQuestions} onChange={(e) => set({ showOtherQuestions: e.target.checked })} />
            Faded pins from other questions
          </span>
        </label>
        <div className="drow">
          <span className="plabel">Pin text</span>
          <div className="seg small">
            {(["none", "title", "student"] as const).map((m) => (
              <button key={m} className={s.labelMode === m ? "on" : ""} onClick={() => set({ labelMode: m })}>
                {m === "none" ? "Hidden" : m === "title" ? "Pin title" : "Student"}
              </button>
            ))}
          </div>
        </div>
      </Panel>

      <Panel id="reasons" title="Recent reasons" meta="this question">
        {p.reasons.length === 0 ? (
          <p className="help">Reasons you give for wrong answers collect here. Click one to apply it to the selection.</p>
        ) : (
          <>
            {p.reasons.map((r, i) => (
              <button
                key={r.text}
                className="rr"
                disabled={!sel}
                onClick={() => p.onPickReason(r.text)}
                title={sel ? `Mark ${sel} selected pins wrong: ${r.text}` : "Select pins first"}
              >
                <span className="kbd">{i + 1}</span>
                <span className="rt">{r.text}</span>
                <span className="mono">{r.pins}</span>
              </button>
            ))}
            <p className="help">
              After <span className="kbd">W</span> press a number to reuse a reason.
            </p>
          </>
        )}
      </Panel>

      <div className="side-grow" />

      <Panel id="progress" title="Progress" fixed>
        <Bar label="This image" a={p.progress.taskDone} b={p.progress.taskTotal} color="var(--accent)" />
        <Bar label="Images done" a={p.progress.tasksDone} b={p.progress.tasksTotal} />
        <Bar label="All pins" a={p.progress.pinsDone} b={p.progress.pinsTotal} />
        <div className="navimg">
          <button className="btn" onClick={p.onPrevImage} disabled={!p.hasPrev}>
            <IconChevL /> Prev
          </button>
          <button className="btn light" onClick={p.onNextImage} disabled={!p.hasNext}>
            Next image <IconChevR />
          </button>
        </div>
      </Panel>
    </aside>
  );
}

function Bar({ label, a, b, color }: { label: string; a: number; b: number; color?: string }) {
  return (
    <div className="pr">
      <div className="t">
        <span>{label}</span>
        <span className="v">
          {a}/{b} <i>· {pct(a, b)}%</i>
        </span>
      </div>
      <div className="bar">
        <b style={{ width: `${pct(a, b)}%`, background: color ?? "#8a8a8a" }} />
      </div>
    </div>
  );
}
