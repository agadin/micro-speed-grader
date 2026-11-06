/** Parsing of Hamamatsu NDP.view annotation files (.ndpa). */

export interface RawAnnotation {
  title: string;
  details: string;
  type: string;
  xNm: number;
  yNm: number;
}

const text = (el: Element | null | undefined) => (el?.textContent ?? "").trim();

export function parseNdpa(xml: string): RawAnnotation[] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("Invalid annotation XML");
  const out: RawAnnotation[] = [];
  for (const vs of Array.from(doc.getElementsByTagName("ndpviewstate"))) {
    const title = text(vs.getElementsByTagName("title")[0]);
    const details = text(vs.getElementsByTagName("details")[0]);
    for (const ann of Array.from(vs.getElementsByTagName("annotation"))) {
      const type = ann.getAttribute("type") ?? "pin";
      let x: number, y: number;
      const direct = Array.from(ann.children);
      const dx = direct.find((c) => c.tagName === "x");
      const dy = direct.find((c) => c.tagName === "y");
      if (dx && dy) {
        x = Number(text(dx));
        y = Number(text(dy));
      } else {
        // shapes (circle/freehand): use centroid of the point list, or the centre tag
        const pts = Array.from(ann.getElementsByTagName("point")).map((p) => [
          Number(text(p.getElementsByTagName("x")[0])),
          Number(text(p.getElementsByTagName("y")[0])),
        ]);
        if (!pts.length) continue;
        x = pts.reduce((s, p) => s + p[0], 0) / pts.length;
        y = pts.reduce((s, p) => s + p[1], 0) / pts.length;
      }
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      out.push({ title, details, type, xNm: x, yNm: y });
    }
  }
  return out;
}

/** "VMS146.ndpi.ndpa" -> "VMS146" */
export function slideIdFromFilename(name: string): string | null {
  const m = name.match(/(VMS\d+)/i);
  if (m) return m[1].toUpperCase();
  const base = name.replace(/\.ndpa$/i, "").replace(/\.(ndpi|svs|tiff?|mrxs|scn)$/i, "");
  return base || null;
}

/**
 * Read a question number out of a free-text pin title.
 * Returns the number if it is a valid question for this slide; otherwise null.
 */
export function matchTitle(title: string, slideQuestions: number[]): { q: number | null; clean: boolean } {
  const t = title.trim();
  const strict = t.match(/^q\s*(\d+)$/i);
  if (strict && slideQuestions.includes(Number(strict[1]))) return { q: Number(strict[1]), clean: true };
  const qish = t.match(/\bq(?:uestion)?\s*#?\s*(\d+)/i) ?? t.match(/q(\d+)/i);
  if (qish && slideQuestions.includes(Number(qish[1]))) return { q: Number(qish[1]), clean: false };
  const nums = (t.match(/\d+/g) ?? []).map(Number).filter((n) => slideQuestions.includes(n));
  if (nums.length === 1) return { q: nums[0], clean: false };
  return { q: null, clean: false };
}
