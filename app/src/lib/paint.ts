import type { Pin } from "./types";

/**
 * "Paint with pins hidden": strokes the grader lays down while pins are hidden.
 * Kept in slide coordinates (nm) so the region stays put while panning / zooming.
 * Ops apply in order: "add" paints, "remove" (⌥) erases.
 */
export type PaintOp =
  | { kind: "brush"; mode: "add" | "remove"; pts: { x: number; y: number }[]; rNm: number }
  | { kind: "poly"; mode: "add" | "remove"; pts: { x: number; y: number }[] };

function distToSeg(px: number, py: number, a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2)) : 0;
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

export function pointInPolygon(x: number, y: number, poly: { x: number; y: number }[]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

export function opContains(op: PaintOp, x: number, y: number): boolean {
  if (op.kind === "poly") return op.pts.length >= 3 && pointInPolygon(x, y, op.pts);
  if (op.pts.length === 1) return Math.hypot(x - op.pts[0].x, y - op.pts[0].y) <= op.rNm;
  for (let i = 1; i < op.pts.length; i++) if (distToSeg(x, y, op.pts[i - 1], op.pts[i]) <= op.rNm) return true;
  return false;
}

export function isPainted(ops: PaintOp[], x: number, y: number): boolean {
  let inside = false;
  for (const op of ops) if (opContains(op, x, y)) inside = op.mode === "add";
  return inside;
}

export const pinsInPaint = (pins: Pin[], ops: PaintOp[]) =>
  ops.length ? pins.filter((p) => isPainted(ops, p.xNm, p.yNm)).map((p) => p.id) : [];
