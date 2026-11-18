import { useState } from "react";
import { Modal } from "./Modal";
import { joinPath, revealFile } from "../lib/backend";
import { groupProblems, MAX_NDPA_BYTES, MAX_PINS_PER_STUDENT_SLIDE, problemKey, type ScanProblem, type ScanProblemKind } from "../lib/loader";

/** Each kind of problem in plain words: what it means, and what to do about it. */
const KIND_TEXT: Record<ScanProblemKind, { title: string; what: string; todo: string }> = {
  "no-submission": {
    title: "Nothing to grade",
    what: "These student folders have no pins the app can use.",
    todo: "Check whether the student submitted. If they did, put their .ndpa files in their folder (Show folder), then Check again.",
  },
  "missing-slide": {
    title: "Missing a slide",
    what: "These students have no file for a slide the exam uses, so they have no answer for its questions.",
    todo: "If the file is in their folder under another name, it shows under “No slide ID” below: choose its slide there.",
  },
  "no-slide-id": {
    title: "No slide ID in the file name",
    what: "The app can't tell which slide these files are for, so their pins are left out.",
    todo: "Choose the slide each file is for. The file itself isn't changed.",
  },
  "other-slide": {
    title: "Slide not in the exam",
    what: "No question uses these slides, so their pins are left out.",
    todo: "Usually nothing. If the student typed the wrong slide ID, choose the slide the file is really for.",
  },
  "unknown-question": {
    title: "Pin names a question not on that slide",
    what: "The pin's title names a question that isn't on that slide. It's still graded with that slide's questions.",
    todo: "Look at it when you grade that slide: the student may have mislabelled the pin or used the wrong slide.",
  },
  "too-many-pins": {
    title: "Too many pins",
    what: `Only the first ${MAX_PINS_PER_STUDENT_SLIDE} pins per student per slide are kept.`,
    todo: "Open the file in NDP.view if you need to see the rest.",
  },
  "too-large": {
    title: "File too large",
    what: `Annotation files over ${MAX_NDPA_BYTES / 1024 / 1024} MB are skipped. A real one is a few KB.`,
    todo: "It's probably damaged or not an annotation file. Ask the student to save it again from NDP.view.",
  },
  unreadable: {
    title: "File can't be read",
    what: "The file isn't valid annotation data, so it was skipped.",
    todo: "Ask the student to save it again from NDP.view.",
  },
};

/** problems a slide choice can fix */
const SLIDE_FIX: ScanProblemKind[] = ["no-slide-id", "other-slide"];

/** the file name inside the student's folder (nothing for problems about the whole folder) */
function fileLabel(p: ScanProblem): string {
  if (!p.file || p.kind === "no-submission" || p.kind === "missing-slide") return "";
  const segs = p.file.split(/[\\/]/);
  return segs.length > 1 ? segs.slice(1).join("/") : p.file;
}

/** how many items a group shows before "Show all" */
const SHOW = 5;

export const thingsToCheck = (n: number) => `${n} thing${n === 1 ? "" : "s"} to check`;

/** What the instructor can do about problems: choose a file's slide, acknowledge, show in Finder. */
export interface Resolve {
  /** the submissions folder (to show files in Finder) */
  root: string;
  /** slides the exam uses, for "This file is for…" */
  slides: string[];
  fileSlides: Record<string, string>;
  setFileSlide: (file: string, slide: string | null) => void;
  acked: Set<string>;
  setAcked: (keys: string[], on: boolean) => void;
}

/** The compact "⚠ 12 things to check · Review" line (nothing when there are no problems). */
export function ScanProblemsRow({ problems, acked, fixed = 0, onReview }: { problems: ScanProblem[]; acked?: Set<string>; fixed?: number; onReview: () => void }) {
  if (!problems.length && !fixed) return null;
  const left = problems.filter((p) => !acked?.has(problemKey(p))).length;
  const done = !left;
  return (
    <div className={`scan-row${done ? " done" : ""}`} data-help="getting-started/things-to-check">
      <span className="scan-row-n">{done ? `✓ All ${problems.length + fixed} checked` : `⚠ ${thingsToCheck(left)}`}</span>
      {!done && problems.length > left && <span className="muted">({problems.length - left} acknowledged)</span>}
      <span className="muted">·</span>
      <button className="text-link" onClick={onReview} title="See what was found and what to do about it">
        Review
      </button>
    </div>
  );
}

/**
 * Problems found while reading a submissions folder, grouped by kind, each with a plain explanation
 * and what to do, then the students and files it affects. With `resolve`, each can be fixed
 * (choose a file's slide), shown in Finder, or acknowledged.
 */
export function ScanProblemsDialog({
  problems,
  onClose,
  onRecheck,
  resolve,
}: {
  problems: ScanProblem[];
  onClose: () => void;
  onRecheck?: () => void;
  resolve?: Resolve;
}) {
  const groups = groupProblems(problems);
  const acked = resolve?.acked ?? new Set<string>();
  const fixed = Object.entries(resolve?.fileSlides ?? {});
  const total = problems.length + fixed.length;
  const nAcked = problems.filter((p) => acked.has(problemKey(p))).length;
  const left = problems.length - nAcked;
  const unacked = problems.filter((p) => !acked.has(problemKey(p))).map(problemKey);

  return (
    <Modal className="scan-modal" help="getting-started/things-to-check" onClose={onClose}>
      <h2>Things to check</h2>
      <p className="muted small">
        Found while reading the student submissions. Fix what you can here, acknowledge the rest, or change the files in the
        submissions folder and check again. You can start grading at any time.
      </p>
      {resolve && total > 0 && (
        <div className="sp-overview" data-help="getting-started/things-to-check">
          <div className="sp-bar" aria-hidden>
            <i className="fixed" style={{ flexGrow: fixed.length }} />
            <i className="acked" style={{ flexGrow: nAcked }} />
            <i className="left" style={{ flexGrow: left }} />
          </div>
          <div className="sp-counts small">
            <b>{total}</b> found · <span className="ok-text">{fixed.length} fixed</span> · <span>{nAcked} acknowledged</span> ·{" "}
            <span className={left ? "warn-text" : "ok-text"}>{left ? `${left} left` : "all checked"}</span>
          </div>
        </div>
      )}
      {groups.length === 0 && !fixed.length ? (
        <div className="ex-empty">Nothing to check. Every file was read.</div>
      ) : (
        <div className="cf-list">
          {groups.map((g) => (
            <ProblemGroup key={g.kind} kind={g.kind} items={g.items} resolve={resolve} />
          ))}
          {resolve && fixed.length > 0 && (
            <div className="cf-row sp-group sp-fixed">
              <div className="cf-head">
                <b>Fixed</b>
                <span className="muted small">{fixed.length}</span>
              </div>
              <div className="small">Files you chose a slide for. They're read as that slide; the files themselves aren't changed.</div>
              <ul className="sp-items">
                {fixed.map(([file, slide]) => (
                  <li key={file}>
                    <span className="sp-file">{file}</span>
                    <span className="muted">read as {slide}</span>
                    <span className="sp-acts">
                      <button className="text-link small" onClick={() => resolve.setFileSlide(file, null)}>
                        Undo
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      <div className="modal-actions">
        {resolve && unacked.length > 1 && (
          <button onClick={() => resolve.setAcked(unacked, true)} title="Mark everything left as checked">
            Acknowledge all
          </button>
        )}
        <div className="grow" />
        {onRecheck && (
          <button onClick={onRecheck} title="Read the submissions folder again after fixing files">
            Check again
          </button>
        )}
        <button className="primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}

function ProblemGroup({ kind, items, resolve }: { kind: ScanProblemKind; items: ScanProblem[]; resolve?: Resolve }) {
  const [all, setAll] = useState(false);
  const t = KIND_TEXT[kind];
  const acked = resolve?.acked ?? new Set<string>();
  // the ones still to look at first
  const sorted = [...items].sort((a, b) => Number(acked.has(problemKey(a))) - Number(acked.has(problemKey(b))));
  const shown = all ? sorted : sorted.slice(0, SHOW);
  const open = items.filter((p) => !acked.has(problemKey(p)));
  return (
    <div className={`cf-row sp-group${open.length ? "" : " sp-done"}`} data-kind={kind}>
      <div className="cf-head">
        <b>
          {open.length ? "" : "✓ "}
          {t.title}
        </b>
        <span className="sp-head-r">
          {resolve && open.length > 1 && (
            <button className="text-link small" onClick={() => resolve.setAcked(open.map(problemKey), true)}>
              Acknowledge all {open.length}
            </button>
          )}
          <span className="muted small">{items.length}</span>
        </span>
      </div>
      <div className="small">{t.what}</div>
      <div className="small sp-todo">
        <b>What to do:</b> {t.todo}
      </div>
      <ul className="sp-items">
        {shown.map((p) => {
          const k = problemKey(p);
          const isAcked = acked.has(k);
          return (
            <li key={k} className={isAcked ? "acked" : ""}>
              {p.student && <b>{p.student}</b>}
              {fileLabel(p) && <span className="sp-file">{fileLabel(p)}</span>}
              <span className="muted">{p.detail}</span>
              {resolve && (
                <span className="sp-acts">
                  {SLIDE_FIX.includes(kind) && p.file && !isAcked && (
                    <select
                      className="sp-slide"
                      value=""
                      onChange={(e) => e.target.value && resolve.setFileSlide(p.file!, e.target.value)}
                      aria-label={`Slide for ${fileLabel(p)}`}
                      title="Read this file as that slide (the file isn't changed)"
                    >
                      <option value="">This file is for…</option>
                      {resolve.slides.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  )}
                  {p.file && (
                    <button
                      className="text-link small"
                      onClick={() => void revealFile(joinPath(resolve.root, p.file!))}
                      title="Show it in Finder"
                    >
                      {p.kind === "no-submission" || p.kind === "missing-slide" ? "Show folder" : "Show file"}
                    </button>
                  )}
                  <button className="text-link small" onClick={() => resolve.setAcked([k], !isAcked)} title={isAcked ? "Put it back on the list" : "Mark as checked"}>
                    {isAcked ? "Undo" : "OK"}
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {items.length > SHOW && (
        <button className="text-link small" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${items.length}`}
        </button>
      )}
    </div>
  );
}
