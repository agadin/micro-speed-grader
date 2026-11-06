import type { Pin, Question, SlideRef, Student } from "./types";
import { basename, listFiles, readText } from "./backend";
import { matchTitle, parseNdpa, slideIdFromFilename } from "./ndpa";

export const SLIDE_EXTS = [".ndpi", ".svs", ".tif", ".tiff", ".mrxs", ".scn", ".vms"];

export async function scanSlides(dir: string): Promise<SlideRef[]> {
  const files = await listFiles(dir, SLIDE_EXTS);
  const out: SlideRef[] = [];
  for (const f of files) {
    const id = slideIdFromFilename(basename(f));
    if (id && !out.some((s) => s.id === id)) out.push({ id, path: f });
  }
  return out;
}

/**
 * Assumed D2L layout (to be adapted once we see a real export):
 *   <submissionsDir>/<student folder>/.../<VMSxxx>.ndpi.ndpa
 * Student identity = first-level folder name.
 */
export interface ScanResult {
  students: Student[];
  pins: Pin[];
  warnings: string[];
}

export async function scanSubmissions(dir: string, questions: Question[]): Promise<ScanResult> {
  const files = await listFiles(dir, [".ndpa"]);
  const warnings: string[] = [];
  const root = dir.replace(/[\\/]+$/, "");
  const studentsByFolder = new Map<string, Student>();
  const pins: Pin[] = [];

  const included = questions.filter((q) => q.include);
  const questionsBySlide = new Map<string, number[]>();
  for (const q of included)
    for (const s of q.slides) questionsBySlide.set(s, [...(questionsBySlide.get(s) ?? []), q.num]);

  for (const f of files) {
    const rel = f.slice(root.length).replace(/^[\\/]+/, "");
    const segs = rel.split(/[\\/]/);
    const folder = segs.length > 1 ? segs[0] : "(loose files)";
    let student = studentsByFolder.get(folder);
    if (!student) {
      student = { id: `s${studentsByFolder.size + 1}`, name: prettyName(folder), folder };
      studentsByFolder.set(folder, student);
    }
    const slide = slideIdFromFilename(basename(f));
    if (!slide) continue;
    const slideQs = questionsBySlide.get(slide);
    if (!slideQs) continue; // slide not used by any included question
    let anns;
    try {
      anns = parseNdpa(await readText(f));
    } catch (e) {
      warnings.push(`${rel}: ${e}`);
      continue;
    }
    for (const a of anns) {
      const m = matchTitle(a.title, slideQs);
      let q = m.q;
      let guessed = !m.clean;
      let candidates: number[] = [];
      if (q === null) {
        if (slideQs.length === 1) q = slideQs[0];
        else candidates = [...slideQs];
        guessed = true;
      }
      pins.push({
        id: `p${pins.length + 1}`,
        studentId: student.id,
        slide,
        rawTitle: a.title,
        details: a.details,
        q,
        candidates,
        titleGuessed: guessed,
        xNm: a.xNm,
        yNm: a.yNm,
        annotationType: a.type,
      });
    }
  }

  // Ambiguous pins: if the student already answered every other candidate
  // question on this slide, the leftover one is the obvious match.
  for (const p of pins) {
    if (p.q !== null) continue;
    const answered = new Set(
      pins.filter((o) => o.studentId === p.studentId && o.slide === p.slide && o.q !== null).map((o) => o.q!),
    );
    const left = p.candidates.filter((c) => !answered.has(c));
    if (left.length === 1) {
      p.q = left[0];
      p.candidates = [];
    } else if (left.length > 1) p.candidates = left;
  }

  const students = [...studentsByFolder.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { students, pins, warnings };
}

function prettyName(folder: string): string {
  // "123456-Smith, Jane" / "Smith, Jane (123456)" -> keep readable
  return folder.replace(/_/g, " ").trim();
}
