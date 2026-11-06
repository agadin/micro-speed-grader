import { useEffect, useRef } from "react";
import OpenSeadragon from "openseadragon";
import type { Pin, SlideInfo } from "../lib/types";
import type { Cluster } from "../lib/cluster";
import type { PinState } from "../lib/grading";
import type { Settings } from "../lib/settings";
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
  selection: Set<string>;
  cluster: Cluster | null;
  isolate: boolean;
  flagsVisible: boolean;
  minimapVisible: boolean;
  settings: Settings;
  studentName: (id: string) => string;
  focus: { pinIds: string[]; nonce: number } | null;
  onLasso: (pinIds: string[], inverse: boolean, clientX: number, clientY: number) => void;
  /** brush with ⇧/⌥: refine the selection without opening the menu */
  onSelect: (pinIds: string[]) => void;
  onPinClick: (pinId: string, clientX: number, clientY: number) => void;
  onEmptyRightClick: (clientX: number, clientY: number) => void;
  onEmptyClick: () => void;
  /** the user dragged/resized the cluster circle; ids = ungraded pins now inside it */
  onClusterAdjust: (cx: number, cy: number, radiusNm: number, pinIds: string[]) => void;
  homeNonce: number;
}

type Pt = { x: number; y: number };
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
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
  /** left-drag on the cluster label (move) or its edge/knob (resize) */
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
    return p.isolate ? p.pins.filter((x) => p.selection.has(x.id)) : p.pins;
  };

  /** centre of a marker's visible head (flag cloth / pin head), relative to its point */
  const headPos = (x: number, y: number): Pt => {
    const { pinStyle, pinSize: z } = propsRef.current.settings;
    if (pinStyle === "flag") return { x: x + z * 0.45, y: y - z * 1.15 };
    if (pinStyle === "pushpin") return { x: x + z * 0.62, y: y - z * 0.62 };
    return { x, y };
  };

  const hitTest = (sx: number, sy: number): Pin | null => {
    const p = propsRef.current;
    const size = p.settings.pinSize;
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
    const { colors, pinSize, pinStyle, labelMode } = p.settings;

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

    const pins = visiblePins();
    const sel = liveSelection();
    // draw ungraded/selected last so they sit on top
    const order = [...pins].sort((a, b) => Number(sel.has(a.id)) - Number(sel.has(b.id)));
    ctx.font = `11px ${MONO}`;
    for (const pin of order) {
      const s = nmToScreen(pin.xNm, pin.yNm);
      if (s.x < -40 || s.y < -40 || s.x > w + 40 || s.y > h + 40) continue;
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
      drawMarker(ctx, s.x, s.y, selected && st !== "ungraded" ? colors[st] : color, pinSize, pinStyle);
      if (st === "double" || pin.q === null) {
        const t = st === "double" ? "2" : "?";
        const hp = headPos(s.x, s.y);
        const bx = hp.x + pinSize * 0.5, by = hp.y - pinSize * 0.2;
        ctx.fillStyle = "rgba(15,15,15,0.9)";
        ctx.fillRect(bx - 1, by - 8, 10, 11);
        ctx.fillStyle = st === "double" ? colors.double : "#f0f0f0";
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

    // brush stroke + cursor
    const L = lassoRef.current;
    const brushColor = L?.brushMode === "remove" ? "#f97316" : "#facc15";
    if (L && L.brush) {
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = p.settings.brushPx * 2;
      ctx.strokeStyle = L.brushMode === "remove" ? "rgba(249,115,22,0.22)" : "rgba(250,204,21,0.22)";
      ctx.beginPath();
      L.pts.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)));
      if (L.pts.length === 1) ctx.lineTo(L.pts[0].x + 0.1, L.pts[0].y);
      ctx.stroke();
      ctx.restore();
    }
    const hv = hoverRef.current;
    if (hv && p.settings.selectTool === "brush") {
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
      ctx.strokeStyle = L.inverse ? "#f97316" : "#facc15";
      ctx.fillStyle = L.inverse ? "rgba(249,115,22,0.12)" : "rgba(250,204,21,0.12)";
      ctx.beginPath();
      lassoPolygon(L).forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    drawHud(ctx, w, h);
    drawNavigator();
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
      animationTime: 0.35,
      springStiffness: 9,
      maxZoomPixelRatio: 2.5,
      visibilityRatio: 0.2,
      imageLoaderLimit: 12,
      gestureSettingsMouse: { clickToZoom: false, dblClickToZoom: true, scrollToZoom: true },
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
        if (oe.metaKey || oe.ctrlKey) {
          // ⌘/Ctrl-click toggles the pin in the current selection
          const sel = new Set(propsRef.current.selection);
          if (sel.has(hit.id)) sel.delete(hit.id);
          else sel.add(hit.id);
          propsRef.current.onSelect([...sel]);
        } else propsRef.current.onPinClick(hit.id, oe.clientX, oe.clientY);
      } else propsRef.current.onEmptyClick();
    });

    // right-button lasso (captured before OpenSeadragon sees it)
    const rel = (e: PointerEvent): Pt => {
      const r = host.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const down = (e: PointerEvent) => {
      if (e.button === 0) {
        const pt = rel(e);
        const mode = clusterHit(pt);
        const c = propsRef.current.cluster;
        if (!mode || !c) return;
        e.stopPropagation();
        e.preventDefault();
        const c0 = { cx: c.cx, cy: c.cy, r: c.radiusNm };
        dragRef.current = { mode, start: pt, ...c0, c0 };
        host.setPointerCapture(e.pointerId);
        requestDraw();
        return;
      }
      if (e.button !== 2) return;
      e.stopPropagation();
      e.preventDefault();
      const p = rel(e);
      const brush = propsRef.current.settings.selectTool === "brush";
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
    const move = (e: PointerEvent) => {
      const p = rel(e);
      hoverRef.current = p;
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
        if (propsRef.current.settings.selectTool === "brush") requestDraw();
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
      requestDraw();
    };
    const up = (e: PointerEvent) => {
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
      const L = lassoRef.current;
      if (!L || e.button !== 2) return;
      e.stopPropagation();
      lassoRef.current = null;
      try {
        host.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      const p = rel(e);
      const travelled = Math.max(...L.pts.map((q) => Math.hypot(q.x - L.start.x, q.y - L.start.y)), 0);
      const brushStroke =
        L.brush && (travelled >= 6 || L.painted.size > 1 || (L.brushMode !== "replace" && L.painted.size > 0));
      if (brushStroke) {
        const ids = [...liveSelection(L)];
        if (L.brushMode === "replace") propsRef.current.onLasso(ids, false, e.clientX, e.clientY);
        else propsRef.current.onSelect(ids);
        requestDraw();
        return;
      }
      if (travelled < 6) {
        const hit = hitTest(p.x, p.y);
        if (hit) propsRef.current.onPinClick(hit.id, e.clientX, e.clientY);
        else propsRef.current.onEmptyRightClick(e.clientX, e.clientY);
        requestDraw();
        return;
      }
      const poly = lassoPolygon(L);
      const inside = (pt: Pt) => {
        let c = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const a = poly[i], b = poly[j];
          if (a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) c = !c;
        }
        return c;
      };
      const ids = visiblePins()
        .filter((pin) => inside(nmToScreen(pin.xNm, pin.yNm)) !== L.inverse)
        .map((pin) => pin.id);
      if (L.add) propsRef.current.onSelect([...new Set([...propsRef.current.selection, ...ids])]);
      else propsRef.current.onLasso(ids, L.inverse, e.clientX, e.clientY);
      requestDraw();
    };
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

  useEffect(() => {
    const v = viewerRef.current;
    if (!v) return;
    const el = (v.navigator as unknown as { element: HTMLElement }).element;
    el.style.display = props.minimapVisible ? "block" : "none";
  }, [props.minimapVisible]);

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
