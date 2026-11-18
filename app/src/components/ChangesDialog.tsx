import { useMemo } from "react";
import { Modal } from "./Modal";
import type { Session, Task } from "../lib/types";
import { taskId } from "../lib/grading";
import { graderLabel } from "../lib/handoff";
import { useStore } from "../lib/store";
import { canCarry, carryOver, dismissRows, restorePins, reviewRows, type ReviewRow } from "../lib/rescan";

const verdict = (status: "correct" | "wrong", text: string) =>
  status === "correct" ? `✓ Correct${text ? ` (${text})` : ""}` : `✗ ${text || "Incorrect"}`;

/**
 * Changed submissions: after Rescan submissions, pins a student changed or took out since they were
 * graded. Grouped by question, one row per student: carry the old grade over to the new pin, grade it
 * yourself, restore a removed pin, or accept the removal.
 */
export function ChangesDialog({ session, tasks, onClose }: { session: Session; tasks: Task[]; onClose: () => void }) {
  const applyReview = useStore((s) => s.applyReview);
  const showPins = useStore((s) => s.showPins);
  const rows = useMemo(() => reviewRows(session), [session]);
  const groups = useMemo(() => {
    const m = new Map<number | null, ReviewRow[]>();
    for (const r of rows) m.set(r.q, [...(m.get(r.q) ?? []), r]);
    return [...m.entries()];
  }, [rows]);
  const names = useMemo(() => new Map(session.students.map((s) => [s.id, s.name])), [session.students]);
  const prompt = (q: number | null) => session.questions.find((x) => x.num === q)?.prompt ?? "";
  const byName = (a: ReviewRow, b: ReviewRow) => (names.get(a.studentId) ?? "").localeCompare(names.get(b.studentId) ?? "");

  const carry = (rs: ReviewRow[]) => applyReview(carryOver(session, rs));
  const restore = (rs: ReviewRow[]) => applyReview(restorePins(session, rs));
  const dismiss = (rs: ReviewRow[]) => applyReview(dismissRows(session, rs));
  const gradeMyself = (r: ReviewRow) => {
    const np = r.newPin!;
    const q = r.q ?? np.q ?? np.candidates[0];
    onClose();
    showPins(tasks.findIndex((t) => t.id === taskId(q, np.slide)), [np.id]);
  };

  return (
    <Modal className="changes-modal" help="getting-started/review-changed-submissions" onClose={onClose}>
      <h2>Changed submissions</h2>
      <p className="muted small">
        Pins students changed or took out after they were graded. The old pin no longer counts, but its grade is kept
        here: carry it over to the new pin, or grade the new pin yourself.
      </p>

      {rows.length === 0 ? (
        <div className="ex-empty">Nothing left to review.</div>
      ) : (
        <div className="cf-list">
          {groups.map(([q, rs]) => {
            const carryable = rs.filter(canCarry);
            const removed = rs.filter((r) => r.kind === "removed");
            return (
              <div key={String(q)} className="cf-row ch-group">
                <div className="cf-head">
                  <b className="ch-q" title={prompt(q)}>
                    {q === null ? "No question" : `Q${q}`}
                    <span className="muted small"> {prompt(q)}</span>
                  </b>
                  <span className="ch-group-actions">
                    {carryable.length > 1 && (
                      <button className="btn ghost small" onClick={() => carry(carryable)} title="Give every new pin in this question its old grade">
                        Carry all over ({carryable.length})
                      </button>
                    )}
                    {removed.length > 1 && (
                      <button className="btn ghost small" onClick={() => dismiss(removed)} title="These pins stay out of the results">
                        Accept all removals ({removed.length})
                      </button>
                    )}
                  </span>
                </div>
                {[...rs].sort(byName).map((r) => {
                  const g = r.old.grade;
                  return (
                    <div key={r.id} className="ch-row" data-pin={r.newPin?.id ?? r.id}>
                      <span className="ch-name">{names.get(r.studentId) ?? r.studentId}</span>
                      <span className="ch-old">
                        <span className="ch-label">Was</span>
                        {g ? (
                          <span className={g.status === "correct" ? "ok-text" : "warn"}>
                            {verdict(g.status, g.text)}
                            <span className="muted"> · {graderLabel(g.by)}</span>
                          </span>
                        ) : (
                          <span className="muted">ungraded</span>
                        )}
                      </span>
                      <span className="ch-new">
                        <span className="ch-label">Now</span>
                        {r.kind === "removed" ? (
                          <span className="muted">no longer in the files</span>
                        ) : r.double ? (
                          <span className="muted">a new pin, and another one: the double-pin rule applies</span>
                        ) : r.newGrade ? (
                          <span>
                            new pin, graded by Answer key:{" "}
                            <span className={r.newGrade.status === "correct" ? "ok-text" : "warn"}>{verdict(r.newGrade.status, r.newGrade.text)}</span>
                          </span>
                        ) : (
                          <span>new pin, ungraded</span>
                        )}
                      </span>
                      <span className="ch-actions">
                        {r.kind === "changed" ? (
                          <>
                            <button
                              className="btn small"
                              disabled={!canCarry(r)}
                              onClick={() => carry([r])}
                              title={canCarry(r) ? "Give the new pin the old grade" : "The student has two pins for this question now"}
                            >
                              Carry grade over
                            </button>
                            {r.newGrade && (
                              <button className="btn ghost small" onClick={() => dismiss([r])} title="Keep the answer key's grade on the new pin">
                                Keep key's grade
                              </button>
                            )}
                            <button className="btn ghost small" onClick={() => gradeMyself(r)} title="Show the new pin on the slide and grade it yourself">
                              Grade myself
                            </button>
                          </>
                        ) : (
                          <>
                            <button className="btn small" onClick={() => restore([r])} title="The old pin counts again, with its grade">
                              Restore
                            </button>
                            <button className="btn ghost small" onClick={() => dismiss([r])} title="The pin stays out of the results">
                              Accept removal
                            </button>
                          </>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}

      <div className="modal-actions">
        <span className="muted small">{rows.length ? `${rows.length} to review` : ""}</span>
        <div className="grow" />
        <button className="primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}
