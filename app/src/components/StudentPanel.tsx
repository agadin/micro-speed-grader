import { useEffect, useMemo, useRef, useState } from "react";
import type { Session, Task } from "../lib/types";
import type { Settings } from "../lib/settings";
import { useStore } from "../lib/store";
import { reasonSuggestions, studentResults, taskIdLabel } from "../lib/grading";
import { awayWho, findStudents, pinsByStudent, studentLabel, studentSummary, type StudentAnswer, type StudentPin } from "../lib/review";
import { SearchField } from "./controls";
import { IconCheck, IconChevL, IconChevR, IconClose, IconCross, IconTrash } from "./icons";

/**
 * One student across the whole exam, for regrade requests and appeals.
 * A side panel over the right-hand inspector, so the slide stays in view while checking a pin.
 */
export function StudentPanel({ session, tasks, settings }: { session: Session; tasks: Task[]; settings: Settings }) {
  const view = useStore((s) => s.studentView)!;
  const set = useStore((s) => s.set);
  const close = () => set({ studentView: null });

  // Esc closes (unless typing, or a menu / dialog has it)
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
      const s = useStore.getState();
      if (s.menu || s.settingsOpen || s.exportOpen || s.handoffOpen || s.conflictsOpen || s.help !== null) return;
      s.set({ studentView: null });
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  const byStudent = useMemo(() => pinsByStudent(session.pins), [session.pins]);
  const order = useMemo(() => findStudents(session.students, ""), [session.students]);
  const student = view.id ? session.students.find((s) => s.id === view.id) : undefined;

  return (
    <aside className="student-panel" data-help="students" aria-label="Student">
      {student ? (
        <StudentDetail
          key={student.id}
          session={session}
          tasks={tasks}
          settings={settings}
          studentId={student.id}
          focusQ={view.q}
          mine={byStudent.get(student.id) ?? []}
          order={order.map((s) => s.id)}
          onClose={close}
        />
      ) : (
        <StudentPicker session={session} settings={settings} byStudent={byStudent} onClose={close} />
      )}
    </aside>
  );
}

function StudentPicker({
  session,
  settings,
  byStudent,
  onClose,
}: {
  session: Session;
  settings: Settings;
  byStudent: Map<string, Session["pins"]>;
  onClose: () => void;
}) {
  const set = useStore((s) => s.set);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const list = useMemo(() => findStudents(session.students, q), [session.students, q]);
  const shown = useMemo(() => list.slice(0, 300), [list]);
  const scores = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of shown) {
      const r = studentResults({ ...session, pins: byStudent.get(s.id) ?? [] }, s, settings);
      m.set(s.id, `${r.filter((x) => x.status === "correct").length}/${r.length}`);
    }
    return m;
  }, [shown, session, byStudent, settings]);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => setHi(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(".sv-hit.hi")?.scrollIntoView({ block: "nearest" });
  }, [hi]);
  const open = (id: string | undefined) => id && set({ studentView: { id } });

  return (
    <>
      <div className="sv-head">
        <span className="sv-title">Find student</span>
        <span className="sp" />
        <button className="btn ghost icon" onClick={onClose} title="Close (Esc)" aria-label="Close">
          <IconClose />
        </button>
      </div>
      <div className="sv-pick">
        <SearchField
          className="sv-search"
          placeholder="Name or UID"
          value={q}
          onChange={setQ}
          autoFocus
          onEnter={() => open(shown[hi]?.id)}
          onEscape={onClose}
          onKey={(e) => {
            if (e.key === "ArrowDown") (e.preventDefault(), setHi((h) => Math.min(h + 1, shown.length - 1)));
            if (e.key === "ArrowUp") (e.preventDefault(), setHi((h) => Math.max(h - 1, 0)));
          }}
        />
        <div className="sv-count muted small">
          {list.length === session.students.length ? `${list.length} students` : `${list.length} of ${session.students.length} students`}
        </div>
      </div>
      <div className="sv-hits" ref={listRef}>
        {shown.map((s, i) => {
          const { name, uid } = studentLabel(s);
          return (
            <button key={s.id} className={`sv-hit ${i === hi ? "hi" : ""}`} onClick={() => open(s.id)} onMouseEnter={() => setHi(i)} title={s.folder}>
              <span className="sv-name">{name}</span>
              {uid && <span className="sv-uid">{uid}</span>}
              <span className="sp" />
              <span className="sv-score" title="Correct answers">
                {scores.get(s.id)}
              </span>
            </button>
          );
        })}
        {list.length === 0 && <div className="sv-empty muted">No student matches “{q}”.</div>}
      </div>
    </>
  );
}

function StudentDetail({
  session,
  tasks,
  settings,
  studentId,
  focusQ,
  mine,
  order,
  onClose,
}: {
  session: Session;
  tasks: Task[];
  settings: Settings;
  studentId: string;
  focusQ?: number;
  mine: Session["pins"];
  order: string[];
  onClose: () => void;
}) {
  const set = useStore((s) => s.set);
  const showPins = useStore((s) => s.showPins);
  const away = useMemo(() => awayWho(session), [session]);
  const student = session.students.find((s) => s.id === studentId)!;
  const sum = useMemo(() => studentSummary(session, student, settings, { mine, away }), [session, student, settings, mine, away]);
  const at = order.indexOf(studentId);
  const go = (d: number) => {
    const id = order[at + d];
    if (id) set({ studentView: { id } });
  };
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusQ !== undefined) bodyRef.current?.querySelector(`[data-q="${focusQ}"]`)?.scrollIntoView({ block: "nearest" });
  }, [focusQ]);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sum.feedback);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard not available */
    }
  };
  const show = (p: StudentPin) => showPins(tasks.findIndex((t) => t.id === p.taskId), [p.pin.id]);

  return (
    <>
      <div className="sv-head">
        <button className="btn ghost small sv-back" onClick={() => set({ studentView: { id: "" } })} title="Find another student">
          <IconChevL /> Students
        </button>
        <span className="sp" />
        <button className="btn ghost icon" disabled={at <= 0} onClick={() => go(-1)} title="Previous student" aria-label="Previous student">
          <IconChevL />
        </button>
        <span className="sv-pos muted small">
          {at + 1} of {order.length}
        </span>
        <button className="btn ghost icon" disabled={at >= order.length - 1} onClick={() => go(1)} title="Next student" aria-label="Next student">
          <IconChevR />
        </button>
        <button className="btn ghost icon" onClick={onClose} title="Close (Esc)" aria-label="Close">
          <IconClose />
        </button>
      </div>
      <div className="sv-body" ref={bodyRef}>
        <div className="sv-who">
          <div className="sv-big" title={student.folder}>
            {sum.name}
          </div>
          <div className="sv-meta">
            {sum.uid && <span>UID {sum.uid}</span>}
            <span className="sv-total">
              <b>
                {sum.score}/{sum.total}
              </b>{" "}
              correct
            </span>
          </div>
        </div>
        {sum.answers.map((a) => (
          <Answer key={a.q} a={a} session={session} tasks={tasks} settings={settings} focus={a.q === focusQ} onShow={show} />
        ))}
        <div className="sv-fb" data-help="feedback">
          <div className="sv-fb-head">
            <span>Feedback</span>
            <span className="sp" />
            <button className="btn ghost small" onClick={copy} title="Copy the feedback text">
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <pre>{sum.feedback}</pre>
        </div>
      </div>
    </>
  );
}

const BADGE: Record<StudentAnswer["kind"], string> = {
  correct: "ok",
  wrong: "bad",
  double: "auto",
  none: "bad",
  ungraded: "none",
  unlabelled: "none",
  away: "none",
  conflict: "none",
};

function Answer({
  a,
  session,
  tasks,
  settings,
  focus,
  onShow,
}: {
  a: StudentAnswer;
  session: Session;
  tasks: Task[];
  settings: Settings;
  focus: boolean;
  onShow: (p: StudentPin) => void;
}) {
  const gradeMany = useStore((s) => s.gradeMany);
  const ungrade = useStore((s) => s.ungrade);
  const [wrong, setWrong] = useState<string | null>(null);
  const out = a.pins.find((p) => p.away)?.away;
  const can = a.pins.length > 0 && !out;
  const graded = a.pins.filter((p) => p.groupId);
  // grade the labelled pins; an unlabelled pin only when it's all there is (grading it assigns it here)
  const targets = a.pins.some((p) => !p.unlabelled) ? a.pins.filter((p) => !p.unlabelled) : a.pins;
  const allCorrect = a.kind === "correct" && targets.every((p) => p.status === "correct");
  const suggestions = useMemo(() => (wrong === null ? [] : reasonSuggestions(session.grades, a.q, "wrong", "")), [wrong, session.grades, a.q]);

  /** one batch per image (a question can span two slides): one undo step */
  const regrade = (status: "correct" | "wrong", text: string) => {
    const byTask = new Map<string, string[]>();
    for (const p of targets) byTask.set(p.taskId, [...(byTask.get(p.taskId) ?? []), p.pin.id]);
    const batches = [...byTask].map(([taskId, pinIds]) => ({ pinIds, status, text, taskId }));
    gradeMany(batches, batches[0].taskId, a.q);
  };
  const applyWrong = () => {
    const text = (wrong ?? "").trim();
    if (!text && settings.wrongNeedsReason) return;
    regrade("wrong", text);
    setWrong(null);
  };

  return (
    <div className={`sv-q ${focus ? "focus" : ""}`} data-q={a.q}>
      <div className="sv-qhead">
        <span className="sv-qn">Q{a.q}</span>
        <span className={`badge ${BADGE[a.kind]}`}>
          {a.kind === "correct" ? <IconCheck /> : a.kind === "wrong" || a.kind === "none" ? <IconCross /> : a.kind === "double" ? "2" : "–"}
        </span>
        <span className="sv-label">{a.label}</span>
        <span className="sp" />
        {a.by && <span className="by">{a.by}</span>}
      </div>
      {a.reason && <div className="sv-reason">{a.reason}</div>}
      {a.kind === "conflict" && <div className="sv-note muted small">Two graders marked this differently. Grade it here to settle it.</div>}
      {out && <div className="sv-note muted small">Out with {out}. You can regrade it when their results come back.</div>}
      {a.pins.map((p) => (
        <div key={p.pin.id} className="sv-pin">
          <span className="sv-ptxt" title={`Pin title: ${p.pin.rawTitle || "(untitled)"}`}>
            {taskIdLabel(p.taskId, tasks)} · <span className="muted">“{p.pin.rawTitle || "untitled"}”</span>
            {p.unlabelled && <span className="sv-tag">no question in title</span>}
          </span>
          <button
            className="btn ghost small"
            disabled={tasks.findIndex((t) => t.id === p.taskId) < 0 || !!p.away}
            onClick={() => onShow(p)}
            title="Go to this pin on the slide"
          >
            Show
          </button>
        </div>
      ))}
      {can &&
        (wrong === null ? (
          <div className="sv-acts">
            <button className="btn small sv-ok" disabled={allCorrect} onClick={() => regrade("correct", "")} title="Mark this answer correct">
              <IconCheck /> Correct
            </button>
            <button className="btn small sv-bad" onClick={() => setWrong(a.kind === "wrong" ? a.reason : "")} title="Mark this answer wrong and give a reason">
              <IconCross /> Wrong
            </button>
            {graded.length > 0 && (
              <button className="btn ghost small" onClick={() => ungrade(graded.map((p) => p.pin.id))} title="Remove grade: make this answer ungraded again">
                <IconTrash /> Remove
              </button>
            )}
          </div>
        ) : (
          <div className="sv-acts">
            <input
              autoFocus
              className="sv-reason-in"
              placeholder={settings.wrongNeedsReason ? "Reason (what they marked instead)" : "Reason (optional)"}
              value={wrong}
              list={`sv-sug-${a.q}`}
              onChange={(e) => setWrong(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") applyWrong();
                else if (e.key === "Escape") setWrong(null);
              }}
            />
            <datalist id={`sv-sug-${a.q}`}>
              {suggestions.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
            <button className="btn small sv-bad" disabled={settings.wrongNeedsReason && !wrong.trim()} onClick={applyWrong}>
              Mark wrong
            </button>
            <button className="btn ghost small" onClick={() => setWrong(null)}>
              Cancel
            </button>
          </div>
        ))}
    </div>
  );
}
