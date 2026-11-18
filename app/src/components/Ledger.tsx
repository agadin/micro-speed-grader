import { useCallback, useMemo, useState } from "react";
import type { Group, Pin, Session, Task } from "../lib/types";
import { pinMap, taskIdLabel } from "../lib/grading";
import { useStore } from "../lib/store";
import type { Settings } from "../lib/settings";
import { AUTO, autoRows, filterGroups, graderOptions, isFiltered, noFilter, rowPasses, textMatches, type LedgerFilter } from "../lib/review";
import { SearchField } from "./controls";
import { IconCheck, IconCross, IconPencil, IconTrash, IconTri } from "./icons";

interface Props {
  session: Session;
  task: Task;
  tasks: Task[];
  settings: Settings;
  studentName: (id: string) => string;
}

export function Ledger({ session, task, tasks, settings, studentName }: Props) {
  const allTasks = useStore((s) => s.ledgerAllTasks);
  const set = useStore((s) => s.set);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [filter, setFilter] = useState<LedgerFilter>(noFilter);
  const editGroup = useStore((s) => s.editGroup);
  const ungrade = useStore((s) => s.ungrade);
  const showPins = useStore((s) => s.showPins);
  const patch = (p: Partial<LedgerFilter>) => setFilter((f) => ({ ...f, ...p }));
  const filtered = isFiltered(filter);
  const query = filter.query.trim();

  const pinById = useMemo(() => pinMap(session.pins), [session.pins]);
  const nameOfPin = useCallback((id: string) => studentName(pinById.get(id)?.studentId ?? ""), [pinById, studentName]);
  const allGroups = useMemo(
    () =>
      Object.values(session.grades.groups)
        .filter((g) => allTasks || g.taskId === task.id)
        .sort((a, b) => b.createdAt - a.createdAt),
    [session.grades.groups, allTasks, task.id],
  );
  const groups = useMemo(() => filterGroups(allGroups, filter, nameOfPin), [allGroups, filter, nameOfPin]);
  const allAuto = useMemo(() => autoRows(session, allTasks ? tasks : [task]), [session, allTasks, tasks, task]);
  const auto = allAuto.filter((r) =>
    rowPasses(filter, {
      status: "wrong",
      grader: AUTO,
      text: settings.doubleMessage,
      names: query ? r.pins.map((p) => studentName(p.studentId)) : [],
    }),
  );
  const graders = useMemo(() => graderOptions(allGroups, allAuto.length > 0), [allGroups, allAuto.length]);

  const goto = (g: Pick<Group, "taskId" | "pinIds">) => showPins(tasks.findIndex((t) => t.id === g.taskId), g.pinIds);
  /** a student chip: show the pin, and (host) that student's answers across the exam */
  const focusPin = (taskId: string, p: Pin) => {
    goto({ taskId, pinIds: [p.id] });
    if (!session.guestPack) set({ studentView: { id: p.studentId, q: Number(taskId.match(/^Q(\d+)/)?.[1]) } });
  };
  /** with a search, rows found by a student's name open to show that student */
  const nameHit = (ids: string[]) => !!query && ids.some((id) => textMatches(query, [nameOfPin(id)]));
  const isOpen = (id: string, ids: string[]) => open[id] ?? nameHit(ids);

  const rows = groups.length + auto.length;
  const totalRows = allGroups.length + allAuto.length;
  const totalGraded = groups.reduce((s, g) => s + g.pinIds.length, 0);
  const where = allTasks ? "on all images" : "on this image";

  return (
    <div className="ledger" data-help="ledger">
      <div className="phead static">
        <span className="title">Ledger</span>
        <span className="meta lmeta">
          {filtered ? (
            <>
              <b>{rows}</b> of {totalRows} groups {where}
            </>
          ) : (
            <>
              {allGroups.length} group{allGroups.length === 1 ? "" : "s"} · {totalGraded} pins {where}
            </>
          )}
        </span>
        <span className="sp" />
        <div className="lfilters" data-help="ledger/search-and-filter">
          <SearchField
            className="lsearch"
            placeholder="Reason or student"
            title="Search reasons and student names"
            value={filter.query}
            onChange={(query) => patch({ query })}
          />
          <div className="seg lstatus" role="radiogroup" aria-label="Grade">
            {(
              [
                ["all", "All"],
                ["wrong", "Wrong only"],
                ["correct", "Correct only"],
              ] as const
            ).map(([k, label]) => (
              <button key={k} className={filter.status === k ? "on" : ""} onClick={() => patch({ status: k })}>
                {label}
              </button>
            ))}
          </div>
          <select className="lgrader" value={filter.grader} onChange={(e) => patch({ grader: e.target.value })} title="Show one grader's grades" aria-label="Grader">
            <option value="">All graders</option>
            {graders.map((g) => (
              <option key={g.key} value={g.key}>
                {g.label}
              </option>
            ))}
            {filter.grader && !graders.some((g) => g.key === filter.grader) && <option value={filter.grader}>{filter.grader === AUTO ? "AUTO" : filter.grader}</option>}
          </select>
          {filtered && (
            <button className="btn ghost small lclear" onClick={() => setFilter(noFilter)} title="Show every grade">
              Clear
            </button>
          )}
        </div>
        <span className="vsep" />
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
        {auto.map((r) => {
          const id = `__d${r.task.id}`;
          const ids = r.pins.map((p) => p.id);
          return (
            <div key={id} className="lgroup">
              <div className="lcols lrow" onClick={() => setOpen((o) => ({ ...o, [id]: !isOpen(id, ids) }))}>
                <span className="caret">
                  <IconTri open={isOpen(id, ids)} />
                </span>
                <span className="badge auto">AUTO</span>
                <span className="reason">
                  {settings.doubleMessage} <span className="q">· rule</span>
                </span>
                <span className="src">{taskIdLabel(r.task.id, tasks)}</span>
                <span className="n">{r.pins.length}</span>
                <span />
              </div>
              {isOpen(id, ids) && <PinList pins={r.pins} studentName={studentName} query={query} onFocus={(p) => focusPin(r.task.id, p)} />}
            </div>
          );
        })}
        {rows === 0 &&
          (filtered && totalRows > 0 ? (
            <div className="empty">
              No grades match.{" "}
              <button className="btn ghost small" onClick={() => setFilter(noFilter)}>
                Clear filters
              </button>
            </div>
          ) : (
            <div className="empty">
              Nothing graded yet. {settings.swapMouse ? "Left" : "Right"}-drag to lasso pins, or press <span className="kbd">↵</span> to grade the
              highlighted cluster.
            </div>
          ))}
        {groups.map((g) => (
          <div key={g.id} className="lgroup">
            <div className={`lcols lrow ${open[g.id] ? "sel" : ""}`}>
              <span className="caret" onClick={() => setOpen((o) => ({ ...o, [g.id]: !isOpen(g.id, g.pinIds) }))}>
                <IconTri open={isOpen(g.id, g.pinIds)} />
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
                  {g.by && (
                    <span className="by" title={`Graded by ${g.by}`}>
                      {g.by}
                    </span>
                  )}
                </span>
              )}
              <span className="src">{taskIdLabel(g.taskId, tasks)}</span>
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
            {isOpen(g.id, g.pinIds) && (
              <PinList
                pins={g.pinIds.map((id) => pinById.get(id)!).filter(Boolean)}
                studentName={studentName}
                query={query}
                onFocus={(p) => focusPin(g.taskId, p)}
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
  query,
  onFocus,
  onRemove,
}: {
  pins: Pin[];
  studentName: (id: string) => string;
  query: string;
  onFocus: (p: Pin) => void;
  onRemove?: (p: Pin) => void;
}) {
  return (
    <div className="lexp">
      {pins
        .slice()
        .sort((a, b) => studentName(a.studentId).localeCompare(studentName(b.studentId)))
        .map((p) => (
          <span
            key={p.id}
            className={`chip ${query && textMatches(query, [studentName(p.studentId)]) ? "hit" : ""}`}
            title={`Pin title: ${p.rawTitle || "(untitled)"} · click to show the pin and this student's answers`}
          >
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
