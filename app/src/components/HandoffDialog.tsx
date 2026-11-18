import { useMemo, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { Session, Task } from "../lib/types";
import { useStore } from "../lib/store";
import { dirname, joinPath, readText, writeText } from "../lib/backend";
import { makePack, mergeResult, parseResult, remainingByTask, splitEven, type Handoff } from "../lib/handoff";
import { safeFileName } from "../lib/exportCsv";

/** column colours: You, then one per grader */
const HUES = ["#e8b25a", "#5ec8c0", "#a98bff", "#ff8fb1", "#8fd17a", "#6fa8ff"];
const hue = (col: number) => (col === 0 ? "rgba(255,255,255,0.55)" : HUES[(col - 1) % HUES.length]);

let nextKey = 1;
interface Grader {
  key: number;
  name: string;
}

/**
 * Host: split the remaining work between yourself and any number of other graders.
 * Each remaining image (question × slide) is a card. Drag it to a person's column, or click it to pick one.
 * "Create packs" writes one file per grader.
 */
export function HandoffDialog({ session, tasks, onClose }: { session: Session; tasks: Task[]; onClose: () => void }) {
  const setHandoffs = useStore((s) => s.setHandoffs);
  const applyResult = useStore((s) => s.applyResult);
  const setStore = useStore((s) => s.set);
  const [graders, setGraders] = useState<Grader[]>([{ key: nextKey++, name: "" }]);
  /** task id → column (0 = you, i = graders[i-1]); null = follow "split evenly" */
  const [manual, setManual] = useState<Map<string, number> | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [picker, setPicker] = useState<{ id: string; x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number; over: number | null } | null>(null);
  const press = useRef<{ id: string; x: number; y: number; moved: boolean } | null>(null);
  const nameRefs = useRef<Map<number, HTMLInputElement>>(new Map());

  const remaining = useMemo(() => remainingByTask(session, tasks).filter((r) => r.pinIds.length), [session, tasks]);
  const items = useMemo(() => remaining.map((r) => ({ id: r.task.id, n: r.pinIds.length })), [remaining]);
  const cols = graders.length + 1;
  const assign = manual ?? splitEven(items, cols);
  const colOf = (id: string) => Math.min(assign.get(id) ?? 0, cols - 1);
  const load = Array.from({ length: cols }, (_, c) => items.filter((i) => colOf(i.id) === c).reduce((a, b) => a + b.n, 0));
  const total = load.reduce((a, b) => a + b, 0);
  const outPins = total - load[0];
  const nameOf = (c: number) => (c === 0 ? "You" : graders[c - 1].name.trim() || `Grader ${c}`);
  const label = (t: Task) => `Q${t.q} · ${t.slide}${t.slideCount > 1 ? ` (${t.slideIndex + 1}/${t.slideCount})` : ""}`;

  const moveTo = (id: string, col: number) => {
    const next = new Map(items.map((i) => [i.id, colOf(i.id)] as [string, number]));
    next.set(id, col);
    setManual(next);
  };
  const giveAway = () => {
    const m = splitEven(items, graders.length);
    setManual(new Map([...m].map(([id, c]) => [id, c + 1] as [string, number])));
  };

  const addGrader = () => {
    const g = { key: nextKey++, name: "" };
    setGraders((gs) => [...gs, g]); // while following "split evenly", the new person is included automatically
    setTimeout(() => nameRefs.current.get(g.key)?.focus(), 0);
  };
  const removeGrader = (idx: number) => {
    // their cards go back to you; later columns shift left
    if (manual) {
      const col = idx + 1;
      setManual(new Map([...manual].map(([id, c]) => [id, c === col ? 0 : c > col ? c - 1 : c] as [string, number])));
    }
    setGraders((gs) => gs.filter((_, i) => i !== idx));
  };

  // ---- drag a card between columns (pointer events: HTML5 drag doesn't work in the webview) ----
  const colAt = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-col]");
    return el ? Number(el.dataset.col) : null;
  };
  const onCardDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    press.current = { id, x: e.clientX, y: e.clientY, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onCardMove = (e: React.PointerEvent) => {
    const p = press.current;
    if (!p) return;
    if (!p.moved && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 5) return;
    p.moved = true;
    setPicker(null);
    setDrag({ id: p.id, x: e.clientX, y: e.clientY, over: colAt(e.clientX, e.clientY) });
  };
  const onCardUp = (e: React.PointerEvent) => {
    const p = press.current;
    press.current = null;
    if (!p) return;
    if (p.moved) {
      const c = colAt(e.clientX, e.clientY);
      if (c !== null) moveTo(p.id, c);
      setDrag(null);
    } else if (cols === 2) {
      moveTo(p.id, colOf(p.id) === 0 ? 1 : 0);
    } else {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setPicker({ id: p.id, x: r.left, y: r.bottom + 4 });
    }
  };

  const create = async () => {
    const plan = graders
      .map((g, i) => ({ name: g.name.trim(), chosen: remaining.filter((r) => colOf(r.task.id) === i + 1) }))
      .filter((p) => p.chosen.length);
    if (!plan.length || plan.some((p) => !p.name)) return;
    const names = plan.map((p) => p.name.toLowerCase());
    if (new Set(names).size !== names.length) {
      setStatus({ ok: false, text: "Give each grader a different name." });
      return;
    }
    const fileFor = (name: string) => `${safeFileName(`${session.name} - ${name}`)}.msgpack`;
    let paths: string[];
    if (plan.length === 1) {
      const p = await save({
        defaultPath: joinPath(dirname(session.sessionPath), fileFor(plan[0].name)),
        filters: [{ name: "Hand-off pack", extensions: ["msgpack"] }],
      });
      if (!p) return;
      paths = [p.endsWith(".msgpack") ? p : `${p}.msgpack`];
    } else {
      const d = await open({
        directory: true,
        title: `Choose a folder for the ${plan.length} pack files`,
        defaultPath: dirname(session.sessionPath),
      });
      if (typeof d !== "string") return;
      paths = plan.map((p) => joinPath(d, fileFor(p.name)));
    }
    const made: Handoff[] = [];
    try {
      for (let i = 0; i < plan.length; i++) {
        const { name, chosen } = plan[i];
        const pack = makePack(session, name, chosen.map((r) => r.task.id), chosen.flatMap((r) => r.pinIds));
        await writeText(paths[i], JSON.stringify(pack));
        made.push({ id: pack.id, guest: name, createdAt: pack.createdAt, taskIds: pack.taskIds, pinIds: pack.pinIds, status: "out" });
      }
    } catch (e) {
      setStatus({ ok: false, text: `Could not save a pack: ${e}` });
    }
    if (!made.length) return;
    setHandoffs([...(session.handoffs ?? []), ...made]);
    setManual(new Map());
    const pins = made.reduce((a, h) => a + h.pinIds.length, 0);
    setStatus({
      ok: true,
      text:
        made.length === 1
          ? `Pack for ${made[0].guest} saved: ${pins} pins in ${made[0].taskIds.length} images. Send them the file; those pins are locked here until you import their results.`
          : `${made.length} packs saved (${made.map((h) => h.guest).join(", ")}): ${pins} pins. Send each person their file; those pins are locked here until you import results.`,
    });
  };

  const importResults = async () => {
    const p = await open({ filters: [{ name: "Hand-off results", extensions: ["msgresult"] }] });
    if (typeof p !== "string") return;
    try {
      const r = parseResult(await readText(p));
      const m = mergeResult(session, r);
      applyResult(m.grades, m.handoffs);
      setStatus({
        ok: true,
        text: `Merged ${m.merged} grades from ${r.guest}.${m.skipped ? ` ${m.skipped} pins you had already graded were kept as yours.` : ""}`,
      });
    } catch (e) {
      setStatus({ ok: false, text: String(e instanceof Error ? e.message : e) });
    }
  };

  const recall = (id: string) => {
    const h = (session.handoffs ?? []).find((x) => x.id === id);
    if (!h || !confirm(`Take back the work given to ${h.guest}? Their pins unlock here; if they send results later, only pins you haven't graded will be merged.`)) return;
    setHandoffs((session.handoffs ?? []).map((x) => (x.id === id ? { ...x, status: "recalled" as const } : x)));
  };

  const packs = [...(session.handoffs ?? [])].reverse();
  const busyGraders = graders.filter((_, i) => load[i + 1] > 0);
  const missingName = busyGraders.some((g) => !g.name.trim());
  const packCount = busyGraders.length;
  const dragItem = drag && remaining.find((r) => r.task.id === drag.id);

  return (
    <div className="modal-backdrop" onMouseDown={onClose} onClick={() => setPicker(null)}>
      <div className="modal handoff-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ho-head">
          <h2>Hand off work</h2>
          <button className="ho-help" onClick={() => setStore({ help: "handoff" })} title="How hand-off works" aria-label="Help">
            ?
          </button>
        </div>
        <p className="muted small">
          Share what's left with other graders. Each gets a pack file, grades it in their own copy of the app, and sends
          back a results file. Handed-off pins are locked here so nobody grades them twice.
        </p>

        <div className="ho-people">
          <span className="ho-chip you">
            <i style={{ background: hue(0) }} />
            You
          </span>
          {graders.map((g, i) => (
            <span key={g.key} className="ho-chip">
              <i style={{ background: hue(i + 1) }} />
              <input
                ref={(el) => {
                  if (el) nameRefs.current.set(g.key, el);
                  else nameRefs.current.delete(g.key);
                }}
                className="ho-name"
                placeholder={`Grader ${i + 1} name`}
                value={g.name}
                size={Math.max(8, (g.name || `Grader ${i + 1} name`).length)}
                onChange={(e) => setGraders((gs) => gs.map((x) => (x.key === g.key ? { ...x, name: e.target.value } : x)))}
                autoFocus={i === 0}
              />
              {graders.length > 1 && (
                <button className="ho-x" onClick={() => removeGrader(i)} title="Remove this grader" aria-label={`Remove ${nameOf(i + 1)}`}>
                  ×
                </button>
              )}
            </span>
          ))}
          <button className="ho-add" onClick={addGrader}>
            + Add grader
          </button>
        </div>

        {remaining.length === 0 ? (
          <div className="ex-empty">Nothing left to hand off: every remaining pin is graded or already out with someone.</div>
        ) : (
          <>
            <div className="ho-bar" title={load.map((n, c) => `${nameOf(c)}: ${n}`).join(" · ")}>
              {load.map((n, c) => (
                <span key={c} style={{ flexGrow: Math.max(0.0001, n), background: hue(c) }}>
                  {n > 0 && total > 0 && n / total > 0.12 ? `${nameOf(c)} · ${n}` : ""}
                </span>
              ))}
            </div>
            <div className="ho-cols" style={{ gridTemplateColumns: `repeat(${Math.min(cols, 4)}, minmax(0, 1fr))` }}>
              {Array.from({ length: cols }, (_, c) => (
                <div
                  key={c}
                  data-col={c}
                  className={`ho-col${c === 0 ? " you" : ""}${drag?.over === c ? " over" : ""}`}
                  style={{ ["--hue" as string]: hue(c) }}
                >
                  <div className="ho-col-h">
                    <span className="ho-col-name">{nameOf(c)}</span>
                    <span className="ho-col-n">
                      {load[c]} pin{load[c] === 1 ? "" : "s"}
                    </span>
                  </div>
                  {remaining
                    .filter((r) => colOf(r.task.id) === c)
                    .map((r) => (
                      <button
                        key={r.task.id}
                        className={`ho-card${drag?.id === r.task.id ? " lifted" : ""}`}
                        onPointerDown={(e) => onCardDown(e, r.task.id)}
                        onPointerMove={onCardMove}
                        onPointerUp={onCardUp}
                        onClick={(e) => e.stopPropagation()}
                        title={cols === 2 ? "Click or drag to move" : "Drag to a grader, or click to choose"}
                      >
                        <span className="ho-l">{label(r.task)}</span>
                        <span className="ho-n">{r.pinIds.length}</span>
                      </button>
                    ))}
                  {load[c] === 0 && <div className="ho-drop">Drop images here</div>}
                </div>
              ))}
            </div>
            <div className="ho-quick">
              <button className="btn ghost small" onClick={() => setManual(null)} title="Share the pins evenly between everyone, including you">
                Split evenly
              </button>
              <button className="btn ghost small" onClick={giveAway} title="Share everything between the other graders">
                Give all away
              </button>
              <button className="btn ghost small" onClick={() => setManual(new Map(items.map((i) => [i.id, 0] as [string, number])))}>
                Keep all
              </button>
              <span className="grow" />
              <span className="muted small">Drag cards between people{cols > 2 ? ", or click one to choose" : ", or click to move"}</span>
            </div>
          </>
        )}

        {packs.length > 0 && (
          <div className="ho-packs">
            <div className="ex-sub">
              <span>Packs</span>
            </div>
            {packs.map((h) => (
              <div key={h.id} className={`ho-pack ${h.status}`}>
                <span className="ho-who">{h.guest}</span>
                <span className="muted small">
                  {h.pinIds.length} pins · {h.taskIds.length} images · {new Date(h.createdAt).toLocaleDateString()}
                </span>
                <span className={`pill ${h.status}`}>
                  {h.status === "out" ? "out" : h.status === "returned" ? `returned · ${h.mergedCount ?? 0} merged` : "recalled"}
                </span>
                {h.status === "out" ? (
                  <button className="btn ghost small" onClick={() => recall(h.id)}>
                    Recall
                  </button>
                ) : (
                  <span />
                )}
              </div>
            ))}
          </div>
        )}

        {status && <p className={status.ok ? "ok-text" : "warn"}>{status.text}</p>}
        <div className="modal-actions">
          <button onClick={onClose}>Close</button>
          <button onClick={importResults} disabled={!packs.length}>
            Import results…
          </button>
          <div className="grow" />
          <button
            className="primary"
            onClick={create}
            disabled={outPins === 0 || missingName}
            title={missingName ? "Name every grader who has work" : undefined}
          >
            {packCount > 1 ? `Create ${packCount} packs (${outPins} pins)…` : `Create pack (${outPins} pins)…`}
          </button>
        </div>

      </div>
    {picker && (
        <div className="ho-picker" style={{ left: picker.x, top: picker.y }} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
          <div className="muted small">Move to</div>
          {Array.from({ length: cols }, (_, c) => (
            <button
              key={c}
              className={colOf(picker.id) === c ? "on" : ""}
              onClick={() => {
                moveTo(picker.id, c);
                setPicker(null);
              }}
            >
              <i style={{ background: hue(c) }} />
              {nameOf(c)}
            </button>
          ))}
        </div>
      )}
      {drag && dragItem && (
        <div className="ho-ghost" style={{ left: drag.x, top: drag.y }}>
          <span className="ho-l">{label(dragItem.task)}</span>
          <span className="ho-n">{dragItem.pinIds.length}</span>
        </div>
      )}
    </div>
  );
}
