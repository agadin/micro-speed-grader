import { useMemo } from "react";
import { Modal } from "./Modal";
import type { Session, Task } from "../lib/types";
import { pinMap, taskIdLabel } from "../lib/grading";
import { useStore } from "../lib/store";
import { agreement, graderLabel, resolveWith, type Verdict } from "../lib/handoff";

/**
 * Host: pins two graders disagreed on. Grouped by image and by what each grader said, so a whole
 * pattern ("Jamie: Correct · Sam: Neutrophil — 12 pins") is settled with one click.
 */
export function ConflictsDialog({ session, tasks, onClose }: { session: Session; tasks: Task[]; onClose: () => void }) {
  const applyResult = useStore((s) => s.applyResult);
  const showPins = useStore((s) => s.showPins);
  const pins = useMemo(() => pinMap(session.pins), [session.pins]);
  const g = session.grades;

  const rows = useMemo(() => {
    const m = new Map<string, { taskId: string; verdicts: Verdict[]; pinIds: string[] }>();
    for (const [id, c] of Object.entries(g.checks ?? {})) {
      if (c.state !== "conflict") continue;
      const vs = [...c.verdicts].sort((a, b) => a.by.localeCompare(b.by));
      const key = `${c.taskId}\u0000${vs.map((v) => `${v.by}:${v.status}:${v.text.trim().toLowerCase()}`).join("|")}`;
      const row = m.get(key) ?? { taskId: c.taskId, verdicts: vs, pinIds: [] };
      row.pinIds.push(id);
      m.set(key, row);
    }
    const order = new Map(tasks.map((t, i) => [t.id, i]));
    return [...m.values()].sort((a, b) => (order.get(a.taskId) ?? 0) - (order.get(b.taskId) ?? 0) || b.pinIds.length - a.pinIds.length);
  }, [g.checks, tasks]);
  const stats = useMemo(() => agreement(g), [g]);
  const total = rows.reduce((a, r) => a + r.pinIds.length, 0);

  const label = (id: string) => taskIdLabel(id, tasks);
  const use = (pinIds: string[], by: string) => applyResult(resolveWith(g, pinIds, by, pins), session.handoffs ?? []);
  const gradeMyself = (taskId: string, pinIds: string[]) => {
    onClose();
    showPins(tasks.findIndex((t) => t.id === taskId), pinIds);
  };
  const studentOf = (pinId: string) => {
    const p = pins.get(pinId);
    return session.students.find((s) => s.id === p?.studentId)?.name ?? "";
  };

  return (
    <Modal className="conflicts-modal" help="handoff/settle-disagreements" onClose={onClose}>
        <h2>Disagreements</h2>
        <p className="muted small">
          Pins two graders marked differently. They stay ungraded until you choose whose grade to keep or grade them
          yourself.
        </p>

        {rows.length === 0 ? (
          <div className="ex-empty">No disagreements. Every pin graded twice so far was graded the same way.</div>
        ) : (
          <div className="cf-list">
            {rows.map((r, i) => (
              <div key={i} className="cf-row">
                <div className="cf-head">
                  <b>{label(r.taskId)}</b>
                  <span className="muted small" title={r.pinIds.map(studentOf).filter(Boolean).join(", ")}>
                    {r.pinIds.length} pin{r.pinIds.length === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="cf-verdicts">
                  {r.verdicts.map((v) => (
                    <button key={v.by} className={`cf-v ${v.status}`} onClick={() => use(r.pinIds, v.by)} title={`Keep ${graderLabel(v.by)}'s grade for these pins`}>
                      <span className="cf-who">{graderLabel(v.by)}</span>
                      <span className="cf-what">
                        {v.status === "correct" ? "✓ Correct" : `✗ ${v.text || "Incorrect"}`}
                        {v.status === "correct" && v.text ? ` (${v.text})` : ""}
                      </span>
                      <span className="cf-use">Use</span>
                    </button>
                  ))}
                  <button className="btn ghost small" onClick={() => gradeMyself(r.taskId, r.pinIds)} title="Show these pins on the slide and grade them yourself">
                    Grade myself
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {stats.length > 0 && (
          <div className="cf-stats">
            <div className="ex-sub">
              <span>How often graders agree</span>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Graders</th>
                  <th>Pins graded by both</th>
                  <th>Agreed</th>
                  <th title="Cohen's kappa on correct / wrong: agreement beyond chance. Above 0.8 is very good; below 0.6 is worth a calibration chat.">κ</th>
                </tr>
              </thead>
              <tbody>
                {stats.map((p) => (
                  <tr key={`${p.a}|${p.b}`}>
                    <td>
                      {graderLabel(p.a)} & {graderLabel(p.b)}
                    </td>
                    <td>{p.pins}</td>
                    <td>{Math.round((p.agree / p.pins) * 100)}%</td>
                    <td
                      className={p.kappa !== null && p.kappa < 0.6 ? "warn-text" : ""}
                      title={p.kappa === null ? "Not enough variety to measure: one of them gave every shared pin the same grade" : undefined}
                    >
                      {p.kappa === null ? "—" : p.kappa.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="modal-actions">
          <span className="muted small">{total ? `${total} pin${total === 1 ? "" : "s"} to settle` : ""}</span>
          <div className="grow" />
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
    </Modal>
  );
}
