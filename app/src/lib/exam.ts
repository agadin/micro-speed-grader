import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { Question } from "./types";
import { readBytes, readText } from "./backend";
import { parseQuestionsFromText } from "./examParse";

export { parseQuestionsFromText };

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

async function pdfText(bytes: Uint8Array): Promise<string> {
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  const lines: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    // group text items into lines by their baseline y
    const rows = new Map<number, { x: number; s: string }[]>();
    for (const it of content.items as { str: string; transform: number[] }[]) {
      if (!("str" in it)) continue;
      const y = Math.round(it.transform[5] / 2) * 2;
      const row = rows.get(y) ?? [];
      row.push({ x: it.transform[4], s: it.str });
      rows.set(y, row);
    }
    [...rows.entries()]
      .sort((a, b) => b[0] - a[0])
      .forEach(([, row]) => lines.push(row.sort((a, b) => a.x - b.x).map((r) => r.s).join(" ")));
  }
  return lines.join("\n");
}

export async function loadExam(path: string): Promise<{ name: string; questions: Question[] }> {
  const name = (path.split(/[\\/]/).pop() ?? "Exam").replace(/\.(pdf|json)$/i, "");
  if (/\.json$/i.test(path)) {
    const j = JSON.parse(await readText(path));
    const qs: Question[] = (j.questions ?? j).map((q: Partial<Question>) => ({
      num: Number(q.num),
      slides: (q.slides ?? []).map((s) => String(s).toUpperCase()),
      prompt: q.prompt ?? "",
      include: q.include ?? true,
    }));
    return { name: j.name ?? name, questions: qs };
  }
  const text = await pdfText(await readBytes(path));
  return { name, questions: parseQuestionsFromText(text) };
}
