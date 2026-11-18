/**
 * Ruler: distances and areas measured on the slide. Points are in slide coordinates (nm), so a
 * measurement stays put while panning and zooming. Measurements aren't saved and don't affect grades.
 */
export type Pt = { x: number; y: number };
export type Measure = { kind: "line"; pts: [Pt, Pt] } | { kind: "area"; pts: Pt[] };

export const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);

/** perimeter of a closed outline (nm) */
export const perimeter = (pts: Pt[]) => pts.reduce((s, p, i) => s + dist(p, pts[(i + 1) % pts.length]), 0);

/** area of a closed outline (nm², shoelace; any winding) */
export function area(pts: Pt[]) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/** where to put an outline's label: the average of its corners */
export const centre = (pts: Pt[]): Pt => ({
  x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
  y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
});

const num = (v: number) => (v >= 100 ? Math.round(v).toLocaleString("en-US") : v >= 10 ? v.toFixed(1) : v.toFixed(2));

/** a length in nm as people read it: "8.40 µm", "245 µm", "1.24 mm" */
export function fmtLength(nm: number) {
  const um = nm / 1000;
  return um >= 1000 ? `${num(um / 1000)} mm` : `${num(um)} µm`;
}

/** an area in nm²: "520 µm²", "0.031 mm²" (1 mm² = 10⁶ µm²) */
export function fmtArea(nm2: number) {
  const um2 = nm2 / 1e6;
  return um2 >= 1e5 ? `${num(um2 / 1e6)} mm²` : `${num(um2)} µm²`;
}

/** the label a measurement shows */
export const measureLabel = (m: Measure) =>
  m.kind === "line" ? fmtLength(dist(m.pts[0], m.pts[1])) : `${fmtArea(area(m.pts))} · perimeter ${fmtLength(perimeter(m.pts))}`;
