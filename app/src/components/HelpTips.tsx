import { useEffect, useRef, useState } from "react";
import { showHelp } from "../lib/backend";

/**
 * App-styled tooltips for every element with a `title` (the native tooltip is suppressed while hovering),
 * plus a small ? that opens the matching help article when the element or one of its parents has
 * `data-help="article"` or `data-help="article/section"`. Hover the tooltip to reach the ?.
 */
interface Tip {
  text: string;
  help: string | null;
  x: number;
  y: number;
  below: boolean;
}

const SHOW_DELAY = 550;
const HIDE_DELAY = 350;

export function HelpTips() {
  const [tip, setTip] = useState<Tip | null>(null);
  const cur = useRef<HTMLElement | null>(null);
  const showT = useRef<number>(0);
  const hideT = useRef<number>(0);
  const lastShown = useRef(0);
  const tipRef = useRef<HTMLDivElement>(null);
  /** a tooltip is on screen (the handlers can't see React state) */
  const shown = useRef(false);
  /** the element under the pointer most recently, to pick up after a tooltip closes */
  const lastOver = useRef<HTMLElement | null>(null);
  const hideNow = useRef<() => void>(() => {});

  useEffect(() => {
    const restore = (el: HTMLElement | null) => {
      if (el && el.dataset.tipTitle !== undefined) {
        // put the title back so tests, accessibility and other code still see it
        if (!el.hasAttribute("title")) el.setAttribute("title", el.dataset.tipTitle);
        delete el.dataset.tipTitle;
      }
    };
    const hide = (now = false) => {
      clearTimeout(showT.current);
      clearTimeout(hideT.current);
      const go = () => {
        restore(cur.current);
        cur.current = null;
        if (shown.current) lastShown.current = Date.now();
        shown.current = false;
        setTip(null);
        // the pointer moved on to another control while we waited: show its tooltip instead
        if (!now && lastOver.current?.isConnected) start(lastOver.current);
      };
      if (now) go();
      else hideT.current = window.setTimeout(go, HIDE_DELAY);
    };

    const over = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || tipRef.current?.contains(t)) {
        clearTimeout(hideT.current);
        lastOver.current = null;
        return;
      }
      if (e.buttons) return; // dragging
      const el = t.closest<HTMLElement>("[title], [data-tip-title]");
      lastOver.current = el;
      if (el === cur.current) {
        clearTimeout(hideT.current);
        return;
      }
      // a tooltip is up: the pointer may be on its way to it (crossing other controls), so give it time
      if (shown.current) {
        hide();
        return;
      }
      if (cur.current) hide(true);
      if (el) start(el);
    };
    const start = (el: HTMLElement) => {
      const text = el.getAttribute("title") ?? el.dataset.tipTitle ?? "";
      if (!text.trim()) return;
      // suppress the native tooltip while we show ours
      el.dataset.tipTitle = text;
      el.removeAttribute("title");
      cur.current = el;
      const help = el.closest<HTMLElement>("[data-help]")?.dataset.help ?? null;
      const warm = Date.now() - lastShown.current < 400;
      showT.current = window.setTimeout(
        () => {
          if (cur.current !== el || !el.isConnected) return;
          const r = el.getBoundingClientRect();
          const below = r.bottom + 70 < window.innerHeight;
          shown.current = true;
          setTip({ text, help, x: r.left + r.width / 2, y: below ? r.bottom + 6 : r.top - 6, below });
        },
        warm ? 60 : SHOW_DELAY,
      );
    };
    const out = (e: PointerEvent) => {
      const to = e.relatedTarget as HTMLElement | null;
      if (to && (cur.current?.contains(to) || tipRef.current?.contains(to))) return;
      if (cur.current) hide();
    };
    const down = (e: PointerEvent) => {
      if (!tipRef.current?.contains(e.target as Node)) hide(true);
    };
    const key = () => hide(true);
    hideNow.current = () => hide(true);
    document.addEventListener("pointerover", over, true);
    document.addEventListener("pointerout", out, true);
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("blur", key);
    window.addEventListener("scroll", key, true);
    return () => {
      document.removeEventListener("pointerover", over, true);
      document.removeEventListener("pointerout", out, true);
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", key);
      window.removeEventListener("scroll", key, true);
      restore(cur.current);
    };
  }, []);

  // keep the tooltip inside the window
  const [dx, setDx] = useState(0);
  useEffect(() => {
    const el = tipRef.current;
    if (!el || !tip) return;
    const r = el.getBoundingClientRect();
    setDx(r.left < 8 ? 8 - r.left : r.right > window.innerWidth - 8 ? window.innerWidth - 8 - r.right : 0);
  }, [tip]);

  if (!tip) return null;
  return (
    <div
      ref={tipRef}
      className={`tip ${tip.below ? "below" : "above"}`}
      style={{ left: tip.x + dx, top: tip.y }}
      role="tooltip"
    >
      <span className="tip-text">{tip.text}</span>
      {tip.help && (
        <button
          className="tip-help"
          aria-label="Open help article"
          onClick={() => {
            void showHelp(tip.help!);
            hideNow.current();
          }}
        >
          ?
        </button>
      )}
    </div>
  );
}
