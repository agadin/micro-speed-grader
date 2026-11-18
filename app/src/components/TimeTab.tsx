import { useState } from "react";
import { fmtDuration, IDLE_CAP, type TimeReport } from "../lib/timing";

const per = (secs: number, n: number) => (n ? fmtDuration(secs / n) : "—");

/**
 * Export ▸ Time: how long grading took. Shown only here: per question, per grader, per student, and,
 * for pins graded twice, how the graders' time compares on agreements and disagreements.
 */
export function TimeTab({ report: r }: { report: TimeReport | null }) {
  const [allStudents, setAllStudents] = useState(false);
  if (!r) return <div className="ex-empty">No grading time recorded yet.</div>;
  const grader = r.byGrader;
  const students = allStudents ? r.byStudent : r.byStudent.slice(0, 8);
  const median = (() => {
    const xs = r.byStudent.map((x) => x.secs).sort((a, b) => a - b);
    return xs.length ? xs[Math.floor(xs.length / 2)] : 0;
  })();
  return (
    <div className="ex-stats ex-time" data-help="export/time-spent">
      <div className="kr-cards">
        <div className="kr big">
          <span className="kl">Grading time</span>
          <b>{fmtDuration(r.totalSecs)}</b>
          <span className="kn">active time; breaks over {IDLE_CAP / 60} min don't count</span>
        </div>
        <div className="kr">
          <span className="kl">Pins graded</span>
          <b>{r.pins}</b>
          <span className="kn">{r.keyPins ? `+ ${r.keyPins} by the answer key` : `${r.actions} grading actions`}</span>
        </div>
        <div className="kr">
          <span className="kl">Per pin</span>
          <b>{per(r.totalSecs, r.pins)}</b>
          <span className="kn">on average</span>
        </div>
        <div className="kr">
          <span className="kl">Per student</span>
          <b>{fmtDuration(median)}</b>
          <span className="kn">median</span>
        </div>
      </div>

      <div className="ex-sub">
        <span>By question</span>
      </div>
      <table className="csv-table items">
        <thead>
          <tr>
            <th>Question</th>
            <th>Time</th>
            <th>Pins</th>
            <th>Per pin</th>
            <th>Per student</th>
            {grader.length > 1 && grader.map((g) => <th key={g.key}>{g.label} per pin</th>)}
          </tr>
        </thead>
        <tbody>
          {r.byQuestion.map((q) => {
            const m = r.matrix.find((x) => `Q${x.q}` === q.label);
            return (
              <tr key={q.key}>
                <td>{q.label}</td>
                <td>{fmtDuration(q.secs)}</td>
                <td>{q.pins}</td>
                <td>{per(q.secs, q.pins)}</td>
                <td>{per(q.secs, q.students)}</td>
                {grader.length > 1 && grader.map((g) => <td key={g.key}>{m?.graders[g.key] == null ? "—" : fmtDuration(m.graders[g.key]!)}</td>)}
              </tr>
            );
          })}
        </tbody>
      </table>

      {grader.length > 1 && (
        <>
          <div className="ex-sub">
            <span>By grader</span>
          </div>
          <table className="csv-table items">
            <thead>
              <tr>
                <th>Grader</th>
                <th>Time</th>
                <th>Pins</th>
                <th>Per pin</th>
              </tr>
            </thead>
            <tbody>
              {grader.map((g) => (
                <tr key={g.key}>
                  <td>{g.label}</td>
                  <td>{fmtDuration(g.secs)}</td>
                  <td>{g.pins}</td>
                  <td>{per(g.secs, g.pins)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {r.pairs.length > 0 && (
        <>
          <div className="ex-sub">
            <span>Pins graded twice: time vs agreement</span>
          </div>
          <table className="csv-table items">
            <thead>
              <tr>
                <th>Graders</th>
                <th>Pins</th>
                <th>Per pin (each)</th>
                <th title="Average time per pin, both graders, on pins they agreed on">When they agreed</th>
                <th title="Average time per pin, both graders, on pins they disagreed on">When they disagreed</th>
              </tr>
            </thead>
            <tbody>
              {r.pairs.map((p) => (
                <tr key={`${p.a}|${p.b}`}>
                  <td>
                    {p.a} & {p.b}
                  </td>
                  <td>{p.pins}</td>
                  <td>
                    {p.a} {fmtDuration(p.aPerPin)} · {p.b} {fmtDuration(p.bPerPin)}
                  </td>
                  <td>{p.agreedPerPin === null ? "—" : `${fmtDuration(p.agreedPerPin)} (${p.agreed})`}</td>
                  <td>{p.disagreedPerPin === null ? "—" : `${fmtDuration(p.disagreedPerPin)} (${p.disagreed})`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <div className="ex-sub">
        <span>Students who took longest</span>
        {r.byStudent.length > 8 && (
          <button className="text-link small" onClick={() => setAllStudents(!allStudents)}>
            {allStudents ? "Show fewer" : `Show all ${r.byStudent.length}`}
          </button>
        )}
      </div>
      <table className="csv-table items">
        <thead>
          <tr>
            <th>Student</th>
            <th>Time</th>
            <th>Pins</th>
          </tr>
        </thead>
        <tbody>
          {students.map((s) => (
            <tr key={s.key}>
              <td>{s.label}</td>
              <td>{fmtDuration(s.secs)}</td>
              <td>{s.pins}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">
        Each grading action's time is the time since the previous one (or since the image was opened), shared equally by the pins it
        graded. Pins graded together in a cluster each get a small share. Hand-off graders' time comes back with their results.
      </p>
    </div>
  );
}
