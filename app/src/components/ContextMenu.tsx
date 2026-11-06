import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { IconCheck, IconCross, IconEraser, IconHalf, IconTarget } from "./icons";
import type { MenuState } from "../lib/store";
import type { GradeState } from "../lib/types";
import { reasonSuggestions } from "../lib/grading";
import type { Settings } from "../lib/settings";

interface Props {
  menu: MenuState;
  grades: GradeState;
  q: number;
  settings: Settings;
  anyGraded: boolean;
  onGrade: (status: "correct" | "wrong", text: string) => void;
  onInvert: () => void;
  onIsolate: () => void;
  onUngrade: () => void;
  onMode: (mode: MenuState["mode"]) => void;
  onClose: () => void;
}

const mod = navigator.userAgent.includes("Mac") ? "⌘" : "Ctrl+";

export function ContextMenu({ menu, grades, q, settings, anyGraded, onGrade, onInvert, onIsolate, onUngrade, onMode, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [hi, setHi] = useState(-1);
  const [shake, setShake] = useState(false);
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });

  const status = menu.mode === "wrong" ? "wrong" : "correct";
  const suggestions = useMemo(
    () => (menu.mode === "root" ? [] : reasonSuggestions(grades, q, status, text)),
    [grades, q, status, text, menu.mode],
  );

  // focus before the browser paints, so keys typed right after W land in the reason box
  useLayoutEffect(() => {
    setText("");
    setHi(-1);
    if (menu.mode !== "root") inputRef.current?.focus();
    else ref.current?.focus();
  }, [menu.mode]);

  // keep the menu on screen
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(8, Math.min(menu.x, window.innerWidth - r.width - 8)),
      y: Math.max(8, Math.min(menu.y, window.innerHeight - r.height - 8)),
    });
  }, [menu.x, menu.y, menu.mode, suggestions.length]);

  const submit = (value?: string) => {
    const v = (value ?? (hi >= 0 ? suggestions[hi] : text)).trim();
    if (status === "wrong" && !v) {
      if (settings.wrongNeedsReason) {
        setShake(true);
        setTimeout(() => setShake(false), 350);
        return;
      }
      onGrade("wrong", settings.wrongDefaultText);
      return;
    }
    onGrade(status, v);
  };

  const onRootKey = (e: React.KeyboardEvent) => {
    const k = e.key.toLowerCase();
    e.stopPropagation();
    if (k === "escape") return onClose();
    if (k === "c" && e.shiftKey) {
      e.preventDefault();
      return onMode("correct");
    }
    if (k === "c" || k === "enter") return onGrade("correct", "");
    if (k === "w") {
      e.preventDefault();
      return onMode("wrong");
    }
    if (k === "x") return onInvert();
    if (k === "i") return onIsolate();
    if (k === "u" && anyGraded) return onUngrade();
  };

  const onInputKey = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") return onMode("root");
    if (e.key === "Enter") {
      e.preventDefault();
      return submit();
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHi((h) => Math.min(suggestions.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi((h) => Math.max(-1, h - 1));
    } else if (e.key === "Tab") {
      e.preventDefault();
      const s = suggestions[Math.max(0, hi)];
      if (s) {
        setText(s);
        setHi(-1);
      }
    } else if (/^[1-9]$/.test(e.key) && (!text || e.metaKey || e.ctrlKey)) {
      // empty box: plain digit picks; while typing: ⌘/Ctrl + digit (so reasons with digits still type)
      const s = suggestions[Number(e.key) - 1];
      if (s) {
        e.preventDefault();
        submit(s);
      }
    }
  };

  return (
    <>
      <div className="menu-backdrop" onMouseDown={onClose} onContextMenu={(e) => (e.preventDefault(), onClose())} />
      <div
        ref={ref}
        className={`ctx-menu ${shake ? "shake" : ""}`}
        style={{ left: pos.x, top: pos.y }}
        tabIndex={-1}
        onKeyDown={menu.mode === "root" ? onRootKey : undefined}
      >
        {menu.mode === "root" && (
          <>
            <div className="ctx-title">
              <span>
                <b>{menu.pinIds.length}</b> pin{menu.pinIds.length === 1 ? "" : "s"} selected
              </span>
              <span>{menu.title.replace(/ · \d+ pins$/, "").replace(/^\d+ pins selected$/, "")}</span>
            </div>
            <Item k={["C"]} icon={<IconCheck />} label="Mark correct" cls="ok" onClick={() => onGrade("correct", "")} />
            <Item k={["⇧", "C"]} icon={<IconCheck />} label="Correct with note…" cls="ok" onClick={() => onMode("correct")} />
            <Item k={["W"]} icon={<IconCross />} label="Mark wrong…" cls="bad" onClick={() => onMode("wrong")} />
            <div className="ctx-sep" />
            <Item k={["X"]} icon={<IconHalf />} label="Invert selection" onClick={onInvert} />
            <Item k={["I"]} icon={<IconTarget />} label="Isolate" onClick={onIsolate} />
            {anyGraded && <Item k={["U"]} icon={<IconEraser />} label="Remove grade" onClick={onUngrade} />}
            <div className="ctx-sep" />
            <Item k={["Esc"]} label="Close" onClick={onClose} />
          </>
        )}
        {menu.mode !== "root" && (
          <div className="ctx-entry">
            <div className="ctx-title">
              <span className={status === "wrong" ? "bad" : "ok"}>
                Mark <b>{menu.pinIds.length}</b> pin{menu.pinIds.length === 1 ? "" : "s"} {status}
                {status === "wrong" ? (settings.wrongNeedsReason ? "" : ` (blank = “${settings.wrongDefaultText}”)`) : " · optional note"}
              </span>
              <button className="back" onClick={() => onMode("root")}>
                back <span className="kbd">Esc</span>
              </button>
            </div>
            <input
              ref={inputRef}
              autoFocus
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setHi(-1);
              }}
              onKeyDown={onInputKey}
              placeholder={status === "wrong" ? "What did they mark? e.g. Neutrophil" : "note (optional)"}
            />
            {suggestions.length > 0 && <div className="ctx-sublbl">{text ? "Matches" : "Recent reasons"}</div>}
            {suggestions.length > 0 && (
              <ul className="ctx-suggest">
                {suggestions.map((s, i) => (
                  <li key={s} className={i === hi ? "hi" : ""} onMouseDown={(e) => (e.preventDefault(), submit(s))}>
                    <span className="kbd">{i < 9 ? (text ? `${mod}${i + 1}` : i + 1) : ""}</span>
                    {s}
                  </li>
                ))}
              </ul>
            )}
            <div className="ctx-hint">
              <span>
                <span className="kbd">↵</span> apply
              </span>
              <span>
                <span className="kbd">⇥</span> complete
              </span>
              {suggestions.length > 0 && (
                <span>
                  <span className="kbd">{text ? `${mod}1` : 1}</span>–
                  <span className="kbd">{text ? `${mod}${Math.min(9, suggestions.length)}` : Math.min(9, suggestions.length)}</span> pick
                </span>
              )}
              {status === "wrong" && settings.wrongNeedsReason && <span className="req">required</span>}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function Item({ k, label, onClick, cls, icon }: { k: string[]; label: string; onClick: () => void; cls?: string; icon?: ReactNode }) {
  return (
    <button className={`ctx-item ${cls ?? ""}`} onClick={onClick}>
      <span className="ic">{icon}</span>
      <span>{label}</span>
      <span className="kk">
        {k.map((x) => (
          <span className="kbd" key={x}>
            {x}
          </span>
        ))}
      </span>
    </button>
  );
}
