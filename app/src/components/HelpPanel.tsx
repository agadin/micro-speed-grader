import { useEffect, useRef, useState, type ReactNode } from "react";
import { useStore } from "../lib/store";

/**
 * A narrow floating help viewer in the style of macOS Help: a topic list, one topic at a time,
 * a back button. It doesn't block the app, so you can read along while you work. Drag it by its title bar.
 */

interface Topic {
  id: string;
  title: string;
  blurb: string;
  body: ReactNode;
}

const Step = ({ n, children }: { n: number; children: ReactNode }) => (
  <li className="hp-step">
    <span className="hp-n">{n}</span>
    <div>{children}</div>
  </li>
);

const TOPICS: Topic[] = [
  {
    id: "handoff",
    title: "Grade with other people",
    blurb: "Split the remaining work with one or more graders using hand-off packs.",
    body: (
      <>
        <p className="hp-lede">
          You keep the session. Each other grader gets a <b>pack</b> file with their share of the remaining images, grades
          it in their own copy of the app, and sends back a <b>results</b> file that you merge in.
        </p>
        <div className="hp-flow">
          <span>You</span>
          <i>.msgpack<br />⟶</i>
          <span>Grader</span>
          <i>.msgresult<br />⟶</i>
          <span>You</span>
        </div>
        <p className="muted">No server or account. Send the files however you like: email, Drive, a USB stick.</p>

        <h4>Split the work</h4>
        <ol className="hp-steps">
          <Step n={1}>
            Click <b>Hand off</b> in the top bar.
          </Step>
          <Step n={2}>
            Click <b>Add grader</b> once for each person helping, and type their names.
          </Step>
          <Step n={3}>
            Each card is one image (a question on one slide) with its number of ungraded pins.{" "}
            <b>Drag a card</b> to the person who should grade it, or click it to choose.
          </Step>
          <Step n={4}>
            Or let the app do it: <b>Split evenly</b> shares the pins between everyone including you;{" "}
            <b>Give all away</b> shares them only between the other graders.
          </Step>
          <Step n={5}>
            Click <b>Create packs</b> and send each person their file.
          </Step>
        </ol>
        <p className="hp-note">
          An image always goes to one person, so every answer to it is marked the same way.
        </p>

        <h4>While work is out</h4>
        <p>
          Handed-off pins are locked in your session: they're drawn faint, the image list shows <code>→ name</code>, and a
          banner shows how many are out. Keep grading everything else. You can hand off more at any time; a pack only
          ever holds work that isn't already out.
        </p>

        <h4>For the other grader</h4>
        <ol className="hp-steps">
          <Step n={1}>
            On the start screen, click <b>Got work from another grader?</b> and choose the pack.
          </Step>
          <Step n={2}>Choose your slides folder (your own copy of the course slides).</Step>
          <Step n={3}>Choose where to save your work. It auto-saves and can be resumed like any session.</Step>
          <Step n={4}>
            Grade as usual. When you're done, click <b>Send results</b> and send the file back.
          </Step>
        </ol>
        <p className="hp-note">
          You don't need the exam file or the submissions folder; everything else is inside the pack.
        </p>

        <h4>Merge results</h4>
        <p>
          In <b>Hand off</b>, click <b>Import results</b> and choose the file. The grades merge in as one step you can undo
          with <kbd>⌘Z</kbd>. If you graded any of those pins yourself in the meantime, <b>your grade is kept</b>.
        </p>

        <h4>Take work back</h4>
        <p>
          Click <b>Recall</b> next to a pack to unlock its pins right away. Results that arrive later can still be
          imported; only pins you haven't graded are merged.
        </p>

        <h4>Privacy</h4>
        <p>
          Packs and results contain student answers and pins (not slide images). Share them the way you would any other
          grading material.
        </p>
      </>
    ),
  },
];

/** Topic list or one topic. Used by the Help window and the in-page fallback. */
function HelpBody({ topicId, onTopic }: { topicId: string; onTopic: (id: string) => void }) {
  const topic = TOPICS.find((t) => t.id === topicId);
  return topic ? (
    <article className="hp-article">
      <h3>{topic.title}</h3>
      {topic.body}
    </article>
  ) : (
    <ul className="hp-topics">
      {TOPICS.map((t) => (
        <li key={t.id}>
          <button onClick={() => onTopic(t.id)}>
            <b>{t.title}</b>
            <span className="muted small">{t.blurb}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
const titleOf = (id: string) => TOPICS.find((t) => t.id === id)?.title ?? "All topics";

/** The separate Help window (index.html?window=help&topic=…), opened by the open_help command. */
export function HelpWindow() {
  const [topicId, setTopicId] = useState(() => new URLSearchParams(location.search).get("topic") ?? "");
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bodyRef.current?.scrollTo(0, 0);
  }, [topicId]);
  return (
    <div className="help-window">
      <div className="hp-bar">
        <button className="hp-ic" disabled={!topicId} onClick={() => setTopicId("")} title="All topics" aria-label="Back">
          ‹
        </button>
        <span className="hp-title">{titleOf(topicId)}</span>
        <span />
      </div>
      <div className="hp-body" ref={bodyRef}>
        <HelpBody topicId={topicId} onTopic={setTopicId} />
      </div>
    </div>
  );
}

/** Fallback when there's no native window (UI tests in a browser): a floating panel inside the page. */
export function HelpPanel() {
  const topicId = useStore((s) => s.help);
  const set = useStore((s) => s.set);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

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
  useEffect(() => {
    bodyRef.current?.scrollTo(0, 0);
  }, [topicId]);

  if (topicId === null) return null;

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button")) return;
    const r = e.currentTarget.parentElement!.getBoundingClientRect();
    drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    setPos({
      x: Math.max(8, Math.min(window.innerWidth - 120, e.clientX - drag.current.dx)),
      y: Math.max(8, Math.min(window.innerHeight - 60, e.clientY - drag.current.dy)),
    });
  };

  return (
    <aside className="help-panel" style={pos ? { left: pos.x, top: pos.y, right: "auto" } : undefined} role="dialog" aria-label="Help">
      <div className="hp-bar" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={() => (drag.current = null)}>
        <button className="hp-ic" disabled={!topicId} onClick={() => set({ help: "" })} title="All topics" aria-label="Back">
          ‹
        </button>
        <span className="hp-title">{titleOf(topicId)}</span>
        <button className="hp-ic" onClick={() => set({ help: null })} title="Close (Esc)" aria-label="Close help">
          ×
        </button>
      </div>
      <div className="hp-body" ref={bodyRef}>
        <HelpBody topicId={topicId} onTopic={(id) => set({ help: id })} />
      </div>
    </aside>
  );
}
