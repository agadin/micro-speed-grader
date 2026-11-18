import { useState } from "react";
import { Modal } from "./Modal";
import { groupProblems, MAX_NDPA_BYTES, MAX_PINS_PER_STUDENT_SLIDE, type ScanProblem, type ScanProblemKind } from "../lib/loader";

/** Each kind of problem in plain words: what it means, and what to do about it. */
const KIND_TEXT: Record<ScanProblemKind, { title: string; what: string; todo: string }> = {
  "no-submission": {
    title: "Nothing to grade",
    what: "These student folders have no pins the app can use.",
    todo: "Check whether the student submitted. If they did, put their .ndpa files in their folder.",
  },
  "missing-slide": {
    title: "Missing a slide",
    what: "These students have no file for a slide the exam uses, so they have no answer for its questions.",
    todo: "If the file is in their folder under another name, rename it so it includes the slide ID.",
  },
  "no-slide-id": {
    title: "No slide ID in the file name",
    what: "The app can't tell which slide these files are for, so their pins are left out.",
    todo: "Rename the file so it includes the slide ID, e.g. VMS109.ndpi.ndpa.",
  },
  "other-slide": {
    title: "Slide not in the exam",
    what: "No question uses these slides, so their pins are left out.",
    todo: "Usually nothing. If the student typed the wrong slide ID, rename the file.",
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

/** the file name inside the student's folder (nothing for problems about the whole folder) */
function fileLabel(p: ScanProblem): string {
  if (!p.file || p.kind === "no-submission" || p.kind === "missing-slide") return "";
  const segs = p.file.split(/[\\/]/);
  return segs.length > 1 ? segs.slice(1).join("/") : p.file;
}

/** how many items a group shows before "Show all" */
const SHOW = 5;

export const thingsToCheck = (n: number) => `${n} thing${n === 1 ? "" : "s"} to check`;

/** The compact "⚠ 12 things to check · Review" line (nothing when there are no problems). */
export function ScanProblemsRow({ problems, onReview }: { problems: ScanProblem[]; onReview: () => void }) {
  if (!problems.length) return null;
  return (
    <div className="scan-row" data-help="getting-started/things-to-check">
      <span className="scan-row-n">⚠ {thingsToCheck(problems.length)}</span>
      <span className="muted">·</span>
      <button className="text-link" onClick={onReview} title="See what was found and what to do about it">
        Review
      </button>
    </div>
  );
}

/**
 * Problems found while reading a submissions folder, grouped by kind, each with a plain explanation
 * and what to do, then the students and files it affects.
 */
export function ScanProblemsDialog({ problems, onClose, onRecheck }: { problems: ScanProblem[]; onClose: () => void; onRecheck?: () => void }) {
  const groups = groupProblems(problems);
  return (
    <Modal className="scan-modal" help="getting-started/things-to-check" onClose={onClose}>
      <h2>Things to check</h2>
      <p className="muted small">
        Found while reading the student submissions. You can start grading anyway: fix what matters in the submissions folder, then
        check again.
      </p>
      {groups.length === 0 ? (
        <div className="ex-empty">Nothing to check. Every file was read.</div>
      ) : (
        <div className="cf-list">
          {groups.map((g) => (
            <ProblemGroup key={g.kind} kind={g.kind} items={g.items} />
          ))}
        </div>
      )}
      <div className="modal-actions">
        <span className="muted small">{problems.length ? thingsToCheck(problems.length) : ""}</span>
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

function ProblemGroup({ kind, items }: { kind: ScanProblemKind; items: ScanProblem[] }) {
  const [all, setAll] = useState(false);
  const t = KIND_TEXT[kind];
  const shown = all ? items : items.slice(0, SHOW);
  return (
    <div className="cf-row sp-group" data-kind={kind}>
      <div className="cf-head">
        <b>{t.title}</b>
        <span className="muted small">{items.length}</span>
      </div>
      <div className="small">{t.what}</div>
      <div className="small sp-todo">
        <b>What to do:</b> {t.todo}
      </div>
      <ul className="sp-items">
        {shown.map((p, i) => (
          <li key={i}>
            {p.student && <b>{p.student}</b>}
            {fileLabel(p) && <span className="sp-file">{fileLabel(p)}</span>}
            <span className="muted">{p.detail}</span>
          </li>
        ))}
      </ul>
      {items.length > SHOW && (
        <button className="text-link small" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${items.length}`}
        </button>
      )}
    </div>
  );
}
