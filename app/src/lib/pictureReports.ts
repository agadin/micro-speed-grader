/**
 * Writes the picture reports (see pictures.ts): picture-feedback/<student>.html and
 * wrong-answer-maps.html in the export folder. Each page is one self-contained HTML file with its
 * pictures inside, so it can be emailed, uploaded or opened anywhere.
 */
import { joinPath, openSlide, tileBase, writeText } from "./backend";
import { uniqueFileNames, type ExportRow } from "./exportCsv";
import { effectiveQ } from "./grading";
import {
  answerCrop,
  CORRECT_COLOR,
  correctRef,
  dot,
  drawMarks,
  drawRegion,
  escapeHtml,
  flag,
  mapCrop,
  mapLegend,
  marksFor,
  OTHER_COLOR,
  pinsFor,
  scaleBar,
  TileCache,
  verdict,
} from "./pictures";
import type { Pin, Session, SlideInfo } from "./types";

export interface Progress {
  done: number;
  total: number;
}
type OnProgress = (p: Progress) => void;

const WRONG = "#e4572e";
const UNGRADED = "#9a9a9a";
const JPEG_Q = 0.82;

/** slide id → opened slide (null when its file isn't there) */
async function slideInfos(s: Session) {
  const out = new Map<string, SlideInfo | null>();
  for (const ref of s.slides) out.set(ref.id, await openSlide(ref.path).catch(() => null));
  return out;
}

const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{font:15px/1.5 -apple-system,"Segoe UI",Roboto,sans-serif;color:#1d1d1f;background:#fff;max-width:760px;margin:32px auto;padding:0 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 6px}
.muted{color:#6e6e73}.ok{color:#2f8a3c}.bad{color:#c4391d}
figure{margin:8px 0 0}figure img{width:100%;height:auto;border-radius:8px;border:1px solid #ddd}
figcaption{font-size:13px;color:#6e6e73;margin-top:4px}
.key{display:inline-block;width:10px;height:10px;border-radius:50%;margin:0 4px 0 10px;vertical-align:middle}
ul.legend{list-style:none;padding:0;margin:6px 0 0;font-size:14px}ul.legend li{margin:2px 0}
@media print{figure{break-inside:avoid}}
</style></head><body>
${body}
</body></html>
`;

/**
 * One page per student: their score, then each question with its feedback and, for answers given
 * with a pin, a picture of the slide with their pin and where the right answer is.
 */
export async function writePictureFeedback(
  s: Session,
  rows: ExportRow[],
  dir: string,
  opts: { wrongOnly: boolean },
  onProgress: OnProgress,
  cancelled: () => boolean,
): Promise<{ written: number; failed: string[] }> {
  const infos = await slideInfos(s);
  const tiles = new TileCache(tileBase);
  const out = joinPath(dir, "picture-feedback");
  const names = uniqueFileNames(rows.map((r) => r.stu.name));
  const failed: string[] = [];
  let written = 0;
  // the class's correct pins per question and slide, worked out once
  const classCorrect = new Map<string, Pin[]>();
  const correctOn = (q: number, slide: string) => {
    const k = `${q}|${slide}`;
    if (!classCorrect.has(k)) classCorrect.set(k, pinsFor(s, q, slide).filter((p) => verdict(p, s.grades)?.status === "correct"));
    return classCorrect.get(k)!;
  };
  for (let i = 0; i < rows.length; i++) {
    if (cancelled()) break;
    onProgress({ done: i, total: rows.length });
    const r = rows[i];
    const mine = s.pins.filter((p) => p.studentId === r.stu.id);
    const parts: string[] = [];
    for (const res of r.res) {
      const cls = res.status === "correct" ? "ok" : res.status === "wrong" ? "bad" : "muted";
      parts.push(`<h2>Question ${res.q}</h2><div class="${cls}">${escapeHtml(res.text)}</div>`);
      if (opts.wrongOnly && res.status === "correct") continue;
      const qPins = mine.filter((p) => effectiveQ(p, s.grades) === res.q);
      for (const slide of [...new Set(qPins.map((p) => p.slide))]) {
        const info = infos.get(slide);
        if (!info) continue;
        const pins = qPins.filter((p) => p.slide === slide);
        const marks = marksFor(s, res.q, slide);
        const ref = correctRef(marks, correctOn(res.q, slide).filter((p) => p.studentId !== r.stu.id));
        const box = answerCrop(pins[0], ref?.box ?? null);
        const W = 720, H = 540;
        const { cv, ctx, at, pxPerNm } = await drawRegion(info, box, W, H, tiles);
        let note = "";
        if (ref?.from === "key") {
          drawMarks(ctx, marks.filter((m) => m.kind === "correct"), at, pxPerNm, CORRECT_COLOR);
          note = "Green: the correct area.";
        } else if (ref) {
          for (const p of correctOn(res.q, slide)) {
            if (p.studentId === r.stu.id) continue;
            const c = at(p.xNm, p.yNm);
            if (c.x >= 0 && c.y >= 0 && c.x <= W && c.y <= H) dot(ctx, c.x, c.y, 3.5, CORRECT_COLOR);
          }
          note = "Green dots: where classmates placed correct pins.";
        }
        pins.forEach((p, j) => {
          const c = at(p.xNm, p.yNm);
          const v = verdict(p, s.grades);
          const fill = res.status === "correct" ? CORRECT_COLOR : res.status === "wrong" ? WRONG : v?.status === "correct" ? CORRECT_COLOR : UNGRADED;
          flag(ctx, c.x, c.y, fill, j === 0 ? "Your pin" : undefined);
        });
        scaleBar(ctx, pxPerNm);
        parts.push(
          `<figure><img alt="Your pin for question ${res.q} on ${escapeHtml(slide)}" src="${cv.toDataURL("image/jpeg", JPEG_Q)}">` +
            `<figcaption>${escapeHtml(slide)}${pins.length > 1 ? ` · ${pins.length} pins` : ""}${note ? ` · ${note}` : ""}</figcaption></figure>`,
        );
      }
    }
    const head = `<h1>${escapeHtml(r.stu.name)}</h1><div class="muted">Score ${r.score} / ${r.total}</div>`;
    try {
      await writeText(joinPath(out, `${names[i]}.html`), page(r.stu.name, head + parts.join("\n")));
      written++;
    } catch {
      failed.push(r.stu.name);
    }
  }
  onProgress({ done: rows.length, total: rows.length });
  return { written, failed };
}

/**
 * wrong-answer-maps.html: for each question on each slide, the graded pins on a picture of the slide,
 * wrong ones coloured by their reason, with a legend.
 */
export async function writeWrongAnswerMaps(s: Session, dir: string, onProgress: OnProgress, cancelled: () => boolean): Promise<number> {
  const infos = await slideInfos(s);
  const tiles = new TileCache(tileBase);
  const qs = s.questions.filter((q) => q.include).sort((a, b) => a.num - b.num);
  const jobs = qs.flatMap((q) => q.slides.map((slide) => ({ q: q.num, prompt: q.prompt, slide })));
  const parts: string[] = [];
  let n = 0;
  for (let i = 0; i < jobs.length; i++) {
    if (cancelled()) break;
    onProgress({ done: i, total: jobs.length });
    const { q, prompt, slide } = jobs[i];
    const info = infos.get(slide);
    const pins = pinsFor(s, q, slide).filter((p) => verdict(p, s.grades));
    if (!info || !pins.length) continue;
    const marks = marksFor(s, q, slide);
    const box = mapCrop(pins, marks);
    if (!box) continue;
    const lg = mapLegend(pins, s.grades);
    const W = 1200, H = 900;
    const { cv, ctx, at, pxPerNm } = await drawRegion(info, box, W, H, tiles);
    drawMarks(ctx, marks.filter((m) => m.kind === "correct"), at, pxPerNm, CORRECT_COLOR);
    // correct pins underneath, wrong pins on top so the mistakes stand out
    for (const pass of [true, false])
      for (const p of pins) {
        const col = lg.color.get(p.id)!;
        if ((col === CORRECT_COLOR) !== pass) continue;
        const c = at(p.xNm, p.yNm);
        dot(ctx, c.x, c.y, pass ? 4 : 6, col);
      }
    scaleBar(ctx, pxPerNm);
    const items = [
      ...lg.reasons.map((r) => `<li><span class="key" style="background:${r.color}"></span><b>${r.n}</b> ${escapeHtml(r.text)}</li>`),
      ...(lg.other ? [`<li><span class="key" style="background:${OTHER_COLOR}"></span><b>${lg.other}</b> other reasons</li>`] : []),
      `<li><span class="key" style="background:${CORRECT_COLOR}"></span><b>${lg.correct}</b> correct</li>`,
    ];
    parts.push(
      `<h2>Question ${q} · ${escapeHtml(slide)}</h2><div class="muted">${escapeHtml(prompt)}</div>` +
        `<figure><img alt="Wrong answers for question ${q} on ${escapeHtml(slide)}" src="${cv.toDataURL("image/jpeg", JPEG_Q)}">` +
        `<figcaption>${lg.wrong} wrong, ${lg.correct} correct${marks.some((m) => m.kind === "correct") ? " · green area: the answer key" : ""}</figcaption></figure>` +
        `<ul class="legend">${items.join("")}</ul>`,
    );
    n++;
  }
  onProgress({ done: jobs.length, total: jobs.length });
  const body =
    `<h1>Wrong-answer maps</h1><div class="muted">Where the class placed its pins, wrong answers coloured by the reason given. ` +
    `Right-click a picture to save it for a slide.</div>` +
    (parts.length ? parts.join("\n") : `<p class="muted">Nothing graded yet.</p>`);
  if (!cancelled()) await writeText(joinPath(dir, "wrong-answer-maps.html"), page("Wrong-answer maps", body));
  return n;
}
