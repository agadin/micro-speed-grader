import { useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { Session } from "../lib/types";
import { useSettings } from "../lib/settings";
import { feedbackText, studentResults } from "../lib/grading";
import { dirname, joinPath, writeText } from "../lib/backend";

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const safeFile = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "_").trim() || "student";

export function ExportDialog({ session, onClose }: { session: Session; onClose: () => void }) {
  const settings = useSettings((s) => s.s);
  const [dir, setDir] = useState(joinPath(dirname(session.sessionPath), "export"));
  const [status, setStatus] = useState<string | null>(null);
  const [preview, setPreview] = useState(session.students[0]?.id ?? "");

  const rows = useMemo(
    () =>
      session.students.map((stu) => {
        const res = studentResults(session, stu, settings);
        return { stu, res, ...feedbackText(res) };
      }),
    [session, settings],
  );
  const ungraded = rows.reduce((n, r) => n + r.res.filter((x) => x.status === "ungraded").length, 0);
  const mean = rows.length ? rows.reduce((s, r) => s + r.score, 0) / rows.length : 0;
  const total = rows[0]?.total ?? 0;

  const doExport = async () => {
    try {
      const csv = [
        ["Student", "Grade", "Comment"].join(","),
        ...rows.map((r) => [csvCell(r.stu.name), csvCell(`${r.score}/${r.total}`), csvCell(r.text)].join(",")),
      ].join("\r\n");
      await writeText(joinPath(dir, "grades.csv"), "﻿" + csv);
      for (const r of rows) await writeText(joinPath(dir, "feedback", `${safeFile(r.stu.name)}.txt`), r.text);
      setStatus(`Exported ${rows.length} students to ${dir}`);
    } catch (e) {
      setStatus(`Export failed: ${e}`);
    }
  };

  const pv = rows.find((r) => r.stu.id === preview);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal wide" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Export grades</h2>
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
          <div className={ungraded ? "warn" : ""}>
            <b>{ungraded}</b> ungraded answers
          </div>
        </div>
        {ungraded > 0 && (
          <p className="warn">Some answers are still ungraded. They'll be exported as "Ungraded" and score 0.</p>
        )}
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
        <p className="muted small">
          Writes <code>grades.csv</code> (Student, Grade, Comment) and one <code>feedback/&lt;student&gt;.txt</code> per
          student.
        </p>
        <div className="preview">
          <select value={preview} onChange={(e) => setPreview(e.target.value)}>
            {rows.map((r) => (
              <option key={r.stu.id} value={r.stu.id}>
                {r.stu.name} ({r.score}/{r.total})
              </option>
            ))}
          </select>
          <pre>{pv?.text}</pre>
        </div>
        {status && <p className={status.startsWith("Export failed") ? "warn" : "ok-text"}>{status}</p>}
        <div className="modal-actions">
          <button onClick={onClose}>Close</button>
          <div className="grow" />
          <button className="primary" onClick={doExport}>
            Export
          </button>
        </div>
      </div>
    </div>
  );
}
