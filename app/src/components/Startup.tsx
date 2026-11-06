import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { Question, Session, SlideRef } from "../lib/types";
import { emptyGrades } from "../lib/types";
import { loadExam } from "../lib/exam";
import { scanSlides, scanSubmissions } from "../lib/loader";
import { basename, dirname, joinPath, listFiles, pathExists, readText } from "../lib/backend";
import { forgetRecent, recentSessions, rememberRecent, useStore, type Recent } from "../lib/store";

export async function openSessionFile(path: string): Promise<Session> {
  let raw: string;
  try {
    raw = await readText(path);
    return JSON.parse(raw) as Session;
  } catch (e) {
    // fall back to the backup written before the last save
    if (await pathExists(path + ".bak")) return JSON.parse(await readText(path + ".bak")) as Session;
    throw e;
  }
}

/** "~/…/demo/Demo exam.msgrade": home folder abbreviated, middle folders dropped when long */
function shortPath(p: string): string {
  const home = p.replace(/^\/Users\/[^/]+|^[A-Za-z]:\\Users\\[^\\]+/, "~");
  if (home.length <= 48) return home;
  const sep = home.includes("\\") && !home.includes("/") ? "\\" : "/";
  const parts = home.split(sep);
  return parts.length > 3 ? [parts[0], "…", ...parts.slice(-2)].join(sep) : home;
}

/** Size the (title-bar-less) window snugly around the start-up card. */
function useFitWindow() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let w: ReturnType<typeof getCurrentWindow>;
    try {
      w = getCurrentWindow();
    } catch {
      return; // not inside Tauri (UI tests)
    }
    let last = "";
    const fit = () => {
      // the card fills the window: only the traffic-light strip is added on top
      const W = Math.ceil(el.offsetWidth);
      const H = Math.min(Math.round(screen.availHeight * 0.9), Math.ceil(el.offsetHeight) + 28);
      const key = `${W}x${H}`;
      if (key === last) return;
      last = key;
      w.setMinSize(new LogicalSize(320, 200))
        .then(() => w.setSize(new LogicalSize(W, H)))
        .then(() => w.center())
        .catch(() => {});
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return ref;
}

export function Startup() {
  const fitRef = useFitWindow();
  const [mode, setMode] = useState<"home" | "new">("home");
  const [recent, setRecent] = useState<Recent[]>(recentSessions());
  const [err, setErr] = useState<string | null>(null);
  const load = useStore((s) => s.load);

  const resume = async (path: string) => {
    setErr(null);
    try {
      const s = await openSessionFile(path);
      s.sessionPath = path;
      rememberRecent(path, s.name);
      load(s);
    } catch (e) {
      setErr(`Could not open ${path}: ${e}`);
    }
  };

  const intent = useStore((s) => s.startupIntent);
  const setStore = useStore((s) => s.set);
  const openDialog = async () => {
    const p = await open({ filters: [{ name: "Grading session", extensions: ["msgrade"] }] });
    if (typeof p === "string") resume(p);
  };
  useEffect(() => {
    if (!intent) return;
    setStore({ startupIntent: null });
    if (intent === "new") setMode("new");
    else void openDialog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent]);

  if (mode === "new") return <NewSession onCancel={() => setMode("home")} />;

  return (
    <div className="startup" data-tauri-drag-region>
      <div className="startup-card" ref={fitRef}>
        <h1>Micro Speed Grader</h1>
        <p className="muted">Grade histology practicals one question at a time.</p>
        <div className="startup-actions">
          <button className="primary big" onClick={() => setMode("new")}>
            New grading session…
          </button>
          <button
            className="big"
            onClick={openDialog}
          >
            Open session…
          </button>
        </div>
        {err && <p className="warn">{err}</p>}
        {recent.length > 0 && (
          <>
            <h3>Resume</h3>
            <ul className="recent">
              {recent.map((r) => (
                <li key={r.path}>
                  <button className="link" onClick={() => resume(r.path)}>
                    <b>{r.name}</b>
                    <span className="muted small path" title={r.path}>
                      {shortPath(r.path)}
                    </span>
                    <span className="muted small">last saved {new Date(r.at).toLocaleString()}</span>
                  </button>
                  <button
                    className="icon"
                    title="Remove from list"
                    onClick={() => {
                      forgetRecent(r.path);
                      setRecent(recentSessions());
                    }}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="muted small">Progress auto-saves after every change. After a crash, reopen the session from this list.</p>
      </div>
    </div>
  );
}

function NewSession({ onCancel }: { onCancel: () => void }) {
  const fitRef = useFitWindow();
  const load = useStore((s) => s.load);
  const [examPath, setExamPath] = useState("");
  const [name, setName] = useState("");
  const [questions, setQuestions] = useState<Question[]>([]);
  const [subDir, setSubDir] = useState("");
  const [subInfo, setSubInfo] = useState<{ files: number; folders: number } | null>(null);
  const [slidesDir, setSlidesDir] = useState("");
  const [slides, setSlides] = useState<SlideRef[]>([]);
  const [sessionPath, setSessionPath] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const slideSet = useMemo(() => new Set(slides.map((s) => s.id)), [slides]);

  const pickExam = async () => {
    const p = await open({ filters: [{ name: "Exam (PDF or JSON)", extensions: ["pdf", "json"] }] });
    if (typeof p !== "string") return;
    setErr(null);
    setBusy("Reading exam…");
    try {
      const ex = await loadExam(p);
      setExamPath(p);
      setName(ex.name);
      setQuestions(ex.questions);
      if (!ex.questions.length) setErr("No questions like “Q1. Using VMS123, …” were found in that file.");
    } catch (e) {
      setErr(String(e));
    }
    setBusy(null);
  };

  const pickSubs = async () => {
    const d = await open({ directory: true });
    if (typeof d !== "string") return;
    setSubDir(d);
    const files = await listFiles(d, [".ndpa"]);
    const folders = new Set(files.map((f) => f.slice(d.length).replace(/^[\\/]+/, "").split(/[\\/]/)[0]));
    setSubInfo({ files: files.length, folders: folders.size });
    if (!sessionPath) setSessionPath(joinPath(dirname(d), `${name || "grading"}.msgrade`));
  };

  const pickSlides = async () => {
    const d = await open({ directory: true });
    if (typeof d !== "string") return;
    setSlidesDir(d);
    setSlides(await scanSlides(d));
  };

  // default: include questions whose slides we actually have
  useEffect(() => {
    if (!slides.length) return;
    setQuestions((qs) => qs.map((q) => ({ ...q, include: q.slides.some((s) => slideSet.has(s)) })));
  }, [slides, slideSet]);

  const pickSave = async () => {
    const p = await save({
      defaultPath: sessionPath || `${name || "grading"}.msgrade`,
      filters: [{ name: "Grading session", extensions: ["msgrade"] }],
    });
    if (p) setSessionPath(p.endsWith(".msgrade") ? p : p + ".msgrade");
  };

  const included = questions.filter((q) => q.include);
  const ready = included.length > 0 && subDir && slidesDir && sessionPath;

  const start = async () => {
    setErr(null);
    setBusy("Reading student annotations…");
    try {
      const scan = await scanSubmissions(subDir, questions);
      const now = Date.now();
      const session: Session = {
        version: 1,
        name: name || basename(examPath) || "Grading session",
        createdAt: now,
        savedAt: now,
        sessionPath,
        submissionsDir: subDir,
        slidesDir,
        questions,
        students: scan.students,
        pins: scan.pins,
        slides,
        grades: emptyGrades(),
        taskIndex: 0,
      };
      load(session);
      await useStore.getState().saveNow();
      if (scan.warnings.length) console.warn(scan.warnings);
    } catch (e) {
      setErr(String(e));
    }
    setBusy(null);
  };

  return (
    <div className="startup" data-tauri-drag-region>
      <div className="startup-card wide" ref={fitRef}>
        <h1>New grading session</h1>

        <div className="step">
          <div className="step-n">1</div>
          <div className="step-body">
            <div className="step-head">
              <b>Exam questions</b>
              <button onClick={pickExam}>{examPath ? "Change…" : "Choose exam PDF / JSON…"}</button>
            </div>
            {examPath && <div className="muted small">{examPath}</div>}
            {questions.length > 0 && (
              <>
                <label className="field wide">
                  <span>Session name</span>
                  <input value={name} onChange={(e) => setName(e.target.value)} />
                </label>
                <table className="qtable">
                  <thead>
                    <tr>
                      <th />
                      <th>Q</th>
                      <th>Slides</th>
                      <th>Prompt</th>
                    </tr>
                  </thead>
                  <tbody>
                    {questions.map((q, i) => (
                      <tr key={q.num} className={q.include ? "" : "off"}>
                        <td>
                          <input
                            type="checkbox"
                            checked={q.include}
                            onChange={(e) =>
                              setQuestions((qs) => qs.map((x, j) => (j === i ? { ...x, include: e.target.checked } : x)))
                            }
                          />
                        </td>
                        <td>Q{q.num}</td>
                        <td>
                          <input
                            className="slides-input"
                            value={q.slides.join(", ")}
                            onChange={(e) =>
                              setQuestions((qs) =>
                                qs.map((x, j) =>
                                  j === i
                                    ? { ...x, slides: e.target.value.split(/[ ,]+/).filter(Boolean).map((s) => s.toUpperCase()) }
                                    : x,
                                ),
                              )
                            }
                          />
                          {slides.length > 0 &&
                            q.slides.map((s) => (
                              <span key={s} className={`chip ${slideSet.has(s) ? "ok" : "missing"}`}>
                                {slideSet.has(s) ? "✓" : "missing"} {s}
                              </span>
                            ))}
                        </td>
                        <td className="prompt-cell">{q.prompt}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="muted small">
                  {included.length} of {questions.length} questions included. The score is out of {included.length}.
                </div>
              </>
            )}
          </div>
        </div>

        <div className="step">
          <div className="step-n">2</div>
          <div className="step-body">
            <div className="step-head">
              <b>Student submissions folder</b>
              <button onClick={pickSubs}>{subDir ? "Change…" : "Choose folder…"}</button>
            </div>
            {subDir && (
              <div className="muted small">
                {subDir}
                {subInfo && ` · ${subInfo.folders} student folders · ${subInfo.files} annotation files`}
              </div>
            )}
            <div className="muted small">Expected: one folder per student containing their .ndpa files.</div>
          </div>
        </div>

        <div className="step">
          <div className="step-n">3</div>
          <div className="step-body">
            <div className="step-head">
              <b>Slide images folder</b>
              <button onClick={pickSlides}>{slidesDir ? "Change…" : "Choose folder…"}</button>
            </div>
            {slidesDir && (
              <div className="muted small">
                {slidesDir} · found {slides.map((s) => s.id).join(", ") || "no slides"}
              </div>
            )}
          </div>
        </div>

        <div className="step">
          <div className="step-n">4</div>
          <div className="step-body">
            <div className="step-head">
              <b>Save session as</b>
              <button onClick={pickSave}>Choose…</button>
            </div>
            {sessionPath && <div className="muted small">{sessionPath}</div>}
            <div className="muted small">Grading auto-saves to this file as you work.</div>
          </div>
        </div>

        {err && <p className="warn">{err}</p>}
        <div className="modal-actions">
          <button onClick={onCancel}>Cancel</button>
          <div className="grow" />
          {busy && <span className="muted">{busy}</span>}
          <button className="primary big" disabled={!ready || !!busy} onClick={start}>
            Start grading →
          </button>
        </div>
      </div>
    </div>
  );
}
