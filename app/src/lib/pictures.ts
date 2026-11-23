/**
 * Picture reports (Export ▸ Pictures, turned on in Preferences ▸ Export):
 *  - picture feedback: one HTML page per student, each answer shown on a crop of the slide with the
 *    student's pin, the correct area (answer key) or where the class's correct pins are;
 *  - wrong-answer maps: for each question on each slide, every graded pin, wrong ones coloured by
 *    the reason they were given.
 * The geometry (what to crop, which pins, which colours) is plain functions, tested in logic.test.ts.
 * Drawing reads the slide's Deep-Zoom tiles over the slide:// protocol into a canvas.
 */
import type { KeyMark } from "./answerKey";
import { effectiveQ, taskId } from "./grading";
import type { PaintOp } from "./paint";
import type { GradeState, Pin, Session, SlideInfo } from "./types";

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** pins answering question q on this slide */
export const pinsFor = (s: Pick<Session, "pins" | "grades">, q: number, slide: string) =>
  s.pins.filter((p) => p.slide === slide && effectiveQ(p, s.grades) === q);

/** the grade a pin was given, if any */
export function verdict(p: Pin, g: GradeState): { status: "correct" | "wrong"; text: string } | null {
  const grp = g.groups[g.pinGroup[p.id]];
  return grp ? { status: grp.status, text: grp.text.trim() } : null;
}

const median = (xs: number[]) => {
  const v = [...xs].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const quantile = (xs: number[], t: number) => {
  const v = [...xs].sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.max(0, Math.round(t * (v.length - 1))))];
};

/** every point of a mark's painted strokes, widened by the brush radius */
export function opsBox(ops: PaintOp[]): Box | null {
  let b: Box | null = null;
  for (const op of ops) {
    if (op.mode !== "add") continue;
    const r = op.kind === "brush" ? op.rNm : 0;
    for (const p of op.pts) b = grow(b, { x0: p.x - r, y0: p.y - r, x1: p.x + r, y1: p.y + r });
  }
  return b;
}
const grow = (b: Box | null, c: Box): Box =>
  b ? { x0: Math.min(b.x0, c.x0), y0: Math.min(b.y0, c.y0), x1: Math.max(b.x1, c.x1), y1: Math.max(b.y1, c.y1) } : c;
const pt = (x: number, y: number): Box => ({ x0: x, y0: y, x1: x, y1: y });

/**
 * Where the right answer is, to show next to a student's pin: the answer key's correct areas when
 * there are any, else the middle of the class's correct pins (the median, so a few stray ones
 * don't move it).
 */
export function correctRef(marks: KeyMark[], correctPins: Pin[]): { box: Box; from: "key" | "class" } | null {
  let b: Box | null = null;
  for (const m of marks) {
    const k = m.kind === "correct" ? opsBox(m.ops) : null;
    if (k) b = grow(b, k);
  }
  if (b) return { box: b, from: "key" };
  if (!correctPins.length) return null;
  const x = median(correctPins.map((p) => p.xNm)), y = median(correctPins.map((p) => p.yNm));
  return { box: pt(x, y), from: "class" };
}

/**
 * The crop for one student's answer: their pin and the correct area, with a margin, at least
 * `minNm` across, shaped to `aspect` (width / height). Too far apart (more than `maxNm`) and the crop
 * stays on the student's pin alone, so the picture still shows what they marked.
 */
export function answerCrop(pin: { xNm: number; yNm: number }, ref: Box | null, aspect = 4 / 3, minNm = 150_000, maxNm = 3_000_000): Box {
  let b = pt(pin.xNm, pin.yNm);
  if (ref) {
    const both = grow(b, ref);
    if (Math.max(both.x1 - both.x0, both.y1 - both.y0) <= maxNm) b = both;
  }
  return shape(b, 0.3, minNm, aspect);
}

/** pad a box by `pad` of its size, make it at least `minNm` wide, and give it the aspect ratio */
export function shape(b: Box, pad: number, minNm: number, aspect: number): Box {
  let w = (b.x1 - b.x0) * (1 + 2 * pad), h = (b.y1 - b.y0) * (1 + 2 * pad);
  w = Math.max(w, minNm, h * aspect);
  h = w / aspect;
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  return { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
}

/** the crop for a wrong-answer map: the bulk of the graded pins (2nd–98th percentile) and the key's areas */
export function mapCrop(pins: Pin[], marks: KeyMark[], aspect = 4 / 3): Box | null {
  let b: Box | null = null;
  if (pins.length) {
    const xs = pins.map((p) => p.xNm), ys = pins.map((p) => p.yNm);
    const lo = pins.length >= 20 ? 0.02 : 0, hi = 1 - lo;
    b = { x0: quantile(xs, lo), y0: quantile(ys, lo), x1: quantile(xs, hi), y1: quantile(ys, hi) };
  }
  for (const m of marks) {
    const k = opsBox(m.ops);
    if (k) b = grow(b, k);
  }
  return b && shape(b, 0.12, 200_000, aspect);
}

/** wrong-answer colours, most common reason first; everything after them is "Other" */
export const REASON_COLORS = ["#e4572e", "#f3a712", "#a846a0", "#2e86ab", "#d81159", "#6b4226"];
export const OTHER_COLOR = "#8a8a8a";
export const CORRECT_COLOR = "#3fa34d";

export interface MapLegend {
  /** reasons in colour order, with how many pins */
  reasons: { text: string; n: number; color: string }[];
  other: number;
  correct: number;
  wrong: number;
  /** pin id → colour */
  color: Map<string, string>;
}

/** group the graded pins of one question on one slide by reason (ignoring capitals) */
export function mapLegend(pins: Pin[], g: GradeState, noReason = "(no reason)"): MapLegend {
  const by = new Map<string, { text: string; ids: string[] }>();
  const color = new Map<string, string>();
  let correct = 0, wrong = 0;
  for (const p of pins) {
    const v = verdict(p, g);
    if (!v) continue;
    if (v.status === "correct") {
      correct++;
      color.set(p.id, CORRECT_COLOR);
      continue;
    }
    wrong++;
    const text = v.text || noReason;
    const k = text.toLowerCase();
    const e = by.get(k) ?? by.set(k, { text, ids: [] }).get(k)!;
    e.ids.push(p.id);
  }
  const ranked = [...by.values()].sort((a, b) => b.ids.length - a.ids.length || a.text.localeCompare(b.text));
  const reasons = ranked.slice(0, REASON_COLORS.length).map((r, i) => {
    r.ids.forEach((id) => color.set(id, REASON_COLORS[i]));
    return { text: r.text, n: r.ids.length, color: REASON_COLORS[i] };
  });
  let other = 0;
  for (const r of ranked.slice(REASON_COLORS.length)) {
    other += r.ids.length;
    r.ids.forEach((id) => color.set(id, OTHER_COLOR));
  }
  return { reasons, other, correct, wrong, color };
}

/** the answer key's marks for a question on a slide */
export const marksFor = (s: Pick<Session, "key">, q: number, slide: string) =>
  (s.key?.marks ?? []).filter((m) => m.q === q && m.slide === slide);

export const mapId = (q: number, slide: string) => taskId(q, slide);

export const escapeHtml = (t: string) =>
  t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// ---------------------------------------------------------------- drawing (browser only)

/** slide nm → full-resolution image pixels */
export const nmToImage = (i: SlideInfo, xNm: number, yNm: number) => ({
  x: (xNm - i.xOffsetNm) / (i.mppX * 1000) + i.width / 2,
  y: (yNm - i.yOffsetNm) / (i.mppY * 1000) + i.height / 2,
});

/** Loads tiles once per run; keeps the most recent few hundred. */
export class TileCache {
  private m = new Map<string, Promise<HTMLImageElement | null>>();
  constructor(private base: string, private limit = 600) {}
  get(info: SlideInfo, level: number, x: number, y: number) {
    const url = `${this.base}/${info.id}/${level}/${x}_${y}.jpg`;
    let p = this.m.get(url);
    if (!p) {
      p = new Promise((res) => {
        const im = new Image();
        im.crossOrigin = "anonymous";
        im.onload = () => res(im);
        im.onerror = () => res(null);
        im.src = url;
      });
      this.m.set(url, p);
      if (this.m.size > this.limit) this.m.delete(this.m.keys().next().value!);
    }
    return p;
  }
}

/** A crop of the slide (box in nm) drawn into a w × h canvas, and a function placing nm points on it. */
export async function drawRegion(info: SlideInfo, box: Box, w: number, h: number, tiles: TileCache) {
  const a = nmToImage(info, box.x0, box.y0), b = nmToImage(info, box.x1, box.y1);
  const ix0 = Math.min(a.x, b.x), iy0 = Math.min(a.y, b.y), iw = Math.abs(b.x - a.x), ih = Math.abs(b.y - a.y);
  const scale = w / iw; // canvas px per image px
  // the coarsest level that still has at least one image pixel per canvas pixel
  const down = Math.max(0, Math.min(info.maxLevel, Math.floor(Math.log2(1 / scale))));
  const level = info.maxLevel - down, ds = 2 ** down, ts = info.tileSize;
  const lw = Math.ceil(info.width / ds), lh = Math.ceil(info.height / ds);
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d")!;
  ctx.fillStyle = "#f4f2ee";
  ctx.fillRect(0, 0, w, h);
  const lx0 = ix0 / ds, ly0 = iy0 / ds, lx1 = (ix0 + iw) / ds, ly1 = (iy0 + ih) / ds;
  const k = scale * ds; // canvas px per level px
  const jobs: Promise<void>[] = [];
  for (let ty = Math.max(0, Math.floor(ly0 / ts)); ty <= Math.min(Math.ceil(lh / ts) - 1, Math.floor(ly1 / ts)); ty++)
    for (let tx = Math.max(0, Math.floor(lx0 / ts)); tx <= Math.min(Math.ceil(lw / ts) - 1, Math.floor(lx1 / ts)); tx++)
      jobs.push(
        tiles.get(info, level, tx, ty).then((im) => {
          if (im) ctx.drawImage(im, (tx * ts - lx0) * k, (ty * ts - ly0) * k, im.width * k, im.height * k);
        }),
      );
  await Promise.all(jobs);
  const at = (xNm: number, yNm: number) => {
    const p = nmToImage(info, xNm, yNm);
    return { x: (p.x - ix0) * scale, y: (p.y - iy0) * scale };
  };
  /** canvas px per nm */
  const pxPerNm = scale / (info.mppX * 1000);
  return { cv, ctx, at, pxPerNm };
}

/** answer-key areas, translucent, with erasing strokes cut out */
export function drawMarks(ctx: CanvasRenderingContext2D, marks: KeyMark[], at: (x: number, y: number) => { x: number; y: number }, pxPerNm: number, color: string) {
  const { width: w, height: h } = ctx.canvas;
  const layer = document.createElement("canvas");
  layer.width = w;
  layer.height = h;
  const l = layer.getContext("2d")!;
  l.lineCap = l.lineJoin = "round";
  for (const m of marks)
    for (const op of m.ops) {
      l.globalCompositeOperation = op.mode === "add" ? "source-over" : "destination-out";
      l.fillStyle = l.strokeStyle = color;
      const pts = op.pts.map((p) => at(p.x, p.y));
      if (!pts.length) continue;
      l.beginPath();
      if (op.kind === "poly") {
        pts.forEach((p, i) => (i ? l.lineTo(p.x, p.y) : l.moveTo(p.x, p.y)));
        l.closePath();
        l.fill();
      } else {
        l.lineWidth = 2 * op.rNm * pxPerNm;
        if (pts.length === 1) {
          l.arc(pts[0].x, pts[0].y, op.rNm * pxPerNm, 0, Math.PI * 2);
          l.fill();
        } else {
          pts.forEach((p, i) => (i ? l.lineTo(p.x, p.y) : l.moveTo(p.x, p.y)));
          l.stroke();
        }
      }
    }
  ctx.save();
  ctx.globalAlpha = 0.32;
  ctx.drawImage(layer, 0, 0);
  ctx.restore();
}

export function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string, ring = "#fff") {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = Math.max(1, r / 3);
  ctx.strokeStyle = ring;
  ctx.stroke();
}

/** a map pin: a teardrop pointing at the spot */
export function flag(ctx: CanvasRenderingContext2D, x: number, y: number, fill: string, label?: string) {
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(-4, -8, -11, -13, -11, -21);
  ctx.arc(0, -21, 11, Math.PI, 0);
  ctx.bezierCurveTo(11, -13, 4, -8, 0, 0);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = "#fff";
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, -21, 4, 0, Math.PI * 2);
  ctx.fillStyle = "#fff";
  ctx.fill();
  if (label) {
    ctx.font = "600 13px -apple-system, Segoe UI, sans-serif";
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = "rgba(0,0,0,.72)";
    ctx.fillRect(14, -30, tw + 12, 20);
    ctx.fillStyle = "#fff";
    ctx.fillText(label, 20, -15);
  }
  ctx.restore();
}

/** a scale bar in the bottom-left corner */
export function scaleBar(ctx: CanvasRenderingContext2D, pxPerNm: number) {
  const { height: h } = ctx.canvas;
  const target = 120 / pxPerNm / 1000; // µm in ~120 px
  const um = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000].reduce((a, b) => (b <= target ? b : a), 1);
  const px = um * 1000 * pxPerNm;
  ctx.fillStyle = "rgba(255,255,255,.8)";
  ctx.fillRect(10, h - 34, px + 20, 24);
  ctx.fillStyle = "#111";
  ctx.fillRect(20, h - 18, px, 3);
  ctx.font = "11px -apple-system, Segoe UI, sans-serif";
  ctx.fillText(um >= 1000 ? `${um / 1000} mm` : `${um} µm`, 20, h - 22);
}
