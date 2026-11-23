import { useRef, useState } from "react";
import type { ExportRow } from "../lib/exportCsv";
import { writePictureFeedback, writeWrongAnswerMaps, type Progress } from "../lib/pictureReports";
import type { Session } from "../lib/types";

/** Export ▸ Pictures (shown when Preferences ▸ Export ▸ Picture reports is on) */
export function PicturesTab({ session, rows, dir }: { session: Session; rows: ExportRow[]; dir: string }) {
  const [wrongOnly, setWrongOnly] = useState(true);
  const [busy, setBusy] = useState<null | "feedback" | "maps">(null);
  const [prog, setProg] = useState<Progress | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const cancel = useRef(false);
  const missing = session.slides.length === 0;

  const run = async (which: "feedback" | "maps") => {
    cancel.current = false;
    setBusy(which);
    setStatus(null);
    setProg({ done: 0, total: 1 });
    try {
      if (which === "feedback") {
        const { written, failed } = await writePictureFeedback(session, rows, dir, { wrongOnly }, setProg, () => cancel.current);
        setStatus(
          (cancel.current ? "Stopped: " : "") +
            `wrote ${written} pages to ${dir}/picture-feedback` +
            (failed.length ? `. Couldn't write: ${failed.slice(0, 3).join(", ")}${failed.length > 3 ? ` and ${failed.length - 3} more` : ""}` : ""),
        );
      } else {
        const n = await writeWrongAnswerMaps(session, dir, setProg, () => cancel.current);
        setStatus(cancel.current ? "Stopped: nothing written." : `Wrote wrong-answer-maps.html (${n} maps) to ${dir}`);
      }
    } catch (e) {
      setStatus(`Failed: ${String(e)}`);
    } finally {
      setBusy(null);
      setProg(null);
    }
  };

  return (
    <div className="ex-pics">
      <div className="pic-card">
        <h3>Picture feedback</h3>
        <p className="muted small">
          One page per student: their score, the feedback for each question and, where they placed a pin, a picture of the slide
          with their pin and the right answer (the answer key's area, or where classmates placed correct pins). Saved as{" "}
          <code>picture-feedback/&lt;student&gt;.html</code>: one file each, pictures included, ready to email or upload.
        </p>
        <div className="pic-row">
          <div className="seg">
            <button className={wrongOnly ? "on" : ""} onClick={() => setWrongOnly(true)} disabled={!!busy}>
              Pictures for mistakes only
            </button>
            <button className={!wrongOnly ? "on" : ""} onClick={() => setWrongOnly(false)} disabled={!!busy}>
              Every answer
            </button>
          </div>
          <div className="grow" />
          <button className="primary" onClick={() => run("feedback")} disabled={!!busy || missing}>
            Save picture feedback
          </button>
        </div>
      </div>
      <div className="pic-card">
        <h3>Wrong-answer maps</h3>
        <p className="muted small">
          For each question on each slide, every graded pin on a picture of the slide, wrong answers coloured by the reason you gave.
          Shows where the class went wrong, for a review session. Saved as <code>wrong-answer-maps.html</code>.
        </p>
        <div className="pic-row">
          <div className="grow" />
          <button className="primary" onClick={() => run("maps")} disabled={!!busy || missing}>
            Save wrong-answer maps
          </button>
        </div>
      </div>
      {busy && prog && (
        <div className="pic-progress">
          <span className="pbar wide">
            <span style={{ width: `${(prog.done / Math.max(1, prog.total)) * 100}%` }} />
          </span>
          <span className="muted small">
            {busy === "feedback" ? "Student" : "Map"} {Math.min(prog.done + 1, prog.total)} of {prog.total}
          </span>
          <button onClick={() => (cancel.current = true)}>Stop</button>
        </div>
      )}
      {missing && <p className="warn">The slide files aren't set for this session, so there's nothing to draw on.</p>}
      {status && <p className={status.startsWith("Failed") ? "warn" : "ok-text"}>{status}</p>}
    </div>
  );
}
