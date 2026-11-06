import { useEffect, useRef, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { keyLabel, useSettings, type Settings } from "../lib/settings";
import { SliderRow } from "./RightPanel";
import { drawMarker } from "../lib/markers";
import { IconCircleDash, IconKeyboard, IconPin, IconText } from "./icons";

type Pane = "pins" | "input" | "clusters" | "text";
const PANES: { id: Pane; label: string; icon: ReactNode; lede: string }[] = [
  { id: "pins", label: "Pins", icon: <IconPin />, lede: "How student pins are drawn on the slide." },
  { id: "input", label: "Selection & keys", icon: <IconKeyboard />, lede: "Right-drag tool and the keys you can rebind." },
  { id: "clusters", label: "Clusters & zoom", icon: <IconCircleDash />, lede: "How pins are grouped and how far the view zooms in." },
  { id: "text", label: "Grading text", icon: <IconText />, lede: "What students read in their feedback." },
];
const COLOR_LABELS: Record<keyof Settings["colors"], string> = {
  ungraded: "Ungraded",
  selected: "Selected",
  correct: "Correct",
  cluster: "Cluster outline",
  wrong: "Wrong",
  double: "Double pin",
};

/** Preferences rendered as its own window (index.html?window=preferences). */
export function PreferencesWindow() {
  return (
    <SettingsDialog
      asWindow
      onClose={() => {
        getCurrentWindow()
          .close()
          .catch(() => window.close());
      }}
    />
  );
}

export function SettingsDialog({ onClose, asWindow = false }: { onClose: () => void; asWindow?: boolean }) {
  const { s, set, reset } = useSettings();
  const [pane, setPane] = useState<Pane>("pins");
  const [capturing, setCapturing] = useState<null | "toggleFlagsKey" | "minimapKey">(null);
  const meta = PANES.find((p) => p.id === pane)!;

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && !capturing && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [capturing, onClose]);

  const row = (label: string, ctl: ReactNode, help?: ReactNode) => (
    <div className="prow2">
      <label>{label}</label>
      <div className="ctl">
        {ctl}
        {help && <span className="help">{help}</span>}
      </div>
    </div>
  );
  const seg = <T extends string>(value: T, opts: [T, ReactNode][], on: (v: T) => void) => (
    <div className="seg">
      {opts.map(([v, l]) => (
        <button key={v} className={value === v ? "on" : ""} onClick={() => on(v)}>
          {l}
        </button>
      ))}
    </div>
  );
  const numField = (k: keyof Settings, min: number, max: number, unit: string) => (
    <label className="num wide">
      <input
        type="number"
        min={min}
        max={max}
        value={s[k] as number}
        onChange={(e) => e.target.value !== "" && set({ [k]: Math.max(min, Math.min(max, Number(e.target.value))) } as Partial<Settings>)}
      />
      <u>{unit}</u>
    </label>
  );
  const txt = (k: keyof Settings) => (
    <input className="input" value={s[k] as string} onChange={(e) => set({ [k]: e.target.value } as Partial<Settings>)} />
  );
  const keyCap = (k: "toggleFlagsKey" | "minimapKey", label: string) => (
    <div className="keyrow">
      <span>{label}</span>
      <button
        className={`cap ${capturing === k ? "listening" : ""}`}
        onClick={() => setCapturing(k)}
        onKeyDown={(e) => {
          if (capturing !== k) return;
          e.preventDefault();
          e.stopPropagation();
          if (e.key !== "Escape") set({ [k]: e.key } as Partial<Settings>);
          setCapturing(null);
        }}
        onBlur={() => setCapturing(null)}
      >
        {capturing === k ? "Press a key…" : keyLabel(s[k])}
      </button>
      <button className="btn ghost" onClick={() => setCapturing(k)}>
        Change
      </button>
    </div>
  );

  const body = (
    <div className="prefs">
      <nav className="prefs-nav">
        {PANES.map((p) => (
          <button key={p.id} className={pane === p.id ? "on" : ""} onClick={() => setPane(p.id)}>
            {p.icon}
            {p.label}
          </button>
        ))}
      </nav>
      <div className="prefs-content">
        <h2>{meta.label}</h2>
        <p className="lede">{meta.lede}</p>

        {pane === "pins" && (
          <>
            <div className="group">
              {row(
                "Marker style",
                seg(s.pinStyle, [
                  ["flag", "Flag"],
                  ["pushpin", "Push-pin"],
                  ["dot", "Dot"],
                  ["cross", "Crosshair"],
                ], (v) => set({ pinStyle: v })),
              )}
              {row(
                "Marker size",
                <SliderRow label="" value={s.pinSize} min={6} max={40} unit="px" onChange={(v) => set({ pinSize: v })} />,
              )}
              {row(
                "Pin text",
                <select value={s.labelMode} onChange={(e) => set({ labelMode: e.target.value as Settings["labelMode"] })}>
                  <option value="none">Hidden</option>
                  <option value="title">Pin title (what the student typed)</option>
                  <option value="student">Student name</option>
                </select>,
                "also in the Display panel",
              )}
              {row(
                "Faded pins opacity",
                <SliderRow
                  label=""
                  value={Math.round(s.otherOpacity * 100)}
                  min={5}
                  max={100}
                  unit="%"
                  onChange={(v) => set({ otherOpacity: v / 100 })}
                />,
              )}
            </div>
            <div className="group">
              <div className="gt">Colours</div>
              <div className="swatches">
                {(Object.keys(COLOR_LABELS) as (keyof Settings["colors"])[]).map((c) => (
                  <label key={c} className="sw">
                    <input type="color" value={s.colors[c]} onChange={(e) => set({ colors: { ...s.colors, [c]: e.target.value } })} />
                    <span>{COLOR_LABELS[c]}</span>
                    <span className="hex">{s.colors[c].toUpperCase()}</span>
                  </label>
                ))}
              </div>
              <MarkerPreview settings={s} />
            </div>
          </>
        )}

        {pane === "input" && (
          <>
            <div className="group">
              <div className="gt">Selection</div>
              {row(
                "Right-drag tool",
                seg(s.selectTool, [
                  ["lasso", "Lasso"],
                  ["brush", "Paint brush"],
                ], (v) => set({ selectTool: v })),
                <>
                  toggle with <span className="kbd">B</span>
                </>,
              )}
              {row("Brush size", <SliderRow label="" value={s.brushPx} min={6} max={200} unit="px" onChange={(v) => set({ brushPx: v })} />)}
            </div>
            <div className="group">
              <div className="gt">Keys</div>
              {keyCap("toggleFlagsKey", "Show / hide pins")}
              {keyCap("minimapKey", "Show / hide minimap")}
              <p className="help pad">
                Fixed keys: <span className="kbd">C</span> correct · <span className="kbd">W</span> wrong ·{" "}
                <span className="kbd">[</span> <span className="kbd">]</span> clusters · <span className="kbd">F</span> refocus ·{" "}
                <span className="kbd">H</span> whole slide · <span className="kbd">?</span> shortcut sheet
              </p>
            </div>
          </>
        )}

        {pane === "clusters" && (
          <div className="group">
            {row("Cluster radius", numField("clusterRadiusUm", 2, 1000, "µm"), "pins within this distance group together")}
            {row("Min pins per cluster", numField("minClusterSize", 2, 50, "pins"), "smaller groups are listed as single pins")}
            {row("Single-pin field", numField("singleFieldUm", 20, 5000, "µm"), "view width when zooming to one pin")}
            {row("Padding", numField("clusterPaddingUm", 0, 1000, "µm"), "margin around a cluster when zooming")}
          </div>
        )}

        {pane === "text" && (
          <div className="group">
            {row(
              "Wrong answers",
              <label className="check">
                <input type="checkbox" checked={s.wrongNeedsReason} onChange={(e) => set({ wrongNeedsReason: e.target.checked })} />
                require a reason
              </label>,
            )}
            {!s.wrongNeedsReason && row("Default wrong text", txt("wrongDefaultText"))}
            {row("Multiple pins", txt("doubleMessage"))}
            {row("No answer", txt("noAnswerMessage"))}
            <div className="student-sees">
              <div className="gt">Student sees</div>
              <pre>
                {`Overall Feedback
Q1: Correct
Q2: ${s.doubleMessage}
Q3: Eccrine sweat gland
Q4: ${s.noAnswerMessage}

Score: 1/4`}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  const foot = (
    <div className="prefs-foot">
      <button className="btn ghost" onClick={reset}>
        Restore defaults
      </button>
      <span className="sp" />
      <span className="note">Changes apply immediately</span>
      <button className="btn light" onClick={onClose}>
        Done
      </button>
    </div>
  );

  if (asWindow)
    return (
      <div className="prefs-window">
        {body}
        {foot}
      </div>
    );
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal prefs-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="win-title">Preferences</div>
        {body}
        {foot}
      </div>
    </div>
  );
}

/** a strip showing each marker state in the current style and colours */
function MarkerPreview({ settings: s }: { settings: Settings }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr;
    c.height = h * dpr;
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, "#e6b8cf");
    g.addColorStop(0.5, "#d995b8");
    g.addColorStop(1, "#c77fae");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    const states: (keyof Settings["colors"])[] = ["ungraded", "selected", "correct", "wrong", "double"];
    states.forEach((st, i) => {
      const x = 40 + i * ((w - 140) / 4), y = h * 0.72;
      drawMarker(ctx, x, y, s.colors[st], s.pinSize, s.pinStyle);
      ctx.font = '500 9.5px "IBM Plex Mono", monospace';
      ctx.fillStyle = "rgba(20,20,20,0.75)";
      ctx.fillText(st, x - 18, h - 4);
    });
    const cx = w - 50, cy = h / 2, r = 24;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = "rgba(10,10,10,0.55)";
    ctx.stroke();
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = s.colors.cluster;
    ctx.stroke();
  }, [s.colors, s.pinSize, s.pinStyle]);
  return (
    <div className="preview-strip">
      <span className="pl">Preview</span>
      <canvas ref={ref} />
    </div>
  );
}
