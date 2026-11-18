import { useMemo, useState } from "react";
import { Modal } from "./Modal";
import { TimeTab } from "./TimeTab";
import { timeCsv, timeReport } from "../lib/timing";
import { open } from "@tauri-apps/plugin-dialog";
import type { Session } from "../lib/types";
import { useSettings } from "../lib/settings";
import { feedbackText, studentResults } from "../lib/grading";
import { dirname, joinPath, writeText } from "../lib/backend";
import { exportTable, statsTable, testStats, toCsv, uniqueFileNames, type ExportRow } from "../lib/exportCsv";
import { CsvPreviewTable, ExportLayoutEditor } from "./ExportLayout";
import { conflictPins } from "../lib/handoff";

const fmt = (x: number | null, d = 2) => (x === null || !Number.isFinite(x) ? "—" : (x + 0).toFixed(d).replace(/^-(0\.0*)$/, "$1"));

/** rule-of-thumb reading of KR-20 for a classroom test */
function kr20Note(k: number | null) {
  if (k === null) return "needs at least 2 questions and some spread in scores";
  if (k >= 0.8) return "good internal consistency";
  if (k >= 0.7) return "acceptable";
  if (k >= 0.5) return "low: some questions may not measure the same thing";
  return "very low";
}

export function ExportDialog({ session, onClose }: { session: Session; onClose: () => void }) {
  const settings = useSettings((s) => s.s);
  const [tab, setTab] = useState<"csv" | "stats" | "time">("csv");
  const hasTime = !!session.timeLog?.length;
  const [dir, setDir] = useState(joinPath(dirname(session.sessionPath), "export"));
  const [status, setStatus] = useState<string | null>(null);
  const [preview, setPreview] = useState(session.students[0]?.id ?? "");
  const [ungradedAsWrong, setUngradedAsWrong] = useState(false);

  const rows: ExportRow[] = useMemo(
    () =>
      session.students.map((stu) => {
        const res = studentResults(session, stu, settings);
        return { stu, res, ...feedbackText(res, settings) };
      }),
    [session, settings],
  );
  const qs = useMemo(
    () => session.questions.filter((q) => q.include).map((q) => q.num).sort((a, b) => a - b),
    [session.questions],
  );
  const ungraded = rows.reduce((n, r) => n + r.res.filter((x) => x.status === "ungraded").length, 0);
  const mean = rows.length ? rows.reduce((s, r) => s + r.score, 0) / rows.length : 0;
  const total = rows[0]?.total ?? 0;

  const cols = settings.exportColumns;
  const opts = { columns: cols, uidFrom: settings.exportUid, ungradedItem: settings.exportUngraded };
  const table = useMemo(() => exportTable(rows, qs, opts), [rows, qs, cols, settings.exportUid, settings.exportUngraded]);
  const stats = useMemo(() => testStats(rows, qs, ungradedAsWrong), [rows, qs, ungradedAsWrong]);
  const exportCsv = async () => {
    try {
      await writeText(joinPath(dir, "grades.csv"), toCsv(table));
      const failed: string[] = [];
      if (settings.exportFeedback) {
        const names = uniqueFileNames(rows.map((r) => r.stu.name));
        // one bad file must not stop the other students' feedback from being written
        for (const [i, r] of rows.entries())
          await writeText(joinPath(dir, "feedback", `${names[i]}.txt`), r.text).catch(() => failed.push(r.stu.name));
      }
      const wrote = rows.length - failed.length;
      setStatus(
        failed.length
          ? `Export failed for ${failed.length} feedback file${failed.length > 1 ? "s" : ""} (${failed.slice(0, 3).join(", ")}${failed.length > 3 ? "…" : ""}); wrote grades.csv and ${wrote} others to ${dir}`
          : `Wrote grades.csv${settings.exportFeedback ? ` and ${rows.length} feedback files` : ""} to ${dir}`,
      );
    } catch (e) {
      setStatus(`Export failed: ${e}`);
    }
  };
  const timeRep = useMemo(() => (hasTime ? timeReport(session) : null), [hasTime, session]);
  const exportTime = async () => {
    if (!timeRep) return;
    try {
      await writeText(joinPath(dir, "time-stats.csv"), toCsv(timeCsv(timeRep)));
      setStatus(`Wrote time-stats.csv to ${dir}`);
    } catch (e) {
      setStatus(`Export failed: ${e}`);
    }
  };
  const exportStats = async () => {
    try {
      await writeText(joinPath(dir, "item-stats.csv"), toCsv(statsTable(stats)));
      setStatus(`Wrote item-stats.csv to ${dir}`);
    } catch (e) {
      setStatus(`Export failed: ${e}`);
    }
  };

  const pv = rows.find((r) => r.stu.id === preview);
  const shownRows = table.slice(1, 7);

  return (
    <Modal className="export-modal" help="export" onClose={onClose}>
        <div className="ex-head">
          <h2>Export grades</h2>
          <div className="seg">
            <button className={tab === "csv" ? "on" : ""} onClick={() => setTab("csv")}>
              Grades CSV
            </button>
            <button className={tab === "stats" ? "on" : ""} onClick={() => setTab("stats")}>
              Statistics
            </button>
            {hasTime && (
              <button className={tab === "time" ? "on" : ""} onClick={() => setTab("time")} title="How long grading took: per question, grader and student">
                Time
              </button>
            )}
          </div>
        </div>
        <div className="stats">
          <div>
            <b>{rows.length}</b> students
          </div>
          <div>
            <b>{total}</b> questions
          </div>
          <div>
            mean <b>{mean.toFixed(1)}</b>/{total}
          </div>
          <div>
            KR-20 <b>{fmt(stats.kr20)}</b>
          </div>
          <div className={ungraded ? "warn" : ""}>
            <b>{ungraded}</b> ungraded answers
          </div>
          {conflictPins(session.grades).length > 0 && (
            <div className="warn" title="Pins two graders marked differently count as ungraded until you settle them (Disagreements in the top bar)">
              <b>{conflictPins(session.grades).length}</b> disagreements
            </div>
          )}
        </div>

        <div className="ex-body">
          {tab === "csv" ? (
            <div className="ex-csv">
              <ExportLayoutEditor />

              <div className="ex-preview">
                <div className="ex-sub">
                  <span>Preview</span>
                  <span className="muted small">
                    first {shownRows.length} of {rows.length} rows · {table[0].length} columns
                  </span>
                </div>
                <CsvPreviewTable table={[table[0], ...shownRows]} qCount={qs.length} />
                {ungraded > 0 && (
                  <p className="warn small">
                    Some answers are still ungraded: they read "{settings.fbUngraded}" in the comment, score 0, and{" "}
                    {settings.exportUngraded === "0" ? "count as 0" : "are left blank"} in the item columns.
                  </p>
                )}
                <div className="preview">
                  <select value={preview} onChange={(e) => setPreview(e.target.value)}>
                    {rows.map((r) => (
                      <option key={r.stu.id} value={r.stu.id}>
                        Comment for {r.stu.name} ({r.score}/{r.total})
                      </option>
                    ))}
                  </select>
                  <pre>{pv?.text}</pre>
                </div>
              </div>
            </div>
          ) : tab === "stats" ? (
            <div className="ex-stats">
              {ungraded > 0 && (
                <div className="ex-sub">
                  <span className="muted small">
                    {ungraded} ungraded answers: final figures need every answer graded.
                  </span>
                  <div className="seg">
                    <button className={!ungradedAsWrong ? "on" : ""} onClick={() => setUngradedAsWrong(false)}>
                      Leave those students out
                    </button>
                    <button className={ungradedAsWrong ? "on" : ""} onClick={() => setUngradedAsWrong(true)}>
                      Count ungraded as wrong
                    </button>
                  </div>
                </div>
              )}
              <div className="kr-cards">
                <div className="kr big">
                  <span className="kl">KR-20</span>
                  <b>{fmt(stats.kr20)}</b>
                  <span className="kn">{kr20Note(stats.kr20)}</span>
                </div>
                <div className="kr">
                  <span className="kl">Students</span>
                  <b>{stats.n}</b>
                  <span className="kn">
                    {stats.excluded
                      ? `${stats.excluded} left out (ungraded answers)`
                      : ungraded
                        ? "ungraded answers counted as wrong"
                        : "all fully graded"}
                  </span>
                </div>
                <div className="kr">
                  <span className="kl">Mean</span>
                  <b>{fmt(stats.mean)}</b>
                  <span className="kn">of {stats.k}</span>
                </div>
                <div className="kr">
                  <span className="kl">SD</span>
                  <b>{fmt(stats.sd)}</b>
                  <span className="kn">population</span>
                </div>
              </div>
              {stats.n < 2 ? (
                <div className="ex-empty">
                  Item statistics need at least two students with every answer graded.
                  {ungraded > 0 && " Finish grading, or count ungraded answers as wrong for a provisional look."}
                </div>
              ) : (
              <div className="tbl-wrap">
                <table className="csv-table items">
                  <thead>
                    <tr>
                      <th>Question</th>
                      <th title="Proportion of students who got it right">Difficulty (p)</th>
                      <th title="Correlation of the item with the total score without that item">Point-biserial</th>
                      <th title="KR-20 of the test with this question left out">KR-20 if deleted</th>
                      <th>Correct</th>
                      <th>Incorrect</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.items.map((it) => (
                      <tr key={it.q}>
                        <td>Q{it.q}</td>
                        <td>
                          <span className="pbar">
                            <span style={{ width: `${it.p * 100}%` }} />
                          </span>
                          {fmt(it.p)}
                        </td>
                        <td className={it.rpb === null ? "" : it.rpb < 0.2 ? "bad" : it.rpb >= 0.3 ? "good" : ""}>{fmt(it.rpb)}</td>
                        <td
                          className={
                            it.kr20IfDeleted !== null && stats.kr20 !== null && it.kr20IfDeleted > stats.kr20 ? "bad" : ""
                          }
                        >
                          {fmt(it.kr20IfDeleted)}
                        </td>
                        <td>{it.correct}</td>
                        <td>{it.incorrect}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              )}
              <p className="muted small">
                Red: point-biserial below 0.2 (weak discrimination), or KR-20 would rise without the question. Students with
                any ungraded answer are left out unless you count those answers as wrong.
              </p>
            </div>
          ) : (
            <TimeTab report={timeRep} />
          )}
        </div>

        <label className="field wide">
          <span>Folder</span>
          <input value={dir} onChange={(e) => setDir(e.target.value)} />
          <button
            onClick={async () => {
              const d = await open({ directory: true, defaultPath: dir });
              if (typeof d === "string") setDir(d);
            }}
          >
            Choose…
          </button>
        </label>
        {status && <p className={status.startsWith("Export failed") ? "warn" : "ok-text"}>{status}</p>}
        <div className="modal-actions">
          <button onClick={onClose}>Close</button>
          <div className="grow" />
          {tab === "csv" ? (
            <button className="primary" onClick={exportCsv}>
              Export grades.csv
            </button>
          ) : tab === "stats" ? (
            <button className="primary" onClick={exportStats}>
              Save item-stats.csv
            </button>
          ) : (
            <button className="primary" onClick={exportTime}>
              Save time-stats.csv
            </button>
          )}
        </div>
    </Modal>
  );
}
