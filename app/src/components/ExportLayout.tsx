import { useRef, type RefObject } from "react";
import { flushSync } from "react-dom";
import { useSettings } from "../lib/settings";
import { COLUMN_INFO, EXPORT_PRESETS, type ExportColumn } from "../lib/exportCsv";

/** Column arrangement + CSV options. Shared by the Export dialog and Preferences → Export; edits settings directly. */
export function ExportLayoutEditor() {
  const settings = useSettings((s) => s.s);
  const setSettings = useSettings((s) => s.set);
  const listRef = useRef<HTMLUListElement>(null);

  const cols = settings.exportColumns;
  const presetId = EXPORT_PRESETS.find((p) => JSON.stringify(p.columns) === JSON.stringify(cols))?.id ?? "custom";
  const setCols = (c: ExportColumn[]) => setSettings({ exportColumns: c });
  const patchCol = (i: number, patch: Partial<ExportColumn>) => setCols(cols.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const startDrag = useDragSort("y", listRef, (from, to) => setCols(moved(useSettings.getState().s.exportColumns, from, to)));

  return (
    <div className="ex-cols">
      <div className="ex-sub">
        <span>Columns</span>
        <select
          value={presetId}
          onChange={(e) => {
            const p = EXPORT_PRESETS.find((x) => x.id === e.target.value);
            if (p) setCols(p.columns);
          }}
        >
          {EXPORT_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
          {presetId === "custom" && <option value="custom">Custom</option>}
        </select>
      </div>
      <ul className="col-list" ref={listRef}>
        {cols.map((c, i) => (
          <li
            key={c.id}
            title="Drag to reorder"
            className={c.on ? "" : "off"}
            data-di={i}
            onPointerDown={(e) => startDrag(e, i)}
          >
            <span className="grip">
              ⋮⋮
            </span>
            <input type="checkbox" checked={c.on} onChange={(e) => patchCol(i, { on: e.target.checked })} />
            <span className="cl">
              <span className="cn">{COLUMN_INFO[c.id].label}</span>
              {COLUMN_INFO[c.id].hint && <span className="ch">{COLUMN_INFO[c.id].hint}</span>}
            </span>
            <input
              className="input hdr"
              value={c.header}
              title={c.id === "items" ? `Header prefix: ${c.header}1, ${c.header}2 …` : "Header in the CSV"}
              onChange={(e) => patchCol(i, { header: e.target.value })}
            />
          </li>
        ))}
      </ul>
      <div className="ex-opts">
        <label>
          <span>UID</span>
          <select value={settings.exportUid} onChange={(e) => setSettings({ exportUid: e.target.value as "folder" | "blank" })}>
            <option value="folder">Number from the folder name</option>
            <option value="blank">Blank (placeholder)</option>
          </select>
        </label>
        <label>
          <span>Ungraded items</span>
          <select value={settings.exportUngraded} onChange={(e) => setSettings({ exportUngraded: e.target.value as "blank" | "0" })}>
            <option value="blank">Leave blank</option>
            <option value="0">Count as 0</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={settings.exportFeedback} onChange={(e) => setSettings({ exportFeedback: e.target.checked })} />
          Also write <code>feedback/&lt;student&gt;.txt</code>
        </label>
      </div>
    </div>
  );
}

/** move cols[from] to sit where cols[to] is (the rest shift) */
function moved<T>(arr: T[], from: number, to: number) {
  const next = [...arr];
  const [c] = next.splice(from, 1);
  next.splice(to, 0, c);
  return next;
}

/**
 * CSV preview whose header cells can be dragged to reorder columns (writes settings.exportColumns).
 * qCount: how many Q columns the "items" column expands to; they move as one block.
 */
export function CsvPreviewTable({ table, qCount, clip = 40 }: { table: string[][]; qCount: number; clip?: number }) {
  const cols = useSettings((s) => s.s.exportColumns);
  const setSettings = useSettings((s) => s.set);
  const tableRef = useRef<HTMLTableElement>(null);

  // which shown column group (index among the "on" columns) each table column belongs to
  const group: number[] = [];
  cols.filter((c) => c.on).forEach((c, g) => {
    for (let i = 0; i < (c.id === "items" ? qCount : 1); i++) group.push(g);
  });
  const startDrag = useDragSort("x", tableRef, (from, to) => {
    const all = useSettings.getState().s.exportColumns;
    const on = all.flatMap((c, i) => (c.on ? [i] : []));
    setSettings({ exportColumns: moved(all, on[from], on[to]) });
  });

  return (
    <div className="tbl-wrap">
      <table className="csv-table drag-cols" ref={tableRef}>
        <thead>
          <tr>
            {table[0].map((h, j) => (
              <th key={j} data-di={group[j]} title="Drag to reorder" onPointerDown={(e) => startDrag(e, group[j])}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.slice(1).map((r, i) => (
            <tr key={i}>
              {r.map((v, j) => (
                <td key={j} title={v} data-di={group[j]}>
                  {v.length > clip ? v.slice(0, clip).replace(/\n/g, " ") + "…" : v.replace(/\n/g, " ")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const EASE = "transform 200ms cubic-bezier(.2,.8,.3,1)";

/**
 * Pointer-driven drag-to-reorder (HTML5 drag-and-drop doesn't start inside the Tauri webview).
 * Items are the elements under `root` carrying data-di="<index>" (several elements may share an index,
 * e.g. every cell of a table column). The dragged item follows the pointer, the others slide aside,
 * and on release it settles into its slot before onMove(from, to) commits the new order.
 */
function useDragSort(axis: "x" | "y", rootRef: RefObject<HTMLElement | null>, onMove: (from: number, to: number) => void) {
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

  return (e: React.PointerEvent, from: number) => {
    const root = rootRef.current;
    if (e.button !== 0 || !root || (e.target as HTMLElement).closest("input, button, select, textarea, label")) return;
    e.preventDefault();

    const groups: HTMLElement[][] = [];
    for (const el of root.querySelectorAll<HTMLElement>("[data-di]")) (groups[Number(el.dataset.di)] ??= []).push(el);
    const n = groups.length;
    if (n < 2 || !groups[from]) return;
    const scroller = axis === "x" ? root.closest<HTMLElement>(".tbl-wrap") : null;
    const scroll = () => scroller?.scrollLeft ?? 0;
    const sc0 = scroll();
    // item extents in content coordinates
    const span = groups.map((g) => {
      const r = g[0].getBoundingClientRect();
      return axis === "x" ? [r.left + sc0, r.right + sc0] : [r.top, r.bottom];
    });
    const gap = Math.max(0, span[1][0] - span[0][1]);
    const size = span[from][1] - span[from][0] + gap;
    const at = (ev: { clientX: number; clientY: number }) => (axis === "x" ? ev.clientX : ev.clientY);
    const start = at(e) + sc0;
    const T = (d: number) => (d ? (axis === "x" ? `translateX(${d}px)` : `translateY(${d}px)`) : "");
    const all = groups.flat();

    let last = at(e);
    let started = false;
    let to = from;
    let raf = 0;

    const update = () => {
      const d = last + scroll() - start;
      if (!started) {
        if (Math.abs(d) < 4) return;
        started = true;
        document.body.classList.add("drag-sorting");
        for (const el of all) el.style.transition = EASE;
        for (const el of groups[from]) {
          el.classList.add("lifted");
          el.style.transition = "none";
        }
      }
      for (const el of groups[from]) el.style.transform = T(d);
      const c = (span[from][0] + span[from][1]) / 2 + d;
      to = 0;
      for (let i = 0; i < n; i++) if (i !== from && (span[i][0] + span[i][1]) / 2 < c) to++;
      groups.forEach((g, i) => {
        if (i === from) return;
        const shift = from < to && i > from && i <= to ? -size : to < from && i >= to && i < from ? size : 0;
        const tr = T(shift);
        if (g[0].style.transform !== tr) for (const el of g) el.style.transform = tr;
      });
    };

    // nudge the table sideways when dragging near its edges
    const tick = () => {
      if (scroller && started) {
        const r = scroller.getBoundingClientRect();
        const edge = 48;
        const v = last < r.left + edge ? -(r.left + edge - last) / 4 : last > r.right - edge ? (last - (r.right - edge)) / 4 : 0;
        if (v) {
          scroller.scrollLeft += v;
          update();
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const move = (ev: PointerEvent) => {
      last = at(ev);
      update();
    };
    const up = () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      document.body.classList.remove("drag-sorting");
      if (!started) return;
      const settle = to > from ? span[to][1] - span[from][1] : to < from ? span[to][0] - span[from][0] : 0;
      for (const el of groups[from]) {
        el.style.transition = EASE;
        el.style.transform = T(settle);
      }
      setTimeout(() => {
        for (const el of all) {
          el.style.transition = "none";
          el.style.transform = "";
          el.classList.remove("lifted");
        }
        if (to !== from) flushSync(() => onMoveRef.current(from, to));
        requestAnimationFrame(() => {
          for (const el of all) el.style.transition = "";
        });
      }, 200);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
}
