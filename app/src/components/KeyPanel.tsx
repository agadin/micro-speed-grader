import { useEffect, useMemo, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { Question, Session, Task } from "../lib/types";
import { useStore } from "../lib/store";
import { dirname, joinPath, readText, withExt, writeText } from "../lib/backend";
import { emptyKey, makeKeyFile, markPins, newMark, parseKeyFile, type AnswerKey } from "../lib/answerKey";
import { pinsForTask, reasonSuggestions, taskLabel } from "../lib/grading";
import { pinsInPaint, type PaintOp } from "../lib/paint";
import { safeFileName } from "../lib/exportCsv";
import { Panel, ToolPicker } from "./RightPanel";
import { IconTrash } from "./icons";

/**
 * The answer-key editor's side panel: paint an area on the slide with the selection tools, then save it
 * as where the right answer is, or a common wrong answer (with the reason students will read).
 */
export function KeyPanel(p: {
  session: Session;
  task: Task;
  tasks: Task[];
  question: Question | undefined;
  paint: PaintOp[];
  clearPaint: () => void;
  onGoTask: (i: number) => void;
}) {
  const { session, task, paint } = p;
  const set = useStore((s) => s.set);
  const setKey = useStore((s) => s.setKey);
  const key: AnswerKey = session.key ?? emptyKey();
  const [reason, setReason] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const reasonRef = useRef<HTMLInputElement>(null);

  const here = key.marks.filter((m) => m.q === task.q && m.slide === task.slide);
  const taskPins = useMemo(() => pinsForTask(session.pins, task, session.grades), [session.pins, task, session.grades]);
  const inside = useMemo(() => pinsInPaint(taskPins, paint).length, [taskPins, paint]);
  const suggestions = useMemo(() => reasonSuggestions(session.grades, task.q, "wrong", reason).slice(0, 6), [session.grades, task.q, reason]);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const k of key.marks) {
      const t = p.tasks.find((x) => x.q === k.q && x.slide === k.slide);
      if (t) m.set(t.id, (m.get(t.id) ?? 0) + 1);
    }
    return m;
  }, [key.marks, p.tasks]);

  const save1 = (kind: "correct" | "wrong") => {
    if (!paint.length) return;
    if (kind === "wrong" && !reason.trim()) {
      reasonRef.current?.focus();
      return;
    }
    setKey({ ...key, marks: [...key.marks, newMark(task.q, task.slide, kind, reason, paint)] });
    setReason("");
    p.clearPaint();
  };
  // C saves the painted area as correct; W goes to the reason box
  const keys = useRef({ save1, paint });
  keys.current = { save1, paint };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
      if (e.metaKey || e.ctrlKey || e.altKey || !keys.current.paint.length) return;
      if (e.key === "c") keys.current.save1("correct");
      else if (e.key === "w") {
        e.preventDefault();
        reasonRef.current?.focus();
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  const remove = (id: string) => setKey({ ...key, marks: key.marks.filter((m) => m.id !== id) });

  const importKey = async () => {
    const f = await open({ filters: [{ name: "Answer key", extensions: ["msgkey"] }] });
    if (typeof f !== "string") return;
    try {
      const r = parseKeyFile(await readText(f, 20_000_000), session);
      const replace =
        !key.marks.length ||
        confirm(`Replace the ${key.marks.length} area${key.marks.length === 1 ? "" : "s"} already in the key?\n\nOK replaces them. Cancel adds the imported areas alongside.`);
      setKey({ ...key, mode: r.file.mode === "suggest" ? "suggest" : key.mode, marks: replace ? r.marks : [...key.marks, ...r.marks] });
      setStatus({
        ok: true,
        text: `Imported ${r.marks.length} area${r.marks.length === 1 ? "" : "s"}${r.skipped ? `; ${r.skipped} for questions or slides this session doesn't have were skipped` : ""}.`,
      });
    } catch (e) {
      setStatus({ ok: false, text: String(e instanceof Error ? e.message : e) });
    }
  };
  const exportKey = async () => {
    const f = await save({
      defaultPath: joinPath(dirname(session.sessionPath), `${safeFileName(`${session.name} key`)}.msgkey`),
      filters: [{ name: "Answer key", extensions: ["msgkey"] }],
    });
    if (!f) return;
    try {
      await writeText(withExt(f, "msgkey"), JSON.stringify(makeKeyFile(session, key)));
      setStatus({ ok: true, text: `Saved ${key.marks.length} areas.` });
    } catch (e) {
      setStatus({ ok: false, text: `Could not save the key: ${e}` });
    }
  };

  return (
    <aside className="right key-panel">
      <Panel id="key-question" title="Answer key" meta={taskLabel(task)}>
        <div className="qid">
          <span className="qn">Q{task.q}</span>
          <span className="slide">{task.slide}</span>
        </div>
        <p className="prompt">{p.question?.prompt || <span className="muted">No prompt text.</span>}</p>
        {p.question && p.question.slides.length > 1 && (
          <p className="help">
            Either slide: {p.question.slides.join(" or ")}. Mark the answer on each slide; switch slides in the top bar.
          </p>
        )}
      </Panel>

      <Panel id="key-paint" title="Paint an area">
        <p className="muted small">
          Paint where the answer is with the tool below (right-drag), then save it as correct, or as a common wrong
          answer with the reason students will read.
        </p>
        <ToolPicker />
        <div className={`key-new${paint.length ? " on" : ""}`}>
          {paint.length ? (
            <>
              <div className="key-new-n">
                <b>{inside}</b> student pin{inside === 1 ? "" : "s"} inside
                <button className="notice-x" onClick={p.clearPaint} title="Clear the painted area (Esc)" aria-label="Clear">
                  ×
                </button>
              </div>
              <button className="btn key-ok" onClick={() => save1("correct")} title="Pins here are right (C)">
                ✓ Correct here <span className="kbd">C</span>
              </button>
              <div className="key-wrong">
                <input
                  ref={reasonRef}
                  className="input"
                  placeholder="Wrong: what is it? e.g. Neutrophil"
                  value={reason}
                  list="key-reasons"
                  onChange={(e) => setReason(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") save1("wrong");
                    if (e.key === "Escape") (e.target as HTMLInputElement).blur();
                  }}
                />
                <datalist id="key-reasons">
                  {suggestions.map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
                <button className="btn key-bad" onClick={() => save1("wrong")} disabled={!reason.trim()} title="Pins here are wrong, with this reason (W, then type)">
                  ✗ Wrong
                </button>
              </div>
            </>
          ) : (
            <span className="muted small">Nothing painted yet.</span>
          )}
        </div>
      </Panel>

      <Panel id="key-marks" title="On this image" meta={`${here.length} area${here.length === 1 ? "" : "s"}`}>
        {here.length === 0 ? (
          <p className="muted small">No areas yet. Students' pins are shown so you can see where most of them clicked.</p>
        ) : (
          <ul className="key-list">
            {here.map((m) => (
              <li key={m.id} className={m.kind}>
                <i />
                <span className="key-what">{m.kind === "correct" ? "Correct" : m.reason}</span>
                <span className="muted small">{markPins(m, taskPins)} pins</span>
                <button className="icon" onClick={() => remove(m.id)} title="Delete this area" aria-label="Delete this area">
                  <IconTrash />
                </button>
              </li>
            ))}
          </ul>
        )}
        {counts.size > 0 && (
          <div className="key-others">
            {p.tasks.map((t, i) =>
              counts.get(t.id) ? (
                <button key={t.id} className={`key-chip${t.id === task.id ? " on" : ""}`} onClick={() => p.onGoTask(i)} title="Go to this image">
                  {taskLabel(t)} · {counts.get(t.id)}
                </button>
              ) : null,
            )}
          </div>
        )}
      </Panel>

      <Panel id="key-settings" title="When a pin lands in an area">
        <div className="seg full">
          <button className={key.mode === "grade" ? "on acc" : ""} onClick={() => setKey({ ...key, mode: "grade" })} title="Pins in an area get its grade straight away">
            Grade it
          </button>
          <button className={key.mode === "suggest" ? "on acc" : ""} onClick={() => setKey({ ...key, mode: "suggest" })} title="Pins in an area are only suggested; you confirm while grading">
            Suggest only
          </button>
        </div>
        <div className="key-files">
          <button className="btn ghost small" onClick={importKey}>
            Import key…
          </button>
          <button className="btn ghost small" onClick={exportKey} disabled={!key.marks.length}>
            Export key…
          </button>
        </div>
        {status && <p className={status.ok ? "ok-text small" : "warn small"}>{status.text}</p>}
      </Panel>

      <div className="key-done">
        <button className="btn light" onClick={() => set({ keyMode: false, keyApplyOpen: !!key.marks.length })}>
          Done
        </button>
      </div>
    </aside>
  );
}
