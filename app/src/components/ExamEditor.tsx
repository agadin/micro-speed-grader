import { useEffect, useMemo, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import type { Question, Session, SlideRef } from "../lib/types";
import { useStore } from "../lib/store";
import { dirname, joinPath, openSlide, tileBase, withExt, writeText } from "../lib/backend";
import { checkQuestions, examJson, nextNum, normSlide, planQuestionEdit, renumbered, type QuestionEditPlan } from "../lib/examEdit";
import { scanSubmissions } from "../lib/loader";
import { buildTasks } from "../lib/grading";
import { safeFileName } from "../lib/exportCsv";
import { Modal } from "./Modal";
import { moved, useDragSort } from "./ExportLayout";
import { SearchField } from "./controls";
import { IconTrash } from "./icons";

/** thumbnails: slide file → tile URL of the whole slide (one tile), shared by every editor */
const thumbCache = new Map<string, Promise<string | null>>();
function thumbUrl(path: string) {
  let p = thumbCache.get(path);
  if (!p) {
    p = openSlide(path)
      .then((info) => {
        const fit = Math.ceil(Math.log2(Math.max(info.width, info.height) / info.tileSize));
        return `${tileBase}/${info.id}/${Math.max(0, info.maxLevel - Math.max(0, fit))}/0_0.jpg`;
      })
      .catch(() => null);
    thumbCache.set(path, p);
  }
  return p;
}
function SlideThumb({ slide }: { slide: SlideRef }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void thumbUrl(slide.path).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [slide.path]);
  return <span className="ee-thumb">{url ? <img src={url} alt="" loading="lazy" /> : <i />}</span>;
}

/**
 * Set up and fix the exam's questions. In the new-session wizard it edits freely (numbers and order
 * too). Inside a session (`session` set) the numbers of existing questions are fixed, and changes are
 * reviewed — what they do to pins and grades — before they're applied.
 */
export function ExamEditor(p: {
  questions: Question[];
  slides: SlideRef[];
  examName: string;
  /** set when editing inside a session */
  session?: Session;
  /** wizard: questions whose answer to mark when grading starts */
  markAfter?: Set<number>;
  onMarkAfter?: (s: Set<number>) => void;
  /** wizard: the edited questions */
  onDone?: (qs: Question[]) => void;
  onClose: () => void;
}) {
  const inSession = !!p.session;
  const [draft, setDraft] = useState<Question[]>(() => [...p.questions].sort((a, b) => a.num - b.num).map((q) => ({ ...q, slides: [...q.slides] })));
  const [sel, setSel] = useState(0);
  const [picker, setPicker] = useState(false);
  const [find, setFind] = useState("");
  const [warnedRenumber, setWarnedRenumber] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [review, setReview] = useState<QuestionEditPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const original = useMemo(() => new Set(p.questions.map((q) => q.num)), [p.questions]);
  const available = useMemo(() => new Set(p.slides.map((s) => s.id)), [p.slides]);
  const check = useMemo(() => checkQuestions(draft, available), [draft, available]);
  const q = draft[Math.min(sel, draft.length - 1)];
  const changed = JSON.stringify(draft) !== JSON.stringify([...p.questions].sort((a, b) => a.num - b.num));

  const patch = (i: number, d: Partial<Question>) => setDraft((qs) => qs.map((x, j) => (j === i ? { ...x, ...d } : x)));
  const add = () => {
    const n = nextNum(draft);
    setDraft((qs) => [...qs, { num: n, slides: [], prompt: "", include: true }]);
    setSel(draft.length);
    setPicker(true);
  };
  const remove = (i: number) => {
    const x = draft[i];
    if (inSession && original.has(x.num) && !confirm(`Remove Q${x.num} from the exam? Its grades are kept in the session but stop counting.`)) return;
    setDraft((qs) => qs.filter((_, j) => j !== i));
    setSel((s) => Math.max(0, Math.min(s, draft.length - 2)));
  };
  // wizard: drag to reorder; the numbers follow the new order (after a one-time warning)
  const startDrag = useDragSort("y", listRef, (from, to) => {
    if (inSession) return;
    if (!warnedRenumber) {
      if (
        !confirm(
          "Reordering renumbers the questions 1, 2, 3… in the new order.\n\nStudents' pins are matched to questions by the number in their title (e.g. “Q3”), so only renumber if these numbers don't match the exam the students had. Continue?",
        )
      )
        return;
      setWarnedRenumber(true);
    }
    const next = moved(draft, from, to);
    setDraft(renumbered(next));
    // "mark its answer" follows the question to its new number
    if (p.markAfter?.size) p.onMarkAfter?.(new Set(next.flatMap((x, i) => (p.markAfter!.has(x.num) ? [i + 1] : []))));
    setSel(to);
  });

  const usedBy = (slide: string) => draft.filter((x) => x.slides.includes(slide)).map((x) => x.num);
  const pickable = p.slides.filter((s) => !find.trim() || s.id.includes(normSlide(find)));
  const toggleSlide = (id: string) => {
    if (!q) return;
    const i = draft.indexOf(q);
    patch(i, { slides: q.slides.includes(id) ? q.slides.filter((s) => s !== id) : [...q.slides, id] });
  };

  const saveFile = async () => {
    const f = await save({
      defaultPath: joinPath(p.session ? dirname(p.session.sessionPath) : "", `${safeFileName(p.examName || "exam")}.json`),
      filters: [{ name: "Exam questions", extensions: ["json"] }],
    });
    if (!f) return;
    try {
      await writeText(withExt(f, "json"), examJson(p.examName, draft));
      setStatus({ ok: true, text: `Saved ${draft.length} questions. Choose it as the exam in a new session to reuse them.` });
    } catch (e) {
      setStatus({ ok: false, text: `Could not save: ${e}` });
    }
  };

  // ---- inside a session: preview, then apply (after saving a copy of the session) ----
  const preview = async () => {
    if (!p.session) return;
    setBusy(true);
    setStatus(null);
    try {
      const s = p.session;
      const scan = await scanSubmissions(s.submissionsDir, draft, undefined, s.fileSlides ?? {});
      setReview(planQuestionEdit(s, draft, scan));
    } catch (e) {
      setStatus({ ok: false, text: `Could not read the submissions folder: ${e}` });
    }
    setBusy(false);
  };
  const apply = async () => {
    const s = p.session;
    if (!s || !review) return;
    setBusy(true);
    try {
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
      const backup = s.sessionPath.replace(/\.msgrade$/i, "") + ` (before question edit ${stamp}).msgrade`;
      await writeText(backup, JSON.stringify(s));
      useStore.getState().applyQuestionEdit(draft, review.merged, review.grades, backup);
      p.onClose();
    } catch (e) {
      setStatus({ ok: false, text: `Could not save a copy of the session first, so nothing was changed: ${e}` });
      setBusy(false);
    }
  };
  const markAnswer = () => {
    if (!q) return;
    if (inSession) {
      const st = useStore.getState();
      const s = st.session!;
      // the image for this question's first slide that's in the slides folder
      const i = buildTasks(s.questions, new Set(s.slides.map((r) => r.id))).findIndex((t) => t.q === q.num);
      if (i >= 0) st.setTask(i);
      st.set({ keyMode: true, menu: null, selection: [] });
      p.onClose();
    } else {
      const m = new Set(p.markAfter ?? []);
      if (m.has(q.num)) m.delete(q.num);
      else m.add(q.num);
      p.onMarkAfter?.(m);
    }
  };

  return (
    <Modal className="exam-editor" help={inSession ? "exam-questions/inside-a-session" : "exam-questions"} onClose={p.onClose} escape={!picker}>
      <div className="ee-head">
        <h2>{inSession ? "Edit questions" : "Questions"}</h2>
        <span className="muted small">
          {draft.length} question{draft.length === 1 ? "" : "s"} · {draft.filter((x) => x.include).length} counted in the score
        </span>
      </div>
      {inSession && (
        <div className="ee-risk" data-help="exam-questions/inside-a-session">
          <b>This exam is already being graded.</b> Changing its questions can change which question a student's pin answers, and
          grades for a question you remove stop counting. You'll see exactly what changes before anything is applied, and a copy of
          the session is saved first. Question numbers can't be changed here: students' pins are matched by the number in their title.
        </div>
      )}

      {review ? (
        <div className="ee-review">
          <h3>Review the changes</h3>
          <ul className="ee-changes">
            {review.changes.map((c, i) => (
              <li key={i} className={c.kind}>
                <b>Q{c.q}</b> {c.detail}
              </li>
            ))}
            {!review.changes.length && <li className="muted">No changes to the questions.</li>}
          </ul>
          <div className="ee-impact">
            <div>
              <b>{review.newPins}</b> new pin{review.newPins === 1 ? "" : "s"} to grade
            </div>
            <div className={review.regraded ? "warn-text" : ""}>
              <b>{review.regraded}</b> graded pin{review.regraded === 1 ? "" : "s"} now answer a different question: their grade is
              removed so you can grade them again
            </div>
            <div>
              <b>{review.retired}</b> pin{review.retired === 1 ? "" : "s"} no longer used (their grades are kept aside)
            </div>
            {review.removedGrades > 0 && (
              <div className="warn-text">
                <b>{review.removedGrades}</b> grades belong to removed questions and stop counting
              </div>
            )}
          </div>
          <p className="muted small">Undo history starts again after applying. To go back, open the saved copy of the session.</p>
          {status && <p className={status.ok ? "ok-text" : "warn"}>{status.text}</p>}
          <div className="modal-actions">
            <button onClick={() => setReview(null)}>Back to editing</button>
            <div className="grow" />
            <button className="primary danger" onClick={apply} disabled={busy}>
              Apply changes
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="ee-body">
            <div className="ee-list-wrap">
              <ul className="ee-list" ref={listRef}>
                {draft.map((x, i) => (
                  <li
                    key={`${x.num}-${i}`}
                    data-di={i}
                    className={`${i === sel ? "on" : ""}${x.include ? "" : " out"}`}
                    onClick={() => {
                      setSel(i);
                      setPicker(false);
                    }}
                    onPointerDown={(e) => !inSession && startDrag(e, i)}
                    title={inSession ? undefined : "Drag to reorder (renumbers the questions)"}
                  >
                    <span className="ee-n">Q{x.num}</span>
                    <span className="ee-sum">
                      <span className="ee-slides">{x.slides.join(" or ") || <i className="warn-text">no slide</i>}</span>
                      <span className="muted small ee-prompt">{x.prompt || "No prompt"}</span>
                    </span>
                    {inSession && !original.has(x.num) && <span className="pill out">new</span>}
                  </li>
                ))}
              </ul>
              <button className="btn ghost small ee-add" onClick={add}>
                + Add question
              </button>
            </div>

            {q ? (
              <div className="ee-detail" key={`${q.num}-${sel}`}>
                <div className="ee-row">
                  <label className="field ee-num">
                    <span>Number</span>
                    <input
                      className="input"
                      type="number"
                      min={1}
                      value={q.num}
                      disabled={inSession && original.has(q.num)}
                      title={inSession && original.has(q.num) ? "Numbers of questions already being graded can't change" : undefined}
                      onChange={(e) => patch(draft.indexOf(q), { num: Math.max(1, Math.round(Number(e.target.value)) || 1) })}
                    />
                  </label>
                  <label className="check ee-include">
                    <input type="checkbox" checked={q.include} onChange={(e) => patch(draft.indexOf(q), { include: e.target.checked })} />
                    Counted in the score
                  </label>
                  <span className="grow" />
                  <button className="icon ee-del" onClick={() => remove(draft.indexOf(q))} title="Remove this question">
                    <IconTrash />
                  </button>
                </div>
                <label className="field">
                  <span>Prompt</span>
                  <textarea
                    className="input"
                    rows={2}
                    value={q.prompt}
                    placeholder="e.g. Using VMS109, place a pin on an eccrine sweat gland"
                    onChange={(e) => patch(draft.indexOf(q), { prompt: e.target.value })}
                  />
                </label>
                <div className="field">
                  <span>
                    Slide{q.slides.length > 1 ? "s (either one)" : ""}
                  </span>
                  <div className="ee-chips">
                    {q.slides.map((s) => (
                      <span key={s} className={`ee-chip${available.has(s) ? "" : " missing"}`} title={available.has(s) ? undefined : "Not in the slides folder"}>
                        {s}
                        <button className="ee-x" onClick={() => toggleSlide(s)} aria-label={`Remove ${s}`}>
                          ×
                        </button>
                      </span>
                    ))}
                    <button className="btn ghost small" onClick={() => setPicker(!picker)}>
                      {picker ? "Done choosing" : q.slides.length ? "+ Another slide (either one)" : "Choose slide…"}
                    </button>
                  </div>
                </div>
                {picker ? (
                  <div className="ee-picker" data-help="exam-questions/choose-slides">
                    <SearchField className="ee-find" placeholder="Slide ID, e.g. 109" value={find} onChange={setFind} />
                    {p.slides.length === 0 ? (
                      <p className="muted small">Choose the slides folder first to pick slides from it.</p>
                    ) : (
                      <div className="ee-grid">
                        {pickable.map((s) => {
                          const by = usedBy(s.id).filter((n) => n !== q.num);
                          const on = q.slides.includes(s.id);
                          return (
                            <button key={s.id} className={`ee-tile${on ? " on" : ""}`} onClick={() => toggleSlide(s.id)} title={on ? "Click to take it off" : "Click to use this slide"}>
                              <SlideThumb slide={s} />
                              <span className="ee-tile-l">
                                {on ? "✓ " : ""}
                                {s.id}
                              </span>
                              {by.length > 0 && <span className="ee-tile-q">Q{by.join(", Q")}</span>}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="ee-mark">
                    {inSession ? (
                      <button className="btn ghost small" onClick={markAnswer} disabled={changed || !q.slides.length} title={changed ? "Apply your changes first" : "Paint the right answer for this question"}>
                        Mark the answer on the slide…
                      </button>
                    ) : (
                      <label className="check">
                        <input type="checkbox" checked={!!p.markAfter?.has(q.num)} onChange={markAnswer} disabled={!q.slides.length} />
                        Mark its answer when grading starts
                      </label>
                    )}
                    <span className="muted small">Paint where the right answer is, and pins there are graded for you. See the answer key.</span>
                  </div>
                )}
              </div>
            ) : (
              <div className="ee-detail muted">No questions yet. Click + Add question.</div>
            )}
          </div>

          {(check.errors.length > 0 || check.warnings.length > 0) && (
            <ul className="ee-problems">
              {check.errors.map((e) => (
                <li key={e} className="warn-text">
                  {e}
                </li>
              ))}
              {check.warnings.map((w) => (
                <li key={w} className="muted">
                  {w}
                </li>
              ))}
            </ul>
          )}
          {status && <p className={status.ok ? "ok-text" : "warn"}>{status.text}</p>}
          <div className="modal-actions">
            <button onClick={p.onClose}>Cancel</button>
            <button onClick={saveFile} disabled={!draft.length} title="Save these questions as an exam file to reuse">
              Save as exam file…
            </button>
            <div className="grow" />
            {inSession ? (
              <button className="primary" onClick={preview} disabled={!changed || check.errors.length > 0 || busy}>
                {busy ? "Reading submissions…" : "Review changes…"}
              </button>
            ) : (
              <button
                className="primary"
                onClick={() => {
                  p.onDone?.(draft);
                  p.onClose();
                }}
                disabled={check.errors.length > 0}
              >
                Use these questions
              </button>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
