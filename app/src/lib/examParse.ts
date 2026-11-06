import type { Question } from "./types";

/** Extract "Q<n>. Using VMSxxx [or VMSyyy], <prompt>" questions from exam text. */
export function parseQuestionsFromText(text: string): Question[] {
  const flat = text.replace(/\s+/g, " ");
  const parts = flat.split(/(?=\bQ\d{1,3}\s*\.\s)/);
  const out: Question[] = [];
  for (const part of parts) {
    const m = part.match(/^Q(\d{1,3})\s*\.\s*(.*)$/);
    if (!m) continue;
    const num = Number(m[1]);
    const body = m[2].trim();
    const using = body.match(/Using\s+((?:VMS\s*\d+)(?:\s*(?:,|or|and|\/)\s*VMS\s*\d+)*)/i);
    const slides = using
      ? (using[1].match(/VMS\s*\d+/gi) ?? []).map((s) => s.replace(/\s+/g, "").toUpperCase())
      : [];
    if (out.some((q) => q.num === num)) continue;
    out.push({ num, slides: [...new Set(slides)], prompt: body, include: true });
  }
  return out.sort((a, b) => a.num - b.num);
}
