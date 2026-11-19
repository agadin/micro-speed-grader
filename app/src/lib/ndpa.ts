/** Parsing of Hamamatsu NDP.view annotation files (.ndpa). */

export interface RawAnnotation {
  title: string;
  details: string;
  type: string;
  xNm: number;
  yNm: number;
}

const text = (el: Element | null | undefined) => (el?.textContent ?? "").trim();

/** Limits on student-supplied annotation files (real submissions have a handful of pins). */
export const MAX_ANNOTATIONS = 200;
const MAX_TITLE = 300;

const childNamed = (el: Element, tag: string) => Array.from(el.children).find((c) => c.tagName === tag) ?? el.getElementsByTagName(tag)[0];
function nearestViewstate(el: Element): Element | null {
  for (let p = el.parentElement; p; p = p.parentElement) if (p.tagName === "ndpviewstate") return p;
  return null;
}

export function parseNdpa(xml: string): RawAnnotation[] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("Invalid annotation XML");
  const out: RawAnnotation[] = [];
  for (const vs of Array.from(doc.getElementsByTagName("ndpviewstate"))) {
    const title = text(childNamed(vs, "title")).slice(0, MAX_TITLE);
    const details = text(childNamed(vs, "details")).slice(0, MAX_TITLE);
    // only annotations whose nearest viewstate is this one: nested viewstates must not count them twice
    const own = Array.from(vs.getElementsByTagName("annotation")).filter((a) => nearestViewstate(a) === vs);
    for (const ann of own) {
      if (out.length >= MAX_ANNOTATIONS) return out;
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
export function matchTitle(title: string, slideQuestions: number[], bareNumbers = true): { q: number | null; clean: boolean } {
  // titles are student-written: cap the length so matching stays cheap
  const t = title.trim().slice(0, MAX_TITLE);
  const strict = t.match(/^q\s*(\d+)$/i);
  if (strict && slideQuestions.includes(Number(strict[1]))) return { q: Number(strict[1]), clean: true };
  const qish = t.match(/\bq(?:uestion)?\s*(?:#\s*)?(\d+)/i) ?? t.match(/q(\d+)/i);
  if (qish && slideQuestions.includes(Number(qish[1]))) return { q: Number(qish[1]), clean: false };
  if (!bareNumbers) return { q: null, clean: false };
  const nums = (t.match(/\d+/g) ?? []).map(Number).filter((n) => slideQuestions.includes(n));
  if (nums.length === 1) return { q: nums[0], clean: false };
  return { q: null, clean: false };
}

/** The question number a pin's title names ("Q9", "question 9", "q#9"), whether or not it's on the slide. */
export function namedQuestion(title: string): number | null {
  const m = title.trim().slice(0, MAX_TITLE).match(/\bq(?:uestion)?\s*(?:#\s*)?(\d+)\b/i);
  return m ? Number(m[1]) : null;
}
