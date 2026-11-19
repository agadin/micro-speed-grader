import { useEffect, useRef } from "react";
import OpenSeadragon from "openseadragon";
import type { Pin, SlideInfo } from "../lib/types";
import type { Cluster } from "../lib/cluster";
import type { PinState } from "../lib/grading";
import { activeTool, type Settings } from "../lib/settings";
import { pointInPolygon, type PaintOp } from "../lib/paint";
import { area, centre, fmtArea, fmtLength, measureLabel, type Measure } from "../lib/measure";
import { tileBase } from "../lib/backend";
import { drawMarker } from "../lib/markers";

/** imperative helpers the grader uses (e.g. to place the grading menu beside the pins) */
export interface ViewerApi {
  /** bounding box of the given pins' markers in client (window) coordinates, or null if none visible */
  clientBounds: (pinIds: string[]) => { left: number; top: number; right: number; bottom: number } | null;
}

export interface ViewerProps {
  apiRef?: { current: ViewerApi | null };
  info: SlideInfo | null;
  /** shown in the readout, e.g. VMS109 */
  slideLabel?: string;
  /** pixels of the viewer covered by floating panels; zoom/centring use the rest */
  insets?: { top: number; right: number; bottom: number; left: number };
  error: string | null;
  pins: Pin[];
  otherPins: Pin[];
  states: Map<string, PinState>;
  /** pins two graders disagreed on (drawn with a ! badge) */
  flagged?: Set<string>;
  /** a student's several pins for one question (drawn with a 2 badge, graded or not) */
  multi?: Set<string>;
  /** new pins from a changed submission, waiting in Changed submissions (drawn with a blue ↻ badge) */
  changed?: Set<string>;
  selection: Set<string>;
  cluster: Cluster | null;
  isolate: boolean;
  flagsVisible: boolean;
  minimapVisible: boolean;
  settings: Settings;
  studentName: (id: string) => string;
  focus: { pinIds: string[]; nonce: number } | null;
  onLasso: (pinIds: string[], clientX: number, clientY: number) => void;
  /** brush with ⇧/⌥: refine the selection without opening the menu */
  onSelect: (pinIds: string[]) => void;
  onPinClick: (pinId: string, clientX: number, clientY: number) => void;
  onEmptyRightClick: (clientX: number, clientY: number) => void;
  /** the user dragged/resized the cluster circle; ids = ungraded pins now inside it */
  onClusterAdjust: (cx: number, cy: number, radiusNm: number, pinIds: string[]) => void;
  homeNonce: number;
  /** pin-by-pin mode: draw (and hit-test) only these pins */
  onlyPinIds?: Set<string> | null;
  /** area painted while pins were hidden (slide coordinates) */
  paint?: PaintOp[];
  /** a stroke made while pins are hidden (and painting is on), or any stroke when `paintAlways` */
  onPaint?: (op: PaintOp) => void;
  /** answer-key editing: the selection tools paint areas even with the pins showing */
  paintAlways?: boolean;
  /** painted areas drawn under the pins, e.g. answer-key marks (green right, red wrong) */
  layers?: { ops: PaintOp[]; color: string; alpha: number }[];
  /** pins that "painted ✓ / rest ✗" would mark wrong: drawn with a dashed red ring */
  pendingWrong?: Set<string>;
  /** ruler mode: the selecting button measures (drag = distance, clicks = outline) instead of selecting */
  ruler?: boolean;
  /** measurements to draw (slide coordinates) */
  measures?: Measure[];
  onMeasure?: (m: Measure) => void;
}

type Pt = { x: number; y: number };
const SANS = "-apple-system, BlinkMacSystemFont, sans-serif";
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
/** "#rrggbb" → rgba() with the given alpha */
function hexA(hex: string, a: number) {
  const n = parseInt(hex.slice(1, 7), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function SlideViewer(props: ViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<OpenSeadragon.Viewer | null>(null);
  const navCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const lassoRef = useRef<{
    pts: Pt[];
    rect: boolean;
    inverse: boolean;
    start: Pt;
    brush: boolean;
    /** brush: "replace" | "add" (⇧) | "remove" (⌥) */
    brushMode: "replace" | "add" | "remove";
    /** ⌘/Ctrl held: lasso adds to the current selection (no menu) */
    add: boolean;
    painted: Set<string>;
  } | null>(null);
  const hoverRef = useRef<Pt | null>(null);
  /** polygon in progress: vertices in slide nm (so panning / zooming between clicks is fine) */
  const polyRef = useRef<{ pts: { x: number; y: number }[]; add: boolean; inverse: boolean } | null>(null);
  /** ruler: a distance being dragged (screen px), and an outline being clicked (nm) */
  const rulerDrag = useRef<{ start: { x: number; y: number }; cur: { x: number; y: number } } | null>(null);
  const rulerPoly = useRef<{ pts: { x: number; y: number }[]; last: number } | null>(null);
  /** spotlight: the pin under the cursor (others are hidden while it is) */
  const spotRef = useRef<string | null>(null);
  const paintCanvas = useRef<HTMLCanvasElement | null>(null);
  /** left-drag on the cluster label (move) or its edge/knob (resize) */
  const panRef = useRef<{ last: Pt; start: Pt; far: number } | null>(null);
  const dragRef = useRef<{ mode: "move" | "resize"; start: Pt; cx: number; cy: number; r: number; c0: { cx: number; cy: number; r: number } } | null>(null);
  const rafRef = useRef(0);
  const pendingFocus = useRef<string[] | null>(null);

  const requestDraw = () => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(draw);
  };

  // --- coordinate helpers ---
  const nmToImage = (xNm: number, yNm: number): Pt => {
    const i = propsRef.current.info!;
    return {
      x: (xNm - i.xOffsetNm) / (i.mppX * 1000) + i.width / 2,
      y: (yNm - i.yOffsetNm) / (i.mppY * 1000) + i.height / 2,
    };
  };
  const nmToScreen = (xNm: number, yNm: number): Pt => {
    const v = viewerRef.current!;
    const ip = nmToImage(xNm, yNm);
    const p = v.viewport.imageToViewerElementCoordinates(new OpenSeadragon.Point(ip.x, ip.y));
    return { x: p.x, y: p.y };
  };
  const screenToNm = (pt: Pt) => {
    const v = viewerRef.current!;
    const i = propsRef.current.info!;
    const ip = v.viewport.viewerElementToImageCoordinates(new OpenSeadragon.Point(pt.x, pt.y));
    return { x: (ip.x - i.width / 2) * i.mppX * 1000 + i.xOffsetNm, y: (ip.y - i.height / 2) * i.mppY * 1000 + i.yOffsetNm };
  };
  /** screen pixels per nanometre at the current zoom */
  const pxPerNm = () => {
    const v = viewerRef.current!;
    const i = propsRef.current.info!;
    const a = v.viewport.imageToViewerElementCoordinates(new OpenSeadragon.Point(0, 0));
    const b = v.viewport.imageToViewerElementCoordinates(new OpenSeadragon.Point(1000, 0));
    return (b.x - a.x) / 1000 / (i.mppX * 1000);
  };

  const visiblePins = () => {
    const p = propsRef.current;
    if (!p.flagsVisible) return [] as Pin[];
    let pins = p.isolate ? p.pins.filter((x) => p.selection.has(x.id)) : p.pins;
    if (p.onlyPinIds) pins = pins.filter((x) => p.onlyPinIds!.has(x.id));
    return pins;
  };
  /** pins are hidden but strokes paint an area to grade by */
  const paintMode = () =>
    !!propsRef.current.paintAlways || (!propsRef.current.flagsVisible && propsRef.current.settings.hiddenPaint);

  /** marker style / size in effect: small dots once zoomed past the shrink threshold */
  const markerLook = (): { style: Settings["pinStyle"]; size: number } => {
    const s = propsRef.current.settings;
    if (s.shrinkPins && viewerRef.current && propsRef.current.info) {
      const umPerPx = 1 / (pxPerNm() * 1000);
      if (umPerPx < s.shrinkUmPerPx) return { style: s.shrinkStyle, size: s.shrinkStyle === "dot" ? 9 : Math.min(s.pinSize, 10) };
    }
    return { style: s.pinStyle, size: s.pinSize };
  };

  /** centre of a marker's visible head (flag cloth / pin head), relative to its point */
  const headPos = (x: number, y: number): Pt => {
    const { style, size: z } = markerLook();
    if (style === "flag") return { x: x + z * 0.45, y: y - z * 1.15 };
    if (style === "pushpin") return { x: x + z * 0.62, y: y - z * 0.62 };
    return { x, y };
  };

  const hitTest = (sx: number, sy: number): Pin | null => {
    const size = markerLook().size;
    let best: Pin | null = null;
    let bestD = Infinity;
    for (const pin of visiblePins()) {
      const s = nmToScreen(pin.xNm, pin.yNm);
      const hp = headPos(s.x, s.y);
      const d = Math.min(Math.hypot(sx - hp.x, sy - hp.y), Math.hypot(sx - s.x, sy - s.y));
      if (d < Math.max(8, size * 0.75) && d < bestD) {
        bestD = d;
        best = pin;
      }
    }
    return best;
  };

  /** add every visible pin within the brush radius of segment a→b */
  const paint = (a: Pt, b: Pt, into: Set<string>) => {
    const r = propsRef.current.settings.brushPx;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1;
    for (const pin of visiblePins()) {
      const s = nmToScreen(pin.xNm, pin.yNm);
      const t = Math.max(0, Math.min(1, ((s.x - a.x) * dx + (s.y - a.y) * dy) / len2));
      if (Math.hypot(s.x - (a.x + t * dx), s.y - (a.y + t * dy)) <= r) into.add(pin.id);
    }
  };

  /** selection as it will be once the current brush stroke is released */
  const liveCluster = () => {
    const p = propsRef.current;
    const d = dragRef.current;
    if (!p.cluster) return null;
    return d ? { ...p.cluster, cx: d.cx, cy: d.cy, radiusNm: d.r } : p.cluster;
  };
  /** ungraded pins inside a circle (nm) */
  const pinsInCircle = (cx: number, cy: number, r: number) =>
    visiblePins()
      .filter((pin) => (propsRef.current.states.get(pin.id) ?? "ungraded") === "ungraded" && Math.hypot(pin.xNm - cx, pin.yNm - cy) <= r)
      .map((pin) => pin.id);
  /** screen geometry of the cluster circle, its label tag and resize knob */
  const clusterGeom = () => {
    const c = liveCluster();
    if (!c || !propsRef.current.flagsVisible || !viewerRef.current || !propsRef.current.info) return null;
    const ctr = nmToScreen(c.cx, c.cy);
    const r = Math.max(6, c.radiusNm * pxPerNm());
    const n = dragRef.current ? pinsInCircle(c.cx, c.cy, c.radiusNm).length : c.pinIds.length;
    const label = c.single && !dragRef.current ? `${c.label}` : `${c.label} · ${n}`;
    const tw = label.length * 6.6 + 12;
    // square tag sits on the rim at the upper-left (≈ 225°), like a specimen label
    const ax = ctr.x - r * Math.SQRT1_2, ay = ctr.y - r * Math.SQRT1_2;
    const tag = { x: ax - tw + 4, y: ay - 18, w: tw, h: 16 };
    const handles = [
      { x: ctr.x, y: ctr.y - r },
      { x: ctr.x + r, y: ctr.y },
      { x: ctr.x, y: ctr.y + r },
      { x: ctr.x - r, y: ctr.y },
    ];
    const knob = handles[1];
    return { c, ctr, r, label, tag, knob, handles };
  };
  const clusterHit = (pt: Pt): "move" | "resize" | null => {
    const G = clusterGeom();
    if (!G) return null;
    if (pt.x >= G.tag.x && pt.x <= G.tag.x + G.tag.w && pt.y >= G.tag.y && pt.y <= G.tag.y + G.tag.h) return "move";
    if (G.handles.some((h) => Math.abs(pt.x - h.x) <= 6 && Math.abs(pt.y - h.y) <= 6)) return "resize";
    if (Math.hypot(pt.x - G.ctr.x, pt.y - G.ctr.y) <= 9 && !hitTest(pt.x, pt.y)) return "move";
    // grabbing the ring itself (anywhere but a handle) drags the circle around
    if (Math.abs(Math.hypot(pt.x - G.ctr.x, pt.y - G.ctr.y) - G.r) <= 6 && !hitTest(pt.x, pt.y)) return "move";
    return null;
  };

  const liveSelection = (L = lassoRef.current): Set<string> => {
    const p = propsRef.current;
    const d = dragRef.current;
    if (d) return new Set(pinsInCircle(d.cx, d.cy, d.r));
    if (!L || !L.brush) return p.selection;
    if (L.brushMode === "replace") return L.painted;
    const out = new Set(p.selection);
    for (const id of L.painted) L.brushMode === "add" ? out.add(id) : out.delete(id);
    return out;
  };

  /** a plain click on a pin: grade menu, or (click-toggle) add / remove it from the selection; ⌘ swaps the two */
  const clickPin = (hit: Pin, mod: boolean, clientX: number, clientY: number) => {
    const p = propsRef.current;
    if (mod !== p.settings.clickToggle) {
      const sel = new Set(p.selection);
      if (sel.has(hit.id)) sel.delete(hit.id);
      else sel.add(hit.id);
      p.onSelect([...sel]);
    } else p.onPinClick(hit.id, clientX, clientY);
  };

  /** pins inside a screen-space polygon → selection (or paint, while pins are hidden) */
  const finishPolygon = (poly: Pt[], o: { add: boolean; inverse: boolean }, clientX: number, clientY: number) => {
    const p = propsRef.current;
    if (paintMode()) {
      if (poly.length >= 3) p.onPaint?.({ kind: "poly", mode: o.inverse ? "remove" : "add", pts: poly.map(screenToNm) });
      return;
    }
    const ids = visiblePins()
      .filter((pin) => {
        const s = nmToScreen(pin.xNm, pin.yNm);
        return pointInPolygon(s.x, s.y, poly) !== o.inverse;
      })
      .map((pin) => pin.id);
    if (o.add) p.onSelect([...new Set([...p.selection, ...ids])]);
    else p.onLasso(ids, clientX, clientY);
  };
  const closePolygon = (clientX = 0, clientY = 0) => {
    const PG = polyRef.current;
    polyRef.current = null;
    if (PG && PG.pts.length >= 3) finishPolygon(PG.pts.map((q) => nmToScreen(q.x, q.y)), PG, clientX, clientY);
    requestDraw();
  };

  // --- drawing ---
  function draw() {
    const canvas = canvasRef.current;
    const v = viewerRef.current;
    const p = propsRef.current;
    if (!canvas || !v || !p.info || !v.world.getItemCount()) {
      if (canvas) canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const { colors, labelMode } = p.settings;
    const { style: pinStyle, size: pinSize } = markerLook();

    for (const l of propsRef.current.layers ?? []) drawArea(ctx, w, h, dpr, l.ops, l.color, l.alpha);
    const pOps = propsRef.current.paint;
    if (pOps?.length) drawArea(ctx, w, h, dpr, pOps, propsRef.current.settings.colors.paint, propsRef.current.flagsVisible ? 0.26 : 0.38);

    // current cluster circle
    const G = clusterGeom();
    // exposed for UI tests (tests/ui) — where the cluster's move tag / resize knob are
    canvas.dataset.clusterTag = G ? [G.tag.x + G.tag.w / 2, G.tag.y + G.tag.h / 2].map(Math.round).join(",") : "";
    canvas.dataset.clusterKnob = G ? [G.knob.x, G.knob.y].map(Math.round).join(",") : "";
    canvas.dataset.clusterRing = G ? [G.ctr.x, G.ctr.y, G.r].map(Math.round).join(",") : "";
    if (G) {
      const { ctr: c, r } = G;
      const drag = dragRef.current;
      ctx.save();
      // dark halo so the ring reads on any stain, then a dashed warm-white ring
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(246,241,231,0.06)";
      ctx.fill();
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = "rgba(10,10,10,0.55)";
      ctx.stroke();
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = colors.cluster;
      ctx.stroke();
      ctx.setLineDash([]);
      // resize handles (N/E/S/W)
      for (const h of G.handles) {
        ctx.fillStyle = drag?.mode === "resize" ? "#d4a24c" : colors.cluster;
        ctx.fillRect(h.x - 3.5, h.y - 3.5, 7, 7);
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(10,10,10,0.9)";
        ctx.strokeRect(h.x - 3.5, h.y - 3.5, 7, 7);
      }
      // centre move glyph
      ctx.strokeStyle = "rgba(10,10,10,0.6)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(c.x - 6, c.y); ctx.lineTo(c.x + 6, c.y); ctx.moveTo(c.x, c.y - 6); ctx.lineTo(c.x, c.y + 6);
      ctx.stroke();
      ctx.strokeStyle = colors.cluster;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      // square tag (doubles as the move handle)
      ctx.fillStyle = "rgba(10,10,10,0.9)";
      ctx.fillRect(G.tag.x - 1, G.tag.y - 1, G.tag.w + 2, G.tag.h + 2);
      ctx.fillStyle = colors.cluster;
      ctx.fillRect(G.tag.x, G.tag.y, G.tag.w, G.tag.h);
      ctx.font = `600 10.5px ${MONO}`;
      ctx.fillStyle = "#151515";
      ctx.fillText(G.label, G.tag.x + 6, G.tag.y + 11.5);
      if (drag?.mode === "resize") {
        const um = (drag.r / 1000).toFixed(1);
        const t = `r ${um} µm`;
        ctx.font = `500 10px ${MONO}`;
        const w2 = ctx.measureText(t).width + 12;
        ctx.fillStyle = "rgba(17,17,17,0.92)";
        ctx.fillRect(c.x + r + 10, c.y - 9, w2, 18);
        ctx.fillStyle = "#e8e8e8";
        ctx.fillText(t, c.x + r + 16, c.y + 4);
      }
      ctx.restore();
    }

    // other-question pins (faded)
    if (p.flagsVisible && p.settings.showOtherQuestions && !p.isolate) {
      ctx.globalAlpha = p.settings.otherOpacity;
      for (const pin of p.otherPins) {
        const s = nmToScreen(pin.xNm, pin.yNm);
        if (s.x < -20 || s.y < -40 || s.x > w + 20 || s.y > h + 20) continue;
        drawMarker(ctx, s.x, s.y, "#9a9a9a", pinSize * 0.8, pinStyle);
      }
      ctx.globalAlpha = 1;
    }

    let pins = visiblePins();
    // spotlight: while the cursor is on a pin, only that pin is drawn
    const spot = p.settings.spotlight && !lassoRef.current && !dragRef.current && !polyRef.current ? spotRef.current : null;
    if (spot && pins.some((x) => x.id === spot)) pins = pins.filter((x) => x.id === spot);
    const sel = liveSelection();
    // draw ungraded/selected last so they sit on top
    const order = [...pins].sort((a, b) => Number(sel.has(a.id)) - Number(sel.has(b.id)));
    ctx.font = `11px ${MONO}`;
    const onScreen: string[] = [];
    for (const pin of order) {
      const s = nmToScreen(pin.xNm, pin.yNm);
      if (s.x < -40 || s.y < -40 || s.x > w + 40 || s.y > h + 40) continue;
      onScreen.push(`${Math.round(s.x)},${Math.round(s.y)}`);
      const st = p.states.get(pin.id) ?? "ungraded";
      const selected = sel.has(pin.id);
      const color = selected ? colors.selected : colors[st];
      if (selected && st !== "ungraded") {
        // graded pin inside the selection: keep its status colour, add an amber ring
        ctx.beginPath();
        ctx.strokeStyle = colors.selected;
        ctx.lineWidth = 2;
        const hp = headPos(s.x, s.y);
        ctx.arc(hp.x, hp.y, pinSize * 0.62, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (p.pendingWrong?.has(pin.id)) {
        // will be marked wrong by "painted ✓ / rest ✗"
        const hp = headPos(s.x, s.y);
        ctx.save();
        ctx.beginPath();
        ctx.setLineDash([3, 2.5]);
        ctx.lineWidth = 2;
        ctx.strokeStyle = colors.wrong;
        ctx.arc(hp.x, hp.y, pinSize * 0.7, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      drawMarker(ctx, s.x, s.y, selected && st !== "ungraded" ? colors[st] : color, pinSize, pinStyle);
      if (p.flagged?.has(pin.id)) {
        // two graders disagree on this pin: a red dot with "!" beside its head
        const hp = headPos(s.x, s.y);
        const cx = hp.x - pinSize * 0.55 - 5, cy = hp.y - pinSize * 0.25;
        ctx.beginPath();
        ctx.arc(cx, cy, 6, 0, Math.PI * 2);
        ctx.fillStyle = "#e5484d";
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "rgba(0,0,0,0.75)";
        ctx.stroke();
        ctx.fillStyle = "#fff";
        ctx.font = `800 9px ${SANS}`;
        ctx.textAlign = "center";
        ctx.fillText("!", cx, cy + 3.2);
        ctx.textAlign = "start";
        ctx.font = `11px ${MONO}`;
      }
      if (p.changed?.has(pin.id)) {
        // the student changed this answer since it was graded: a blue dot with ↻ below-left of its head
        const hp = headPos(s.x, s.y);
        const cx = hp.x - pinSize * 0.55 - 5, cy = hp.y - pinSize * 0.25 + (p.flagged?.has(pin.id) ? 14 : 0);
        ctx.beginPath();
        ctx.arc(cx, cy, 6.5, 0, Math.PI * 2);
        ctx.fillStyle = "#3e8ef7";
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "rgba(0,0,0,0.75)";
        ctx.stroke();
        // a circular arrow: most of a ring plus an arrowhead
        ctx.beginPath();
        ctx.arc(cx, cy, 3, -Math.PI * 0.35, Math.PI * 1.35);
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.4;
        ctx.stroke();
        const ax = cx + 3 * Math.cos(-Math.PI * 0.35), ay = cy + 3 * Math.sin(-Math.PI * 0.35);
        ctx.beginPath();
        ctx.moveTo(ax + 2.2, ay - 1.2);
        ctx.lineTo(ax, ay);
        ctx.lineTo(ax + 0.4, ay + 2.4);
        ctx.stroke();
      }
      const several = st === "double" || (st === "ungraded" && !!p.multi?.has(pin.id));
      if (several || pin.q === null) {
        const t = several ? "2" : "?";
        const hp = headPos(s.x, s.y);
        const bx = hp.x + pinSize * 0.5, by = hp.y - pinSize * 0.2;
        ctx.fillStyle = "rgba(15,15,15,0.9)";
        ctx.fillRect(bx - 1, by - 8, 10, 11);
        ctx.fillStyle = several ? colors.double : "#f0f0f0";
        ctx.font = `600 9.5px ${MONO}`;
        ctx.fillText(t, bx + 1.5, by + 1);
        ctx.font = `11px ${MONO}`;
      }
      if (labelMode !== "none") {
        const t = labelMode === "student" ? p.studentName(pin.studentId) : pin.rawTitle || "(untitled)";
        const hp = headPos(s.x, s.y);
        const tx = hp.x + pinSize * 0.6;
        const ty = hp.y + 4;
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(0,0,0,0.7)";
        ctx.strokeText(t, tx, ty);
        ctx.fillStyle = "white";
        ctx.fillText(t, tx, ty);
      }
    }

    // exposed for UI tests (tests/ui): where the drawn pins' points are
    canvas.dataset.pins = onScreen.join(";");

    // brush stroke + cursor
    const L = lassoRef.current;
    const brushColor = L?.brushMode === "remove" ? "#f97316" : "#facc15";
    if (L && L.brush) {
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = p.settings.brushPx * 2;
      ctx.strokeStyle = L.brushMode === "remove" ? "rgba(249,115,22,0.22)" : paintMode() ? hexA(p.settings.colors.paint, 0.3) : "rgba(250,204,21,0.22)";
      ctx.beginPath();
      L.pts.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)));
      if (L.pts.length === 1) ctx.lineTo(L.pts[0].x + 0.1, L.pts[0].y);
      ctx.stroke();
      ctx.restore();
    }
    const hv = hoverRef.current;
    if (hv && activeTool(p.settings) === "brush") {
      ctx.save();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = L?.brush ? brushColor : "rgba(255,255,255,0.9)";
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.arc(hv.x, hv.y, p.settings.brushPx, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = "rgba(0,0,0,0.6)";
      ctx.lineDashOffset = 3.5;
      ctx.stroke();
      ctx.restore();
    }

    // lasso
    if (L && !L.brush && L.pts.length > 1) {
      ctx.save();
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      const pc = paintMode() && !L.inverse;
      ctx.strokeStyle = L.inverse ? "#f97316" : pc ? p.settings.colors.paint : "#facc15";
      ctx.fillStyle = L.inverse ? "rgba(249,115,22,0.12)" : pc ? hexA(p.settings.colors.paint, 0.18) : "rgba(250,204,21,0.12)";
      ctx.beginPath();
      lassoPolygon(L).forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    // polygon in progress
    const PG = polyRef.current;
    if (PG && PG.pts.length) {
      const pts = PG.pts.map((q) => nmToScreen(q.x, q.y));
      const pc = paintMode() && !PG.inverse;
      const stroke = PG.inverse ? "#f97316" : pc ? p.settings.colors.paint : "#facc15";
      ctx.save();
      ctx.beginPath();
      pts.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)));
      if (hv) ctx.lineTo(hv.x, hv.y);
      ctx.closePath();
      ctx.fillStyle = PG.inverse ? "rgba(249,115,22,0.10)" : pc ? hexA(p.settings.colors.paint, 0.18) : "rgba(250,204,21,0.10)";
      ctx.fill();
      ctx.beginPath();
      pts.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)));
      if (hv) ctx.lineTo(hv.x, hv.y);
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(10,10,10,0.5)";
      ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = stroke;
      ctx.stroke();
      const nearFirst = hv && pts.length >= 3 && Math.hypot(hv.x - pts[0].x, hv.y - pts[0].y) <= 9;
      pts.forEach((pt, i) => {
        const r = i === 0 && nearFirst ? 6 : 3.5;
        ctx.fillStyle = i === 0 && nearFirst ? "#ffffff" : stroke;
        ctx.fillRect(pt.x - r, pt.y - r, r * 2, r * 2);
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(10,10,10,0.9)";
        ctx.strokeRect(pt.x - r, pt.y - r, r * 2, r * 2);
      });
      ctx.restore();
    }

    drawMeasures(ctx);
    drawHud(ctx, w, h);
    drawNavigator();
  }

  /** a painted area (strokes and polygons, erasures cut out) as one translucent layer */
  function drawArea(ctx: CanvasRenderingContext2D, w: number, h: number, dpr: number, ops: PaintOp[], color: string, alpha: number) {
    if (!ops.length) return;
    let pc = paintCanvas.current;
    if (!pc) pc = paintCanvas.current = document.createElement("canvas");
    if (pc.width !== Math.round(w * dpr) || pc.height !== Math.round(h * dpr)) {
      pc.width = Math.round(w * dpr);
      pc.height = Math.round(h * dpr);
    }
    const g = pc.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const k = pxPerNm();
    g.lineCap = "round";
    g.lineJoin = "round";
    for (const op of ops) {
      g.globalCompositeOperation = op.mode === "remove" ? "destination-out" : "source-over";
      g.fillStyle = g.strokeStyle = "#000";
      const pts = op.pts.map((q) => nmToScreen(q.x, q.y));
      g.beginPath();
      pts.forEach((pt, i) => (i ? g.lineTo(pt.x, pt.y) : g.moveTo(pt.x, pt.y)));
      if (op.kind === "poly") {
        g.closePath();
        g.fill();
      } else {
        if (pts.length === 1) g.lineTo(pts[0].x + 0.01, pts[0].y);
        g.lineWidth = op.rNm * k * 2;
        g.stroke();
      }
    }
    // tint the mask
    g.globalCompositeOperation = "source-in";
    g.fillStyle = color;
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = "source-over";
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = alpha;
    ctx.drawImage(pc, 0, 0);
    ctx.restore();
  }

  /** ruler measurements: numbered lines and outlines with their length / area, plus the one being drawn */
  function drawMeasures(ctx: CanvasRenderingContext2D) {
    const p = propsRef.current;
    const done = p.measures ?? [];
    const RD = rulerDrag.current;
    const RP = rulerPoly.current;
    if (!done.length && !RD && !RP) return;
    const label = (txt: string, x: number, y: number) => {
      ctx.font = `600 11.5px ${SANS}`;
      const w = ctx.measureText(txt).width + 12;
      ctx.fillStyle = "rgba(15,15,18,0.86)";
      ctx.beginPath();
      ctx.roundRect(x - w / 2, y - 10, w, 20, 6);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.fillText(txt, x, y + 4);
      ctx.textAlign = "start";
    };
    const stroke = (pts: { x: number; y: number }[], close: boolean, live = false) => {
      ctx.beginPath();
      pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      if (close) ctx.closePath();
      ctx.lineWidth = 4;
      ctx.strokeStyle = "rgba(0,0,0,0.55)";
      ctx.stroke();
      ctx.lineWidth = 2;
      ctx.setLineDash(live ? [6, 4] : []);
      ctx.strokeStyle = "#ffe066";
      ctx.stroke();
      ctx.setLineDash([]);
    };
    const tick = (a: { x: number; y: number }, b: { x: number; y: number }) => {
      // short end bars square to the line
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const nx = (-(b.y - a.y) / len) * 6, ny = ((b.x - a.x) / len) * 6;
      for (const q of [a, b]) stroke([{ x: q.x - nx, y: q.y - ny }, { x: q.x + nx, y: q.y + ny }], false);
    };
    ctx.save();
    done.forEach((m, i) => {
      const pts = m.pts.map((q) => nmToScreen(q.x, q.y));
      if (m.kind === "line") {
        stroke(pts, false);
        tick(pts[0], pts[1]);
        label(`${i + 1}  ${measureLabel(m)}`, (pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2 - 16);
      } else {
        ctx.beginPath();
        pts.forEach((q, j) => (j ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
        ctx.closePath();
        ctx.fillStyle = "rgba(255,224,102,0.14)";
        ctx.fill();
        stroke(pts, true);
        const c = centre(m.pts);
        const cs = nmToScreen(c.x, c.y);
        label(`${i + 1}  ${measureLabel(m)}`, cs.x, cs.y);
      }
    });
    if (RD) {
      stroke([RD.start, RD.cur], false, true);
      tick(RD.start, RD.cur);
      const nm = Math.hypot(RD.cur.x - RD.start.x, RD.cur.y - RD.start.y) / pxPerNm();
      label(fmtLength(nm), (RD.start.x + RD.cur.x) / 2, (RD.start.y + RD.cur.y) / 2 - 16);
    }
    if (RP) {
      const pts = RP.pts.map((q) => nmToScreen(q.x, q.y));
      const h = hoverRef.current;
      const live = h ? [...pts, h] : pts;
      stroke(live, false, true);
      for (const q of pts) {
        ctx.beginPath();
        ctx.arc(q.x, q.y, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = "#ffe066";
        ctx.fill();
      }
      if (h && RP.pts.length >= 2) {
        const nmPts = [...RP.pts, screenToNm(h)];
        const c = nmToScreen(centre(nmPts).x, centre(nmPts).y);
        label(fmtArea(area(nmPts)), c.x, c.y);
      }
    }
    ctx.restore();
  }

  /** slide readout (top-left) and a scale bar (bottom-right) */
  function drawHud(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const p = propsRef.current;
    if (!p.info) return;
    const pxPerUm = pxPerNm() * 1000;
    if (!Number.isFinite(pxPerUm) || pxPerUm <= 0) return;
    ctx.save();
    const ins = p.insets ?? { top: 0, right: 0, bottom: 0, left: 0 };
    ctx.font = `500 11px ${MONO}`;
    // readout: top-right of the uncovered area
    const t = `${p.slideLabel ?? p.info.id}  ·  ${(1 / pxPerUm).toFixed(2)} µm/px`;
    const tw = ctx.measureText(t).width + 18;
    const rx = w - ins.right - tw - 12, ry = ins.top + 10;
    ctx.fillStyle = "rgba(24,24,26,0.62)";
    roundRect(ctx, rx, ry, tw, 22, 11);
    ctx.fill();
    ctx.fillStyle = "#ececec";
    ctx.fillText(t, rx + 9, ry + 15);
    // scale bar: largest 1/2/5 × 10^n µm that fits in ~180 px
    const target = 180 / pxPerUm;
    const pow = 10 ** Math.floor(Math.log10(target));
    const um = [5, 2, 1].map((m) => m * pow).find((v) => v <= target) ?? pow;
    const len = um * pxPerUm;
    const label = um >= 1000 ? `${um / 1000} mm` : `${um} µm`;
    const bx = w - ins.right - 12 - len - 16, by = h - ins.bottom - 12 - 28;
    ctx.fillStyle = "rgba(24,24,26,0.62)";
    roundRect(ctx, bx, by, len + 16, 28, 9);
    ctx.fill();
    ctx.fillStyle = "#dddddd";
    ctx.fillText(label, bx + 8, by + 13);
    ctx.strokeStyle = "#e6e6e6";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(bx + 8.5, by + 18);
    ctx.lineTo(bx + 8.5, by + 22.5);
    ctx.lineTo(bx + 8.5 + len, by + 22.5);
    ctx.lineTo(bx + 8.5 + len, by + 18);
    ctx.stroke();
    ctx.restore();
  }

  function drawNavigator() {
    const v = viewerRef.current;
    const nc = navCanvasRef.current;
    const p = propsRef.current;
    const nav = v?.navigator as unknown as { viewport?: OpenSeadragon.Viewport; element: HTMLElement } | undefined;
    if (!v || !nc || !nav?.viewport || !p.info) return;
    const dpr = window.devicePixelRatio || 1;
    const w = nav.element.clientWidth;
    const h = nav.element.clientHeight;
    nc.style.width = w + "px";
    nc.style.height = h + "px";
    if (nc.width !== Math.round(w * dpr)) nc.width = Math.round(w * dpr);
    if (nc.height !== Math.round(h * dpr)) nc.height = Math.round(h * dpr);
    const ctx = nc.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!p.flagsVisible) return;
    for (const pin of p.pins) {
      const ip = nmToImage(pin.xNm, pin.yNm);
      const vp = v.viewport.imageToViewportCoordinates(new OpenSeadragon.Point(ip.x, ip.y));
      const s = nav.viewport.pixelFromPoint(vp, true);
      ctx.fillStyle = p.settings.colors[p.states.get(pin.id) ?? "ungraded"];
      ctx.fillRect(s.x - 1.5, s.y - 1.5, 3, 3);
    }
  }

  function lassoPolygon(L: NonNullable<typeof lassoRef.current>): Pt[] {
    if (!L.rect) return L.pts;
    const a = L.start;
    const b = L.pts[L.pts.length - 1];
    return [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
  }

  function fitPins(pinIds: string[]) {
    const v = viewerRef.current;
    const p = propsRef.current;
    if (!v || !p.info || !v.world.getItemCount()) {
      pendingFocus.current = pinIds;
      return;
    }
    const pins = p.pins.filter((x) => pinIds.includes(x.id)).concat(p.otherPins.filter((x) => pinIds.includes(x.id)));
    if (!pins.length) return;
    const pts = pins.map((x) => nmToImage(x.xNm, x.yNm));
    const pad = (p.settings.clusterPaddingUm / p.info.mppX) | 0;
    let x0 = Math.min(...pts.map((q) => q.x)) - pad;
    let x1 = Math.max(...pts.map((q) => q.x)) + pad;
    let y0 = Math.min(...pts.map((q) => q.y)) - pad;
    let y1 = Math.max(...pts.map((q) => q.y)) + pad;
    const minW = p.settings.singleFieldUm / p.info.mppX;
    if (x1 - x0 < minW) {
      const c = (x0 + x1) / 2;
      x0 = c - minW / 2;
      x1 = c + minW / 2;
    }
    if (y1 - y0 < minW * 0.6) {
      const c = (y0 + y1) / 2;
      y0 = c - minW * 0.3;
      y1 = c + minW * 0.3;
    }
    const rect = v.viewport.imageToViewportRectangle(new OpenSeadragon.Rect(x0, y0, x1 - x0, y1 - y0));
    v.viewport.fitBounds(rect, false);
  }

  // --- create / replace viewer when the slide changes ---
  useEffect(() => {
    const host = hostRef.current;
    const info = props.info;
    if (!host || !info) return;
    const v = OpenSeadragon({
      element: host,
      prefixUrl: "",
      showNavigationControl: false,
      showNavigator: true,
      navigatorPosition: "TOP_LEFT",
      viewportMargins: propsRef.current.insets ?? {},
      navigatorSizeRatio: 0.18,
      navigatorAutoFade: false,
      drawer: "canvas",
      crossOriginPolicy: "Anonymous",
      animationTime: propsRef.current.settings.animate ? 0.35 : 0,
      springStiffness: 9,
      maxZoomPixelRatio: 2.5,
      visibilityRatio: 0.2,
      imageLoaderLimit: 12,
      gestureSettingsMouse: {
        clickToZoom: false,
        dblClickToZoom: propsRef.current.settings.dblClickZoom,
        scrollToZoom: true,
      },
      zoomPerScroll: propsRef.current.settings.zoomPerScroll,
      tileSources: {
        width: info.width,
        height: info.height,
        tileSize: info.tileSize,
        tileOverlap: 0,
        minLevel: 0,
        maxLevel: info.maxLevel,
        getTileUrl: (level: number, x: number, y: number) => `${tileBase}/${info.id}/${level}/${x}_${y}.jpg`,
      },
    } as OpenSeadragon.Options);
    viewerRef.current = v;
    const navEl = (v.navigator as unknown as { element: HTMLElement }).element;
    const nc = document.createElement("canvas");
    nc.style.position = "absolute";
    nc.style.left = "0";
    nc.style.top = "0";
    nc.style.pointerEvents = "none";
    navEl.appendChild(nc);
    navCanvasRef.current = nc;
    navEl.style.display = propsRef.current.minimapVisible ? "block" : "none";

    // draw in the same frame OpenSeadragon draws the tiles, so markers stay planted while panning
    for (const ev of ["update-viewport", "animation", "viewport-change"] as const)
      v.addHandler(ev, () => {
        cancelAnimationFrame(rafRef.current);
        draw();
      });
    for (const ev of ["resize", "open"] as const) v.addHandler(ev, requestDraw);
    v.addHandler("open", () => {
      if (pendingFocus.current) {
        const ids = pendingFocus.current;
        pendingFocus.current = null;
        setTimeout(() => fitPins(ids), 50);
      }
    });
    v.addHandler("canvas-click", (e: OpenSeadragon.CanvasClickEvent) => {
      if (!e.quick) return;
      const hit = hitTest(e.position.x, e.position.y);
      const oe = e.originalEvent as MouseEvent;
      if (hit) {
        e.preventDefaultAction = true;
        clickPin(hit, oe.metaKey || oe.ctrlKey, oe.clientX, oe.clientY);
      }
    });

    // right-button lasso (captured before OpenSeadragon sees it)
    const rel = (e: PointerEvent): Pt => {
      const r = host.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    // which button selects (lasso / brush) and which pans; swappable in Preferences
    const selBtn = () => (propsRef.current.settings.swapMouse ? 0 : 2);
    const down = (e: PointerEvent) => {
      if (e.button === 0) {
        const pt = rel(e);
        const mode = clusterHit(pt);
        const c = propsRef.current.cluster;
        if (!mode || !c) {
          if (selBtn() !== 0) return;
        } else {
        e.stopPropagation();
        e.preventDefault();
        const c0 = { cx: c.cx, cy: c.cy, r: c.radiusNm };
        dragRef.current = { mode, start: pt, ...c0, c0 };
        host.setPointerCapture(e.pointerId);
        requestDraw();
        return;
        }
      }
      if (e.button === 2 && selBtn() === 0) {
        // swapped buttons: right-drag pans
        e.stopPropagation();
        e.preventDefault();
        const p = rel(e);
        panRef.current = { last: p, start: p, far: 0 };
        host.setPointerCapture(e.pointerId);
        return;
      }
      if (e.button !== selBtn()) return;
      e.stopPropagation();
      e.preventDefault();
      const p = rel(e);
      if (propsRef.current.ruler) {
        rulerDrag.current = { start: p, cur: p };
        host.setPointerCapture(e.pointerId);
        return;
      }
      const tool = activeTool(propsRef.current.settings);
      if (tool === "polygon") {
        // corners are placed on release (see up)
        polyDown = p;
        host.setPointerCapture(e.pointerId);
        return;
      }
      const brush = tool === "brush";
      lassoRef.current = {
        pts: [p],
        rect: !brush && e.altKey,
        inverse: !brush && e.shiftKey,
        add: !brush && (e.metaKey || e.ctrlKey),
        start: p,
        brush,
        brushMode: e.altKey ? "remove" : e.shiftKey ? "add" : "replace",
        painted: new Set(),
      };
      if (brush) paint(p, p, lassoRef.current.painted);
      host.setPointerCapture(e.pointerId);
      requestDraw();
    };
    let polyDown: Pt | null = null;
    const move = (e: PointerEvent) => {
      const p = rel(e);
      hoverRef.current = p;
      if (propsRef.current.ruler) {
        host.style.cursor = "crosshair";
        if (rulerDrag.current) {
          e.stopPropagation();
          rulerDrag.current.cur = p;
          requestDraw();
          return;
        }
        if (rulerPoly.current) requestDraw();
      }
      if (polyRef.current) requestDraw();
      if (propsRef.current.settings.spotlight && !lassoRef.current && !dragRef.current) {
        const id = hitTest(p.x, p.y)?.id ?? null;
        if (id !== spotRef.current) {
          spotRef.current = id;
          requestDraw();
        }
      }
      const pan = panRef.current;
      if (pan) {
        e.stopPropagation();
        v.viewport.panBy(v.viewport.deltaPointsFromPixels(new OpenSeadragon.Point(pan.last.x - p.x, pan.last.y - p.y)), true);
        pan.last = p;
        pan.far = Math.max(pan.far, Math.hypot(p.x - pan.start.x, p.y - pan.start.y));
        return;
      }
      const d = dragRef.current;
      if (d) {
        e.stopPropagation();
        const k = 1 / pxPerNm();
        if (d.mode === "move") {
          d.cx = d.c0.cx + (p.x - d.start.x) * k;
          d.cy = d.c0.cy + (p.y - d.start.y) * k;
        } else {
          const ctr = nmToScreen(d.cx, d.cy);
          d.r = Math.max(2000, Math.hypot(p.x - ctr.x, p.y - ctr.y) * k); // ≥ 2 µm
        }
        requestDraw();
        return;
      }
      if (!lassoRef.current) {
        const h = clusterHit(p);
        host.style.cursor = h === "move" ? "move" : h === "resize" ? "nwse-resize" : "";
      }
      const L = lassoRef.current;
      if (!L) {
        if (activeTool(propsRef.current.settings) === "brush") requestDraw();
        return;
      }
      e.stopPropagation();
      const last = L.pts[L.pts.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) > 3) {
        if (L.brush) paint(last, p, L.painted);
        L.pts.push(p);
      }
      if (!L.brush) L.inverse = e.shiftKey;
      requestDraw();
    };
    const leave = () => {
      hoverRef.current = null;
      spotRef.current = null;
      requestDraw();
    };
    const up = (e: PointerEvent) => {
      const pan = panRef.current;
      if (pan && e.button === 2) {
        e.stopPropagation();
        panRef.current = null;
        try {
          host.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
        v.viewport.applyConstraints();
        if (pan.far < 6) {
          // a right click without dragging acts like a plain click
          const hit = hitTest(pan.start.x, pan.start.y);
          if (hit) clickPin(hit, e.metaKey || e.ctrlKey, e.clientX, e.clientY);
          else if (propsRef.current.selection.size) propsRef.current.onEmptyRightClick(e.clientX, e.clientY);
        }
        return;
      }
      const d = dragRef.current;
      if (d && e.button === 0) {
        e.stopPropagation();
        dragRef.current = null;
        try {
          host.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
        if (d.cx !== d.c0.cx || d.cy !== d.c0.cy || d.r !== d.c0.r)
          propsRef.current.onClusterAdjust(d.cx, d.cy, d.r, pinsInCircle(d.cx, d.cy, d.r));
        requestDraw();
        return;
      }
      const RD = rulerDrag.current;
      if (RD && e.button === selBtn()) {
        e.stopPropagation();
        rulerDrag.current = null;
        try {
          host.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
        const p = rel(e);
        if (Math.hypot(p.x - RD.start.x, p.y - RD.start.y) >= 6) {
          // a drag: a distance
          rulerPoly.current = null;
          propsRef.current.onMeasure?.({ kind: "line", pts: [screenToNm(RD.start), screenToNm(p)] });
        } else {
          // a click: a corner of an outline; close it on the first corner or with a double-click
          const now = Date.now();
          const RP = rulerPoly.current;
          if (!RP) rulerPoly.current = { pts: [screenToNm(p)], last: now };
          else {
            const first = nmToScreen(RP.pts[0].x, RP.pts[0].y);
            const lastPt = RP.pts[RP.pts.length - 1];
            const last = nmToScreen(lastPt.x, lastPt.y);
            const onFirst = Math.hypot(p.x - first.x, p.y - first.y) < 10;
            const dbl = now - RP.last < 350 && Math.hypot(p.x - last.x, p.y - last.y) < 8;
            if (RP.pts.length >= 3 && (onFirst || dbl)) closeRuler();
            else if (!dbl) {
              RP.pts.push(screenToNm(p));
              RP.last = now;
            }
          }
        }
        requestDraw();
        return;
      }
      if (polyDown && e.button === selBtn()) {
        e.stopPropagation();
        polyDown = null;
        try {
          host.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
        const p = rel(e);
        const PG = polyRef.current;
        // corners go where you click, pins or not (the other button still clicks pins)
        if (!PG) {
          polyRef.current = { pts: [screenToNm(p)], add: e.metaKey || e.ctrlKey, inverse: e.shiftKey };
        } else {
          const scr = PG.pts.map((q) => nmToScreen(q.x, q.y));
          const last = scr[scr.length - 1];
          PG.inverse = e.shiftKey;
          // click the first vertex, or double-click, to close
          if (PG.pts.length >= 3 && (Math.hypot(p.x - scr[0].x, p.y - scr[0].y) <= 9 || Math.hypot(p.x - last.x, p.y - last.y) <= 4))
            return closePolygon(e.clientX, e.clientY);
          if (Math.hypot(p.x - last.x, p.y - last.y) > 4) PG.pts.push(screenToNm(p));
        }
        requestDraw();
        return;
      }
      const L = lassoRef.current;
      if (!L || e.button !== selBtn()) return;
      e.stopPropagation();
      lassoRef.current = null;
      try {
        host.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      const p = rel(e);
      const travelled = Math.max(...L.pts.map((q) => Math.hypot(q.x - L.start.x, q.y - L.start.y)), 0);
      if (paintMode()) {
        if (L.brush)
          propsRef.current.onPaint?.({
            kind: "brush",
            mode: L.brushMode === "remove" ? "remove" : "add",
            pts: L.pts.map(screenToNm),
            rNm: propsRef.current.settings.brushPx / pxPerNm(),
          });
        else if (travelled >= 6) finishPolygon(lassoPolygon(L), L, e.clientX, e.clientY);
        requestDraw();
        return;
      }
      const brushStroke =
        L.brush && (travelled >= 6 || L.painted.size > 1 || (L.brushMode !== "replace" && L.painted.size > 0));
      if (brushStroke) {
        const ids = [...liveSelection(L)];
        if (L.brushMode === "replace") propsRef.current.onLasso(ids, e.clientX, e.clientY);
        else propsRef.current.onSelect(ids);
        requestDraw();
        return;
      }
      if (travelled < 6) {
        const hit = hitTest(p.x, p.y);
        if (hit) clickPin(hit, L.add, e.clientX, e.clientY);
        else if (selBtn() !== 0) propsRef.current.onEmptyRightClick(e.clientX, e.clientY);
        requestDraw();
        return;
      }
      finishPolygon(lassoPolygon(L), L, e.clientX, e.clientY);
      requestDraw();
    };
    // polygon keys: ↵ closes, Esc cancels, ⌫ removes the last vertex (captured before the grader sees them)
    const closeRuler = () => {
      const RP = rulerPoly.current;
      rulerPoly.current = null;
      if (RP && RP.pts.length >= 3) propsRef.current.onMeasure?.({ kind: "area", pts: RP.pts });
    };
    const key = (e: KeyboardEvent) => {
      const RP = rulerPoly.current;
      if (RP) {
        // an outline in progress: ↵ closes, Esc cancels, ⌫ removes the last corner
        if (e.key === "Enter") closeRuler();
        else if (e.key === "Escape") rulerPoly.current = null;
        else if (e.key === "Backspace" || e.key === "Delete") {
          RP.pts.pop();
          if (!RP.pts.length) rulerPoly.current = null;
        } else return;
        e.preventDefault();
        e.stopImmediatePropagation();
        requestDraw();
        return;
      }
      const PG = polyRef.current;
      if (!PG) return;
      if (e.key === "Enter") closePolygon();
      else if (e.key === "Escape") polyRef.current = null;
      else if (e.key === "Backspace" || e.key === "Delete") {
        PG.pts.pop();
        if (!PG.pts.length) polyRef.current = null;
      } else return;
      e.preventDefault();
      e.stopImmediatePropagation();
      requestDraw();
    };
    window.addEventListener("keydown", key, true);
    const ctxmenu = (e: Event) => e.preventDefault();
    host.addEventListener("pointerdown", down, true);
    host.addEventListener("pointermove", move, true);
    host.addEventListener("pointerup", up, true);
    host.addEventListener("contextmenu", ctxmenu, true);
    host.addEventListener("pointerleave", leave);
    const ro = new ResizeObserver(requestDraw);
    ro.observe(host);

    return () => {
      ro.disconnect();
      window.removeEventListener("keydown", key, true);
      host.removeEventListener("pointerdown", down, true);
      host.removeEventListener("pointermove", move, true);
      host.removeEventListener("pointerup", up, true);
      host.removeEventListener("contextmenu", ctxmenu, true);
      host.removeEventListener("pointerleave", leave);
      v.destroy();
      viewerRef.current = null;
      navCanvasRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.info?.id]);

  if (props.apiRef)
    props.apiRef.current = {
      clientBounds: (ids) => {
        const v = viewerRef.current, host = hostRef.current;
        if (!v || !host || !propsRef.current.info) return null;
        const want = new Set(ids);
        const r = host.getBoundingClientRect();
        let l = Infinity, t = Infinity, rr = -Infinity, b = -Infinity;
        for (const pin of propsRef.current.pins) {
          if (!want.has(pin.id)) continue;
          const sp = nmToScreen(pin.xNm, pin.yNm);
          const hp = headPos(sp.x, sp.y);
          const z = propsRef.current.settings.pinSize;
          l = Math.min(l, sp.x, hp.x - z);
          rr = Math.max(rr, sp.x, hp.x + z);
          t = Math.min(t, sp.y, hp.y - z);
          b = Math.max(b, sp.y, hp.y + z);
        }
        if (!Number.isFinite(l)) return null;
        // keep it on screen even if the pins are partly scrolled away
        const cl = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
        return {
          left: r.left + cl(l, 0, r.width),
          right: r.left + cl(rr, 0, r.width),
          top: r.top + cl(t, 0, r.height),
          bottom: r.top + cl(b, 0, r.height),
        };
      },
    };

  // redraw whenever anything visual changes
  useEffect(requestDraw);

  // switching tool or slide abandons a half-drawn polygon
  const tool = activeTool(props.settings);
  useEffect(() => {
    polyRef.current = null;
  }, [tool, props.info?.id]);
  // an outline being measured is dropped when the ruler is switched off or the slide changes
  useEffect(() => {
    rulerPoly.current = null;
    rulerDrag.current = null;
  }, [props.ruler, props.info?.id]);

  useEffect(() => {
    const v = viewerRef.current;
    if (!v) return;
    const el = (v.navigator as unknown as { element: HTMLElement }).element;
    el.style.display = props.minimapVisible ? "block" : "none";
  }, [props.minimapVisible]);

  // mouse / zoom preferences apply to the open viewer without reloading the slide
  const { zoomPerScroll, dblClickZoom, animate } = props.settings;
  useEffect(() => {
    const v = viewerRef.current as (OpenSeadragon.Viewer & { zoomPerScroll: number; gestureSettingsMouse: { dblClickToZoom: boolean } }) | null;
    if (!v) return;
    v.zoomPerScroll = zoomPerScroll;
    v.gestureSettingsMouse.dblClickToZoom = dblClickZoom;
    const t = animate ? 0.35 : 0;
    const vp = v.viewport as unknown as Record<string, { animationTime: number }>;
    for (const k of ["centerSpringX", "centerSpringY", "zoomSpring"]) if (vp[k]) vp[k].animationTime = t;
  }, [zoomPerScroll, dblClickZoom, animate, props.info?.id]);

  useEffect(() => {
    if (props.focus) fitPins(props.focus.pinIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.focus?.nonce]);

  useEffect(() => {
    if (props.homeNonce) viewerRef.current?.viewport.goHome();
  }, [props.homeNonce]);

  const ins = props.insets;
  useEffect(() => {
    const v = viewerRef.current;
    if (v && ins) (v.viewport as unknown as { setMargins: (m: object) => void }).setMargins(ins);
  }, [ins?.top, ins?.right, ins?.bottom, ins?.left]);

  return (
    <div className="viewer-wrap">
      <div ref={hostRef} className="viewer-host" />
      <canvas ref={canvasRef} className="viewer-overlay" />
      {!props.info && (
        <div className="viewer-empty">{props.error ? `Could not open slide: ${props.error}` : "Loading slide…"}</div>
      )}
    </div>
  );
}
