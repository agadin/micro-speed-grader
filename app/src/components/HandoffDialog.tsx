import { useMemo, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { Session, Task } from "../lib/types";
import { useStore } from "../lib/store";
import { dirname, joinPath, readText, writeText } from "../lib/backend";
import { HOST, makePack, mergeResult, parseResult, planOverlap, recallChecks, remainingByTask, seeded, splitWeighted, type Check, type Handoff } from "../lib/handoff";
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
  /** grade twice: share of each image's pins also given to a second person (0 = off) */
  const [twice, setTwice] = useState(0);
  const [includeMe, setIncludeMe] = useState(true);
  const [seed] = useState(() => Math.floor(Math.random() * 1e9));

  const remaining = useMemo(() => remainingByTask(session, tasks).filter((r) => r.pinIds.length), [session, tasks]);
  const items = useMemo(() => remaining.map((r) => ({ id: r.task.id, n: r.pinIds.length })), [remaining]);
  const cols = graders.length + 1;
  /** each person's share of the pins in %, [you, grader 1, …]; null = equal */
  const [shares, setShares] = useState<number[] | null>(null);
  const sharesArr = shares && shares.length === cols ? shares : roundTo100(equalShares(cols), -1);
  const assign = manual ?? splitWeighted(items, sharesArr);
  const colOf = (id: string) => Math.min(assign.get(id) ?? 0, cols - 1);
  // pins graded twice: who grades each one second
  const partners = useMemo(() => [...(includeMe ? [0] : []), ...graders.map((_, i) => i + 1)], [includeMe, graders]);
  const overlap = useMemo(
    () =>
      planOverlap(
        remaining.map((r) => ({ taskId: r.task.id, pinIds: r.pinIds, col: colOf(r.task.id) })),
        partners,
        twice / 100,
        seeded(seed),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [remaining, partners, twice, seed, [...assign].join()],
  );
  const extra = Array.from({ length: cols }, (_, c) => [...overlap.values()].filter(([, b]) => b === c).length);
  const twiceOk = partners.length >= 2;
  const load = Array.from({ length: cols }, (_, c) => items.filter((i) => colOf(i.id) === c).reduce((a, b) => a + b.n, 0));
  const total = load.reduce((a, b) => a + b, 0);
  const outPins = total - load[0] + [...overlap.values()].filter(([a, b]) => a === 0 && b !== 0).length;
  const nameOf = (c: number) => (c === 0 ? "You" : graders[c - 1].name.trim() || `Grader ${c}`);
  const label = (t: Task) => `Q${t.q} · ${t.slide}${t.slideCount > 1 ? ` (${t.slideIndex + 1}/${t.slideCount})` : ""}`;

  const moveTo = (id: string, col: number) => {
    const next = new Map(items.map((i) => [i.id, colOf(i.id)] as [string, number]));
    next.set(id, col);
    setManual(next);
  };
  const giveAway = () => {
    setShares([0, ...equalShares(graders.length)]);
    setManual(null);
  };
  /** set one person's %, scaling everyone else so the total stays 100 */
  const setShare = (c: number, v: number) => {
    const val = Math.max(0, Math.min(100, Math.round(v) || 0));
    const cur = [...sharesArr];
    const rest = cur.reduce((a, b, i) => (i === c ? a : a + b), 0);
    const next = cur.map((x, i) => (i === c ? val : rest > 0 ? (x / rest) * (100 - val) : (100 - val) / (cols - 1)));
    setShares(roundTo100(next, c));
    setManual(null);
  };

  const addGrader = () => {
    const g = { key: nextKey++, name: "" };
    setGraders((gs) => [...gs, g]); // the new person gets an equal share; everyone else scales down
    if (shares) setShares(roundTo100([...sharesArr.map((x) => (x * cols) / (cols + 1)), 100 / (cols + 1)], cols));
    setTimeout(() => nameRefs.current.get(g.key)?.focus(), 0);
  };
  const removeGrader = (idx: number) => {
    // their cards go back to you; later columns shift left
    if (manual) {
      const col = idx + 1;
      setManual(new Map([...manual].map(([id, c]) => [id, c === col ? 0 : c > col ? c - 1 : c] as [string, number])));
    }
    setGraders((gs) => gs.filter((_, i) => i !== idx));
    if (shares) {
      const left = sharesArr.filter((_, i) => i !== idx + 1);
      const sum = left.reduce((a, b) => a + b, 0);
      setShares(sum > 0 ? roundTo100(left.map((x) => (x / sum) * 100), -1) : null);
    }
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
      .map((g, i) => {
        const col = i + 1;
        const own = remaining.filter((r) => colOf(r.task.id) === col);
        // overlap pins this person grades second, on images someone else has
        const second = [...overlap].filter(([, [, b]]) => b === col).map(([id]) => id);
        const secondTasks = remaining.filter((r) => colOf(r.task.id) !== col && r.pinIds.some((id) => second.includes(id)));
        const pinIds = [...own.flatMap((r) => r.pinIds), ...second];
        const checkPins = pinIds.filter((id) => overlap.has(id));
        return { name: g.name.trim(), col, taskIds: [...own, ...secondTasks].map((r) => r.task.id), pinIds, checkPins, own: own.length };
      })
      .filter((p) => p.pinIds.length);
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
        const { name, taskIds, pinIds, checkPins } = plan[i];
        const pack = makePack(session, name, taskIds, pinIds);
        await writeText(paths[i], JSON.stringify(pack));
        made.push({ id: pack.id, guest: name, createdAt: pack.createdAt, taskIds, pinIds, status: "out", ...(checkPins.length ? { checkPins } : {}) });
      }
    } catch (e) {
      setStatus({ ok: false, text: `Could not save a pack: ${e}` });
    }
    if (!made.length) return;
    // record the pins graded twice: who grades each (only for packs that were actually written)
    const sent = new Set(made.map((h) => h.guest));
    const nameAt = (c: number) => (c === 0 ? HOST : graders[c - 1].name.trim());
    const checks: Record<string, Check> = { ...(session.grades.checks ?? {}) };
    const taskOfPin = new Map(remaining.flatMap((r) => r.pinIds.map((id) => [id, r.task.id] as [string, string])));
    for (const [id, [a, b]] of overlap) {
      const who = [nameAt(a), nameAt(b)];
      if (who.some((x) => x !== HOST && !sent.has(x))) continue;
      checks[id] = { taskId: taskOfPin.get(id)!, graders: who, verdicts: [], state: "waiting" };
    }
    if (overlap.size) applyResult({ ...session.grades, checks }, [...(session.handoffs ?? []), ...made]);
    else setHandoffs([...(session.handoffs ?? []), ...made]);
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
      const parts = [
        `Merged ${m.merged} grade${m.merged === 1 ? "" : "s"} from ${r.guest}.`,
        m.updated ? `${m.updated} of their earlier grades were updated.` : "",
        m.skipped ? `${m.skipped} pin${m.skipped === 1 ? "" : "s"} you had graded yourself kept your grade.` : "",
        m.waiting ? `${m.waiting} pin${m.waiting === 1 ? " is" : "s are"} graded twice and waiting for the other grader.` : "",
        m.conflicts ? `${m.conflicts} disagreement${m.conflicts === 1 ? "" : "s"} to resolve: see Disagreements in the top bar.` : "",
      ];
      setStatus({ ok: !m.conflicts, text: parts.filter(Boolean).join(" ") });
    } catch (e) {
      setStatus({ ok: false, text: String(e instanceof Error ? e.message : e) });
    }
  };

  const recall = (id: string) => {
    const h = (session.handoffs ?? []).find((x) => x.id === id);
    if (!h || !confirm(`Take back the work given to ${h.guest}? Their pins unlock here; if they send results later, only pins you haven't graded will be merged.`)) return;
    const handoffs = (session.handoffs ?? []).map((x) => (x.id === id ? { ...x, status: "recalled" as const } : x));
    if (h.checkPins?.length) applyResult(recallChecks(session.grades, h.guest, h.pinIds, new Map(session.pins.map((p) => [p.id, p]))), handoffs);
    else setHandoffs(handoffs);
  };

  const packs = [...(session.handoffs ?? [])].reverse();
  const busyGraders = graders.filter((_, i) => load[i + 1] > 0 || extra[i + 1] > 0);
  const missingName = busyGraders.some((g) => !g.name.trim());
  const packCount = busyGraders.length;
  const dragItem = drag && remaining.find((r) => r.task.id === drag.id);

  return (
    <div className="modal-backdrop" onMouseDown={onClose} onClick={() => setPicker(null)}>
      <div className="modal handoff-modal" data-help="handoff" onMouseDown={(e) => e.stopPropagation()}>
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
            <ShareField value={sharesArr[0]} onChange={(v) => setShare(0, v)} who="your" />
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
              <ShareField value={sharesArr[i + 1]} onChange={(v) => setShare(i + 1, v)} who={`${nameOf(i + 1)}'s`} />
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
            <div
              className="ho-bar"
              title={load.map((n, c) => `${nameOf(c)}: ${n}${extra[c] ? ` + ${extra[c]} graded twice` : ""}`).join(" · ")}
            >
              {load.map((n, c) => {
                const all = n + extra[c];
                const wide = all > 0 && all / (total + overlap.size) > 0.14;
                return (
                  <span key={c} className="ho-seg" style={{ flexGrow: Math.max(0.0001, all), ["--hue" as string]: hue(c) }}>
                    <i className="ho-seg-own" style={{ flexGrow: n }} />
                    {extra[c] > 0 && <i className="ho-seg-twice" style={{ flexGrow: extra[c] }} />}
                    {wide && (
                      <span className="ho-seg-l">
                        {nameOf(c)} · {n}
                        {total > 0 && <span className="ho-seg-x">({Math.round((n / total) * 100)}%)</span>}
                        {extra[c] > 0 && <span className="ho-seg-x">+ {extra[c]} twice</span>}
                      </span>
                    )}
                  </span>
                );
              })}
            </div>
            {overlap.size > 0 && (
              <div className="ho-legend muted small">
                <i className="ho-key" /> solid: their own images · <i className="ho-key twice" /> striped: pins someone else also grades
              </div>
            )}
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
                      {extra[c] > 0 && <span className="ho-twice-n" title="Pins from other people's images this person also grades"> +{extra[c]} twice</span>}
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
              <button
                className="btn ghost small"
                onClick={() => {
                  setShares(null);
                  setManual(null);
                }}
                title="Share the pins evenly between everyone, including you"
              >
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
            <div className={`ho-twice${twice > 0 ? " on" : ""}`} data-help="handoff/grade-some-pins-twice">
              <label className="ho-twice-l" title="Give some pins to two people. Neither sees the other's grade; if they disagree, you decide.">
                <input type="checkbox" checked={twice > 0} onChange={(e) => setTwice(e.target.checked ? 15 : 0)} />
                Grade some pins twice
              </label>
              {twice > 0 && (
                <>
                  <input
                    type="range"
                    min={5}
                    max={50}
                    step={5}
                    value={twice}
                    onChange={(e) => setTwice(Number(e.target.value))}
                    aria-label="Share of pins graded twice"
                  />
                  <b className="ho-twice-pct">{twice}%</b>
                  <label className="ho-twice-me" title="On: you grade some pins that others also grade. Off: overlaps are only between the other graders, and you just settle disagreements.">
                    <input type="checkbox" checked={includeMe} onChange={(e) => setIncludeMe(e.target.checked)} />
                    Include me
                  </label>
                </>
              )}
              {twice > 0 && (
                <span className="ho-twice-sum muted small">
                  {twiceOk
                    ? `${overlap.size} pin${overlap.size === 1 ? "" : "s"} graded by two people, blind. Disagreements come back to you.`
                    : "Needs at least two people grading: add a grader or include yourself."}
                </span>
              )}
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
                  {h.pinIds.length} pins{h.checkPins?.length ? ` (${h.checkPins.length} twice)` : ""} · {h.taskIds.length} images ·{" "}
                  {new Date(h.createdAt).toLocaleDateString()}
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

const equalShares = (k: number) => new Array(k).fill(k ? 100 / k : 0);
/** round to whole percents that add up to exactly 100, putting the rounding error on someone other than `keep` */
function roundTo100(xs: number[], keep: number) {
  const r = xs.map((x) => Math.max(0, Math.round(x)));
  const diff = 100 - r.reduce((a, b) => a + b, 0);
  if (diff) {
    let j = -1;
    for (let i = 0; i < r.length; i++) if (i !== keep && (j < 0 || r[i] > r[j])) j = i;
    if (j >= 0) r[j] = Math.max(0, r[j] + diff);
  }
  return r;
}

/** a small "40 %" field on a person's chip: their target share of the pins */
function ShareField({ value, onChange, who }: { value: number; onChange: (v: number) => void; who: string }) {
  return (
    <label className="ho-pct" title={`Target: ${who} share of the remaining pins. Images stay whole, so the split gets as close as it can.`}>
      <input
        type="number"
        min={0}
        max={100}
        step={5}
        value={Math.round(value)}
        onChange={(e) => e.target.value !== "" && onChange(Number(e.target.value))}
        aria-label={`${who} share in percent`}
      />
      %
    </label>
  );
}

