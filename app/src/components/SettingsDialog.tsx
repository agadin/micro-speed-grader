import { useEffect, useRef, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { keyLabel, useSettings, type Settings } from "../lib/settings";
import { SliderRow } from "./RightPanel";
import { drawMarker } from "../lib/markers";
import { IconCircleDash, IconKeyboard, IconLasso, IconPin, IconText } from "./icons";

type Pane = "pins" | "select" | "input" | "clusters" | "text";
const PANES: { id: Pane; label: string; icon: ReactNode; lede: string }[] = [
  { id: "pins", label: "Pins", icon: <IconPin />, lede: "How student pins are drawn on the slide." },
  {
    id: "select",
    label: "Selection",
    icon: <IconLasso />,
    lede: "Ways to pick out pins. Turn on any combination: enabled tools show in the Tool switcher (B cycles them), and the rest work alongside whichever tool is active.",
  },
  { id: "input", label: "Mouse & keys", icon: <IconKeyboard />, lede: "Which button pans and which selects, zooming, and the keys you can rebind." },
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
  paint: "Painted area",
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
              <div className="gt">Mouse</div>
              {row(
                "Buttons",
                seg(s.swapMouse ? "swap" : "std", [
                  ["std", "Left pans"],
                  ["swap", "Left selects"],
                ], (v) => set({ swapMouse: v === "swap" })),
                s.swapMouse ? "right-drag pans; click a pin with either button" : "right-drag selects, like NDP.view",
              )}
              {row(
                "Scroll zoom speed",
                <SliderRow
                  label=""
                  value={Math.round((s.zoomPerScroll - 1) * 100)}
                  min={5}
                  max={60}
                  unit="%"
                  onChange={(v) => set({ zoomPerScroll: 1 + v / 100 })}
                />,
                "how far one scroll-wheel step zooms",
              )}
              {row(
                "Double-click",
                <label className="check">
                  <input type="checkbox" checked={s.dblClickZoom} onChange={(e) => set({ dblClickZoom: e.target.checked })} />
                  zooms in
                </label>,
              )}
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

        {pane === "select" && <SelectionPane s={s} set={set} />}

        {pane === "clusters" && (
          <div className="group">
            {row("Cluster radius", numField("clusterRadiusUm", 2, 1000, "µm"), "pins within this distance group together")}
            {row("Min pins per cluster", numField("minClusterSize", 2, 50, "pins"), "smaller groups are listed as single pins")}
            {row("Single-pin field", numField("singleFieldUm", 20, 5000, "µm"), "view width when zooming to one pin")}
            {row("Padding", numField("clusterPaddingUm", 0, 1000, "µm"), "margin around a cluster when zooming")}
            {row(
              "Next cluster",
              <label className="check">
                <input type="checkbox" checked={s.autoZoomCluster} onChange={(e) => set({ autoZoomCluster: e.target.checked })} />
                zoom to it automatically
              </label>,
              "off: the view stays put; press F to zoom",
            )}
            {row(
              "Animation",
              <label className="check">
                <input type="checkbox" checked={s.animate} onChange={(e) => set({ animate: e.target.checked })} />
                smooth zoom and pan
              </label>,
              "off: jumps instantly",
            )}
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

type Stain = "he" | "toluidine" | "ihc" | "reticulin";
const STAINS: { id: Stain; label: string }[] = [
  { id: "he", label: "H&E" },
  { id: "toluidine", label: "Toluidine blue" },
  { id: "ihc", label: "IHC (DAB)" },
  { id: "reticulin", label: "Silver reticulin" },
];

/** soft wash in a stain's colours: a diagonal gradient with two gentle blooms */
const STAIN_WASH: Record<Stain, { stops: string[]; bloom: [string, string] }> = {
  he: { stops: ["#f3cfe0", "#e6aacb", "#d48bb6", "#c27aa8"], bloom: ["rgba(150,95,190,0.35)", "rgba(255,225,235,0.5)"] },
  toluidine: { stops: ["#dbe3f5", "#b7c6ea", "#95a9de", "#7f8fd0"], bloom: ["rgba(150,90,190,0.35)", "rgba(235,242,255,0.5)"] },
  ihc: { stops: ["#f2efec", "#e3e2ea", "#cfd3e6", "#c9b8a6"], bloom: ["rgba(150,95,45,0.35)", "rgba(170,185,225,0.4)"] },
  reticulin: { stops: ["#efe4c2", "#dccb98", "#c7ae74", "#9c8558"], bloom: ["rgba(60,50,35,0.3)", "rgba(250,240,210,0.5)"] },
};
function drawWash(ctx: CanvasRenderingContext2D, w: number, h: number, stain: Stain) {
  const { stops, bloom } = STAIN_WASH[stain];
  const g = ctx.createLinearGradient(0, 0, w, h);
  stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1), c));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  for (const [x, y, r, c] of [
    [w * 0.72, h * 0.25, w * 0.35, bloom[0]],
    [w * 0.2, h * 0.85, w * 0.3, bloom[1]],
  ] as [number, number, number, string][]) {
    const b = ctx.createRadialGradient(x, y, 0, x, y, r);
    b.addColorStop(0, c);
    b.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = b;
    ctx.fillRect(0, 0, w, h);
  }
}

/** a strip showing each marker state in the current style and colours, over a choice of stains */
function MarkerPreview({ settings: s }: { settings: Settings }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const set = useSettings((x) => x.set);
  const stain: Stain = STAINS.some((t) => t.id === s.previewStain) ? (s.previewStain as Stain) : "he";
  const next = () => set({ previewStain: STAINS[(STAINS.findIndex((t) => t.id === stain) + 1) % STAINS.length].id });
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr;
    c.height = h * dpr;
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawWash(ctx, w, h, stain);
    const states: (keyof Settings["colors"])[] = ["ungraded", "selected", "correct", "wrong", "double"];
    states.forEach((st, i) => {
      const x = 40 + i * ((w - 140) / 4), y = h * 0.72;
      drawMarker(ctx, x, y, s.colors[st], s.pinSize, s.pinStyle);
      ctx.font = '600 9.5px "IBM Plex Mono", monospace';
      const tw = ctx.measureText(st).width;
      ctx.fillStyle = "rgba(15,15,15,0.6)";
      ctx.fillRect(x - 18 - 3, h - 15, tw + 6, 13);
      ctx.fillStyle = "#fff";
      ctx.fillText(st, x - 18, h - 5);
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
  }, [s.colors, s.pinSize, s.pinStyle, stain]);
  return (
    <button className="preview-strip" onClick={next} title="Click to try the next stain">
      <span className="pl">
        Preview · {STAINS.find((t) => t.id === stain)!.label} <span className="nx">›</span>
      </span>
      <canvas ref={ref} />
    </button>
  );
}

type MethodId = "lasso" | "brush" | "polygon" | "hidden-paint" | "pin-by-pin" | "spotlight" | "shrink" | "click-toggle";
interface MethodDef {
  id: MethodId;
  group: string;
  title: string;
  /** one line for the list */
  sub: string;
  key?: string;
  on: boolean;
  toggle: (v: boolean) => void;
  /** the last enabled tool can't be switched off */
  locked?: boolean;
  desc: ReactNode;
  extra?: ReactNode;
}

/** Selection methods: a list of switches on the right, the selected one's demo + details on the left */
function SelectionPane({ s, set }: { s: Settings; set: (patch: Partial<Settings>) => void }) {
  const [selId, setSelId] = useState<MethodId>("lasso");
  const [missing, setMissing] = useState<Record<string, boolean>>({});
  const Btn = s.swapMouse ? "Left" : "Right";
  const tools = Object.values(s.tools).filter(Boolean).length;
  const tool = (k: keyof Settings["tools"]) => ({
    on: s.tools[k],
    toggle: (v: boolean) => set({ tools: { ...s.tools, [k]: v } }),
    locked: s.tools[k] && tools === 1,
  });
  const kbd = (k: string) => <span className="kbd">{k}</span>;
  const methods: MethodDef[] = [
    {
      id: "lasso",
      group: "Tools",
      title: "Lasso",
      sub: "loop around pins",
      key: "B",
      ...tool("lasso"),
      desc: (
        <>
          {Btn}-drag a loop around pins. {kbd("⌘")} adds to the selection, {kbd("⇧")} selects everything outside,{" "}
          {kbd("⌥")} draws a rectangle.
        </>
      ),
    },
    {
      id: "brush",
      group: "Tools",
      title: "Paint brush",
      sub: "paint over pins",
      key: "B",
      ...tool("brush"),
      desc: (
        <>
          Paint over pins to select them. {kbd("⇧")} adds, {kbd("⌥")} removes, {kbd("−")} {kbd("=")} change the size.
        </>
      ),
      extra: (
        <div className="mextra">
          <span>Brush size</span>
          <SliderRow label="" value={s.brushPx} min={6} max={200} unit="px" onChange={(v) => set({ brushPx: v })} />
        </div>
      ),
    },
    {
      id: "polygon",
      group: "Tools",
      title: "Polygon",
      sub: "click corner by corner",
      key: "B",
      ...tool("polygon"),
      desc: (
        <>
          {Btn}-click corner by corner to outline a structure exactly; click the first corner, double-click or press{" "}
          {kbd("↵")} to close. {kbd("⌫")} removes the last corner, {kbd("Esc")} cancels.
        </>
      ),
    },
    {
      id: "hidden-paint",
      group: "Crowded clusters",
      title: "Paint with pins hidden",
      sub: "painted ✓, rest of cluster ✗",
      key: keyLabel(s.toggleFlagsKey),
      on: s.hiddenPaint,
      toggle: (v) => set({ hiddenPaint: v }),
      desc: (
        <>
          Hide the pins ({kbd(keyLabel(s.toggleFlagsKey))}) and paint the correct structure with any tool, in as many
          strokes as you like. Show the pins again: those in the paint are selected, and the cluster's other pins get a
          dashed red ring. {kbd("C")} opens a reason box for the rest; {kbd("↵")} marks the painted pins correct and the
          rest wrong with that reason, in one undo step.
        </>
      ),
    },
    {
      id: "pin-by-pin",
      group: "Crowded clusters",
      title: "Pin by pin",
      sub: "one pin shown at a time",
      key: "O",
      on: s.pinByPin,
      toggle: (v) => set({ pinByPin: v }),
      desc: (
        <>
          Press {kbd("O")} to step through the cluster one pin at a time, with only that pin shown. {kbd("C")} /{" "}
          {kbd("W")} grades it and moves to the next; {kbd("←")} {kbd("→")} skip around.
        </>
      ),
    },
    {
      id: "spotlight",
      group: "Crowded clusters",
      title: "Spotlight on hover",
      sub: "hide the other pins",
      on: s.spotlight,
      toggle: (v) => set({ spotlight: v }),
      desc: <>Rest the cursor on a pin and every other pin disappears, so you can see what it points at. Click to grade it.</>,
    },
    {
      id: "shrink",
      group: "Crowded clusters",
      title: "Small pins when zoomed",
      sub: "smaller marker up close",
      on: s.shrinkPins,
      toggle: (v) => set({ shrinkPins: v }),
      desc: (
        <>
          Pins switch to a small marker once you zoom in past {s.shrinkUmPerPx} µm/px (the readout at the top right of
          the slide), so they cover less tissue.
        </>
      ),
      extra: (
        <div className="mextra">
          <span className="ml">Marker</span>
          <div className="seg">
            {(
              [
                ["dot", "Dot"],
                ["cross", "Crosshair"],
                ["flag", "Small flag"],
                ["pushpin", "Small pin"],
              ] as const
            ).map(([v, l]) => (
              <button key={v} className={s.shrinkStyle === v ? "on" : ""} onClick={() => set({ shrinkStyle: v })}>
                {l}
              </button>
            ))}
          </div>
          <span className="ml">Zoomed past</span>
          <div className="seg">
            {[0.25, 0.5, 1, 2].map((v) => (
              <button key={v} className={s.shrinkUmPerPx === v ? "on" : ""} onClick={() => set({ shrinkUmPerPx: v })}>
                {v} µm/px
              </button>
            ))}
          </div>
        </div>
      ),
    },
    {
      id: "click-toggle",
      group: "Crowded clusters",
      title: "Click to add / remove",
      sub: "click toggles a pin",
      on: s.clickToggle,
      toggle: (v) => set({ clickToggle: v }),
      desc: (
        <>
          A plain click on a pin adds it to the selection or removes it, which is handy for fixing a few stragglers after
          a lasso. {kbd("⌘")}-click then opens the grade menu instead.
        </>
      ),
    },
  ];
  const cur = methods.find((m) => m.id === selId)!;
  const move = (d: number) => {
    const i = methods.findIndex((m) => m.id === selId);
    setSelId(methods[Math.max(0, Math.min(methods.length - 1, i + d))].id);
  };
  const sw = (m: MethodDef) => (
    <input
      type="checkbox"
      className="switch"
      checked={m.on}
      disabled={m.locked}
      title={m.locked ? "At least one tool stays on" : m.on ? "On" : "Off"}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => m.toggle(e.target.checked)}
    />
  );

  return (
    <div className="sel-pane">
      <div
        className="sel-list"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            move(e.key === "ArrowDown" ? 1 : -1);
          } else if (e.key === " " && !cur.locked) {
            e.preventDefault();
            cur.toggle(!cur.on);
          }
        }}
      >
        {methods.map((m, i) => (
          <div key={m.id}>
            {(i === 0 || methods[i - 1].group !== m.group) && <div className="gt">{m.group}</div>}
            <div className={`sel-row ${m.id === selId ? "cur" : ""} ${m.on ? "" : "off"}`} onClick={() => setSelId(m.id)}>
              <span className="sr-text">
                <span className="sr-title">{m.title}</span>
                <span className="sr-sub">{m.sub}</span>
              </span>
              {sw(m)}
            </div>
          </div>
        ))}
      </div>
      <div className="sel-preview">
        {missing[cur.id] ? (
          <div className="demo none">No demo</div>
        ) : (
          <img
            key={cur.id}
            className="demo"
            src={`help/${cur.id}.gif`}
            alt={`${cur.title} demo`}
            onError={() => setMissing((m) => ({ ...m, [cur.id]: true }))}
          />
        )}
        <div className="sp-head">
          <span className="sp-title">
            {cur.title} {cur.key && kbd(cur.key)}
          </span>
          {sw(cur)}
        </div>
        <p className="mdesc">{cur.desc}</p>
        {cur.extra && <div className={cur.on ? "" : "dim"}>{cur.extra}</div>}
      </div>
    </div>
  );
}
