import { useMemo, useState } from "react";
import type { Group, Pin, Session, Task } from "../lib/types";
import { useStore } from "../lib/store";
import type { Settings } from "../lib/settings";
import { IconCheck, IconCross, IconPencil, IconTrash, IconTri } from "./icons";

interface Props {
  session: Session;
  task: Task;
  tasks: Task[];
  doubles: Set<string>;
  settings: Settings;
  studentName: (id: string) => string;
}

export function Ledger({ session, task, tasks, doubles, settings, studentName }: Props) {
  const allTasks = useStore((s) => s.ledgerAllTasks);
  const set = useStore((s) => s.set);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const editGroup = useStore((s) => s.editGroup);
  const ungrade = useStore((s) => s.ungrade);
  const focusPins = useStore((s) => s.focusPins);
  const setTask = useStore((s) => s.setTask);

  const pinById = useMemo(() => new Map(session.pins.map((p) => [p.id, p])), [session.pins]);
  const groups = useMemo(
    () =>
      Object.values(session.grades.groups)
        .filter((g) => allTasks || g.taskId === task.id)
        .sort((a, b) => b.createdAt - a.createdAt),
    [session.grades.groups, allTasks, task.id],
  );
  const autoDoubles = useMemo(
    () =>
      session.pins.filter(
        (p) => doubles.has(p.id) && !session.grades.pinGroup[p.id] && p.slide === task.slide,
      ),
    [session.pins, doubles, session.grades.pinGroup, task.slide],
  );

  const goto = (g: Pick<Group, "taskId" | "pinIds">) => {
    const idx = tasks.findIndex((t) => t.id === g.taskId);
    if (idx >= 0 && idx !== session.taskIndex) setTask(idx);
    set({ selection: g.pinIds });
    focusPins(g.pinIds);
  };

  const totalGraded = groups.reduce((s, g) => s + g.pinIds.length, 0);

  const taskLabel = (id: string) => id.replace("|", " · ");

  return (
    <div className="ledger">
      <div className="phead static">
        <span className="title">Ledger</span>
        <span className="meta">
          {groups.length} group{groups.length === 1 ? "" : "s"} · {totalGraded} pins {allTasks ? "on all images" : "on this image"}
        </span>
        <span className="sp" />
        <label className="check">
          <input type="checkbox" checked={allTasks} onChange={(e) => set({ ledgerAllTasks: e.target.checked })} />
          All images
        </label>
      </div>
      <div className="lcols lhdr">
        <span />
        <span />
        <span>Grade / reason</span>
        <span>Image</span>
        <span className="n">Pins</span>
        <span />
      </div>
      <div className="ledger-list">
        {autoDoubles.length > 0 && !allTasks && (
          <>
            <div className="lcols lrow" onClick={() => setOpen((o) => ({ ...o, __d: !o.__d }))}>
              <span className="caret">
                <IconTri open={!!open.__d} />
              </span>
              <span className="badge auto">AUTO</span>
              <span className="reason">
                {settings.doubleMessage} <span className="q">· rule</span>
              </span>
              <span className="src">{taskLabel(task.id)}</span>
              <span className="n">{autoDoubles.length}</span>
              <span />
            </div>
            {open.__d && (
              <PinList pins={autoDoubles} studentName={studentName} onFocus={(p) => goto({ taskId: task.id, pinIds: [p.id] })} />
            )}
          </>
        )}
        {groups.length === 0 && autoDoubles.length === 0 && (
          <div className="empty">
            Nothing graded yet. Right-drag to lasso pins, or press <span className="kbd">↵</span> to grade the highlighted
            cluster.
          </div>
        )}
        {groups.map((g) => (
          <div key={g.id} className="lgroup">
            <div className={`lcols lrow ${open[g.id] ? "sel" : ""}`}>
              <span className="caret" onClick={() => setOpen((o) => ({ ...o, [g.id]: !o[g.id] }))}>
                <IconTri open={!!open[g.id]} />
              </span>
              <button
                className={`badge ${g.status === "correct" ? "ok" : "bad"}`}
                title="Toggle correct / wrong"
                onClick={() => editGroup(g.id, { status: g.status === "correct" ? "wrong" : "correct" })}
              >
                {g.status === "correct" ? <IconCheck /> : <IconCross />}
              </button>
              {editing === g.id ? (
                <input
                  autoFocus
                  className="lg-edit"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") {
                      editGroup(g.id, { text: draft.trim() });
                      setEditing(null);
                    } else if (e.key === "Escape") setEditing(null);
                  }}
                  onBlur={() => setEditing(null)}
                />
              ) : (
                <span
                  className="reason"
                  title="Click to show on slide · double-click to edit"
                  onClick={() => goto(g)}
                  onDoubleClick={() => {
                    setEditing(g.id);
                    setDraft(g.text);
                  }}
                >
                  {g.status === "correct" ? (
                    <>
                      Correct{g.text && <span className="q"> — {g.text}</span>}
                    </>
                  ) : (
                    g.text || <span className="q">no reason</span>
                  )}
                </span>
              )}
              <span className="src">{taskLabel(g.taskId)}</span>
              <span className="n">{g.pinIds.length}</span>
              <span className="acts">
                <button title="Edit text" onClick={() => (setEditing(g.id), setDraft(g.text))}>
                  <IconPencil />
                </button>
                <button title="Remove this grade (ungrade all)" onClick={() => ungrade(g.pinIds)}>
                  <IconTrash />
                </button>
              </span>
            </div>
            {open[g.id] && (
              <PinList
                pins={g.pinIds.map((id) => pinById.get(id)!).filter(Boolean)}
                studentName={studentName}
                onFocus={(p) => goto({ taskId: g.taskId, pinIds: [p.id] })}
                onRemove={(p) => ungrade([p.id])}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function PinList({
  pins,
  studentName,
  onFocus,
  onRemove,
}: {
  pins: Pin[];
  studentName: (id: string) => string;
  onFocus: (p: Pin) => void;
  onRemove?: (p: Pin) => void;
}) {
  return (
    <div className="lexp">
      {pins
        .slice()
        .sort((a, b) => studentName(a.studentId).localeCompare(studentName(b.studentId)))
        .map((p) => (
          <span key={p.id} className="chip" title={`Pin title: ${p.rawTitle || "(untitled)"} · click to show`}>
            <span onClick={() => onFocus(p)}>{studentName(p.studentId)}</span>
            {onRemove && (
              <button title="Remove from group (ungrade)" onClick={() => onRemove(p)}>
                ×
              </button>
            )}
          </span>
        ))}
    </div>
  );
}
