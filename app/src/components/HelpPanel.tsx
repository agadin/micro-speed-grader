import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { HOME, TOPICS, article, helpImage, parseRef, searchHelp } from "../lib/help";
import { renderMarkdown } from "../lib/markdown";

/**
 * The help wiki viewer, in the style of macOS Help: a home page with topics, search, one article at a time
 * and a back button. Articles come from docs/help/*.md (see lib/help.ts).
 */

const openExternal = async (url: string) => {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch {
    window.open(url, "_blank", "noopener");
  }
};

function HelpBrowser({ initial, onClose, dragProps }: { initial: string; onClose?: () => void; dragProps?: React.HTMLAttributes<HTMLDivElement> }) {
  const [stack, setStack] = useState<string[]>([initial || "index"]);
  const [q, setQ] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const cur = stack[stack.length - 1];
  const { id, anchor } = parseRef(cur);
  const a = article(id) ?? HOME;
  const hits = useMemo(() => searchHelp(q), [q]);

  // a new request from the app (e.g. the ? on a tooltip) replaces what's shown
  useEffect(() => {
    if (initial) {
      setStack((s) => (s[s.length - 1] === initial ? s : [...s, initial]));
      setQ("");
    }
  }, [initial]);

  useLayoutEffect(() => {
    const el = anchor ? bodyRef.current?.querySelector<HTMLElement>(`#${CSS.escape(anchor)}`) : null;
    if (el) {
      bodyRef.current!.scrollTop = el.offsetTop - 12;
      el.classList.remove("hp-flash");
      void el.offsetWidth;
      el.classList.add("hp-flash");
    } else bodyRef.current?.scrollTo(0, 0);
  }, [cur, anchor]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.metaKey && e.key === "[") {
        setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const go = (ref: string) => {
    setQ("");
    setStack((s) => [...s, ref]);
  };
  const onLink = (href: string) => {
    if (/^https?:\/\//.test(href)) void openExternal(href);
    else if (href.startsWith("#")) go(`${a?.id ?? "index"}/${href.slice(1)}`);
    else {
      const r = parseRef(href);
      go(r.anchor ? `${r.id}/${r.anchor}` : r.id);
    }
  };

  return (
    <>
      <div className="hp-bar" {...dragProps}>
        <button className="hp-ic" disabled={stack.length < 2} onClick={() => setStack((s) => s.slice(0, -1))} title="Back (⌘[)" aria-label="Back">
          ‹
        </button>
        <button className="hp-ic hp-home" disabled={id === "index" && !q} onClick={() => go("index")} title="Help home" aria-label="Help home">
          ⌂
        </button>
        <label className="hp-search">
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <input
            ref={searchRef}
            placeholder="Search help"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && q) {
                e.stopPropagation();
                setQ("");
              } else if (e.key === "Enter" && hits[0]) go(hits[0].anchor ? `${hits[0].id}/${hits[0].anchor}` : hits[0].id);
            }}
          />
        </label>
        {onClose && (
          <button className="hp-ic" onClick={onClose} title="Close (Esc)" aria-label="Close help">
            ×
          </button>
        )}
      </div>
      <div className="hp-body" ref={bodyRef}>
        {q.trim() ? (
          <div className={hits.length ? "hp-results hp-group" : "hp-results"}>
            {hits.length ? (
              hits.map((h, i) => (
                <button key={i} className="hp-hit" onClick={() => go(h.anchor ? `${h.id}/${h.anchor}` : h.id)}>
                  <span className="hp-row-tx">
                    <b>{h.anchor ? h.label : h.title}</b>
                    <span className="muted small">{h.anchor ? h.title : h.label}</span>
                  </span>
                  <span className="hp-chev" aria-hidden>
                    ›
                  </span>
                </button>
              ))
            ) : (
              <p className="muted">No articles match “{q}”.</p>
            )}
          </div>
        ) : a ? (
          <article className="hp-article" key={a.id}>
            {renderMarkdown(a, { image: helpImage, onLink })}
            {a.id === "index" && (
              <div className="hp-topics hp-group">
                {TOPICS.map((t) => (
                  <button key={t.id} onClick={() => go(t.id)}>
                    <span className="hp-row-tx">
                      <b>{t.title}</b>
                      <span className="muted small">{t.blurb}</span>
                    </span>
                    <span className="hp-chev" aria-hidden>
                      ›
                    </span>
                  </button>
                ))}
              </div>
            )}
          </article>
        ) : (
          <p className="muted">That help page doesn't exist.</p>
        )}
      </div>
    </>
  );
}

/** The separate Help window (index.html?window=help&topic=…), opened by the open_help command. */
export function HelpWindow() {
  const [initial] = useState(() => new URLSearchParams(location.search).get("topic") ?? "");
  return (
    <div className="help-window">
      <HelpBrowser initial={initial} />
    </div>
  );
}

/** Fallback when there's no native window (UI tests in a browser): a floating panel inside the page. */
export function HelpPanel() {
  const topic = useStore((s) => s.help);
  const set = useStore((s) => s.set);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && useStore.getState().help !== null) {
        e.stopPropagation();
        set({ help: null });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [set]);

  if (topic === null) return null;

  const dragProps: React.HTMLAttributes<HTMLDivElement> = {
    onPointerDown: (e) => {
      if ((e.target as HTMLElement).closest("button, input")) return;
      const r = e.currentTarget.parentElement!.getBoundingClientRect();
      drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e) => {
      if (!drag.current) return;
      setPos({
        x: Math.max(8, Math.min(window.innerWidth - 120, e.clientX - drag.current.dx)),
        y: Math.max(8, Math.min(window.innerHeight - 60, e.clientY - drag.current.dy)),
      });
    },
    onPointerUp: () => (drag.current = null),
  };

  return (
    <aside className="help-panel" style={pos ? { left: pos.x, top: pos.y, right: "auto" } : undefined} role="dialog" aria-label="Help">
      <HelpBrowser initial={topic || "index"} onClose={() => set({ help: null })} dragProps={dragProps} />
    </aside>
  );
}
