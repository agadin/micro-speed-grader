import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import { clamp } from "../lib/util";

/** Small controls shared by several screens. */

/** slim slider + numeric field with unit */
export function SliderRow(p: { label: string; value: number; min: number; max: number; unit: string; onChange: (v: number) => void }) {
  return (
    <div className="prow">
      <span className="plabel">{p.label}</span>
      <input
        type="range"
        min={p.min}
        max={p.max}
        value={p.value}
        onChange={(e) => p.onChange(Number(e.target.value))}
        style={{ ["--fill" as string]: `${((p.value - p.min) / (p.max - p.min)) * 100}%` }}
      />
      <label className="num">
        <input
          type="number"
          min={p.min}
          max={p.max}
          value={p.value}
          onChange={(e) => e.target.value !== "" && p.onChange(clamp(Number(e.target.value), p.min, p.max))}
        />
        <u>{p.unit}</u>
      </label>
    </div>
  );
}

/** a search box with a magnifier: Esc clears it (and doesn't close whatever it's in), ↵ runs onEnter */
export function SearchField(p: {
  className: string;
  value: string;
  onChange: (v: string) => void;
  onEnter?: () => void;
  /** Esc on an empty field */
  onEscape?: () => void;
  /** keys other than Esc / ↵ (e.g. ↑ ↓ to move through results) */
  onKey?: (e: ReactKeyboardEvent<HTMLInputElement>) => void;
  autoFocus?: boolean;
  title?: string;
  placeholder?: string;
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  return (
    <label className={p.className} title={p.title}>
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
        <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <input
        ref={p.inputRef}
        autoFocus={p.autoFocus}
        placeholder={p.placeholder ?? "Search"}
        value={p.value}
        onChange={(e) => p.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && p.value) {
            e.stopPropagation();
            p.onChange("");
          } else if (e.key === "Escape" && p.onEscape) {
            e.stopPropagation();
            p.onEscape();
          } else if (e.key === "Enter") p.onEnter?.();
          else p.onKey?.(e);
        }}
      />
    </label>
  );
}

/** briefly highlight an element with a CSS animation class (restarts it if it's already running) */
export function flash(el: HTMLElement, className: string) {
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
}
