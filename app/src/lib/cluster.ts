import type { Pin } from "./types";

export interface Cluster {
  label: string;
  /** centre in nm */
  cx: number;
  cy: number;
  radiusNm: number;
  pinIds: string[];
  single: boolean;
}

export function clusterLabel(i: number): string {
  let s = "";
  i += 1;
  while (i > 0) {
    const r = (i - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

/**
 * Greedy density clustering: repeatedly take the pin with the most neighbours
 * within `radiusUm`, centre a circle on the neighbourhood mean, and claim
 * every pin inside that circle. Largest clusters come first; anything smaller
 * than `minSize` is returned afterwards as single-pin "clusters" so the grader
 * can step through stragglers one at a time.
 */
export function computeClusters(pins: Pin[], radiusUm: number, minSize: number): Cluster[] {
  const r = Math.max(1, radiusUm) * 1000;
  const r2 = r * r;
  const remaining = new Set(pins.map((p) => p.id));
  const byId = new Map(pins.map((p) => [p.id, p]));
  const clusters: Cluster[] = [];
  const singles: Pin[] = [];

  const within = (cx: number, cy: number) => {
    const out: Pin[] = [];
    for (const id of remaining) {
      const p = byId.get(id)!;
      const dx = p.xNm - cx;
      const dy = p.yNm - cy;
      if (dx * dx + dy * dy <= r2) out.push(p);
    }
    return out;
  };

  while (remaining.size) {
    let best: Pin | null = null;
    let bestN = -1;
    for (const id of remaining) {
      const p = byId.get(id)!;
      const n = within(p.xNm, p.yNm).length;
      if (n > bestN) {
        bestN = n;
        best = p;
      }
    }
    if (!best || bestN < Math.max(2, minSize)) break;
    let members = within(best.xNm, best.yNm);
    // one refinement step: recentre on the mean
    let cx = members.reduce((s, p) => s + p.xNm, 0) / members.length;
    let cy = members.reduce((s, p) => s + p.yNm, 0) / members.length;
    const refined = within(cx, cy);
    if (refined.length >= members.length) {
      members = refined;
      cx = members.reduce((s, p) => s + p.xNm, 0) / members.length;
      cy = members.reduce((s, p) => s + p.yNm, 0) / members.length;
    }
    for (const p of members) remaining.delete(p.id);
    clusters.push({ label: "", cx, cy, radiusNm: r, pinIds: members.map((p) => p.id), single: false });
  }
  for (const id of remaining) singles.push(byId.get(id)!);

  clusters.sort((a, b) => b.pinIds.length - a.pinIds.length);
  clusters.forEach((c, i) => (c.label = clusterLabel(i)));
  singles.sort((a, b) => a.yNm - b.yNm || a.xNm - b.xNm);
  singles.forEach((p, i) =>
    clusters.push({ label: `#${i + 1}`, cx: p.xNm, cy: p.yNm, radiusNm: r, pinIds: [p.id], single: true }),
  );
  return clusters;
}
