import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { Question, Session, SlideRef } from "../lib/types";
import { emptyGrades } from "../lib/types";
import { loadExam } from "../lib/exam";
import { scanSlides, scanSubmissions, startBlockers, type ScanProblem } from "../lib/loader";
import { ScanProblemsDialog, ScanProblemsRow, type Resolve } from "./ScanProblemsDialog";
import { basename, dirname, joinPath, listFiles, pathExists, readText, withExt, writeText } from "../lib/backend";
import { forgetRecent, recentSessions, rememberRecent, useStore, type Recent } from "../lib/store";
import { guestSession, parsePack } from "../lib/handoff";
import { buildTasks, parseTaskId } from "../lib/grading";
import { ExamEditor } from "./ExamEditor";
import { applyPlan, emptyKey, parseKeyFile, planKey, type AnswerKey, type KeyMark } from "../lib/answerKey";
import { readingRules, useSettings } from "../lib/settings";

async function openSessionFile(path: string): Promise<Session> {
  try {
    return JSON.parse(await readText(path)) as Session;
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

/** window resizes from the start-up screens, applied strictly in order */
let resizeQueue: Promise<void> = Promise.resolve();

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
    let alive = true;
    const fit = () => {
      // a card that is being unmounted measures 0 × 0: never size the window from that
      if (!alive || !el.isConnected || el.offsetWidth < 100) return;
      // the card fills the window: only the traffic-light strip is added on top
      const W = Math.max(360, Math.ceil(el.offsetWidth));
      const H = Math.max(200, Math.min(Math.round(screen.availHeight * 0.9), Math.ceil(el.offsetHeight) + 28));
      const key = `${W}x${H}`;
      if (key === last) return;
      last = key;
      // resizes run one after another, and a screen that has gone away skips its pending one
      resizeQueue = resizeQueue
        .then(async () => {
          if (!alive) return;
          await w.setMinSize(new LogicalSize(320, 200));
          await w.setSize(new LogicalSize(W, H));
          await w.center();
        })
        .catch(() => {});
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => {
      alive = false;
      ro.disconnect();
    };
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

  /** second grader: open a pack, point it at your slides folder, pick where to keep your work */
  const openPack = async () => {
    setErr(null);
    const p = await open({ filters: [{ name: "Hand-off pack", extensions: ["msgpack"] }] });
    if (typeof p !== "string") return;
    try {
      const pack = parsePack(await readText(p));
      const d = await open({ directory: true, title: `Choose your slides folder for “${pack.session.name}”` });
      if (typeof d !== "string") return;
      const slides = await scanSlides(d);
      const needed = new Set(pack.taskIds.map((t) => parseTaskId(t).slide).filter(Boolean));
      const missing = pack.session.slides.filter((x) => (needed.size ? needed.has(x.id) : true) && !slides.some((r) => r.id === x.id));
      if (missing.length) {
        setErr(`That folder is missing ${missing.map((m) => m.file).join(", ")}. Choose the folder that has the course slides.`);
        return;
      }
      const target = await save({
        defaultPath: p.replace(/\.msgpack$/i, "") + ".msgrade",
        filters: [{ name: "Grading session", extensions: ["msgrade"] }],
      });
      if (!target) return;
      const path = withExt(target, "msgrade");
      const s = guestSession(pack, slides, path, d);
      await writeText(path, JSON.stringify(s), true);
      rememberRecent(path, s.name);
      load(s);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    }
  };

  if (mode === "new") return <NewSession onCancel={() => setMode("home")} />;

  return (
    <div className="startup" data-tauri-drag-region>
      <div className="startup-card" ref={fitRef} data-help="getting-started/the-start-screen">
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
        <p className="muted small">
          Progress auto-saves after every change. After a crash, reopen the session from this list.{" "}
          <button className="text-link" onClick={openPack} title="Open a hand-off pack (.msgpack)">
            Got work from another grader?
          </button>
        </p>
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
  /** the question editor, and questions whose answer to mark when grading starts */
  const [editing, setEditing] = useState(false);
  const [markAfter, setMarkAfter] = useState<Set<number>>(new Set());
  const [sessionPath, setSessionPath] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** step 5 (optional): an answer key imported from a file, and/or start by marking one */
  const [keyFile, setKeyFile] = useState<{ path: string; marks: KeyMark[]; mode: AnswerKey["mode"]; skipped: number } | null>(null);
  const [markFirst, setMarkFirst] = useState(false);

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
    if (p) setSessionPath(withExt(p, "msgrade"));
  };

  const included = questions.filter((q) => q.include);
  const blockers = startBlockers({ examPath, questions, subDir, slidesDir, sessionPath });
  const ready = blockers.length === 0;
  const needs = blockers.length ? `Still needed: ${blockers.join(", ")}` : "";

  // read the submissions as soon as the exam and folder are known, so problems show before Start
  const [problems, setProblems] = useState<ScanProblem[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [showProblems, setShowProblems] = useState(false);
  const [recheck, setRecheck] = useState(0);
  /** fixes and acknowledgements made in "Things to check" (kept in the session) */
  const [fileSlides, setFileSlides] = useState<Record<string, string>>({});
  const [acked, setAcked] = useState<Set<string>>(new Set());
  const examSlides = useMemo(() => [...new Set(questions.flatMap((q) => q.slides))].sort(), [questions]);
  const resolve: Resolve = {
    root: subDir,
    slides: examSlides,
    fileSlides,
    setFileSlide: (file, slide) =>
      setFileSlides((m) => {
        const n = { ...m };
        if (slide) n[file] = slide;
        else delete n[file];
        return n;
      }),
    acked,
    setAcked: (keys, on) =>
      setAcked((a) => {
        const n = new Set(a);
        for (const k of keys) (on ? n.add(k) : n.delete(k));
        return n;
      }),
  };
  // Preferences ▸ Reading submissions: how pin titles are matched to questions (kept with the session)
  const prefs = useSettings((x) => x.s);
  const rules = useMemo(() => readingRules(prefs), [prefs.readCount, prefs.titleBareNumbers, prefs.titleOtherQuestion, prefs.readLeftover, prefs.titleUnlabelled, prefs.readMultiple]); // eslint-disable-line react-hooks/exhaustive-deps
  const scanKey =
    subDir && included.length ? JSON.stringify([subDir, questions.map((q) => [q.num, q.slides, q.include]), fileSlides, recheck, rules]) : "";
  useEffect(() => {
    if (!scanKey) {
      setProblems(null);
      return;
    }
    let alive = true;
    setChecking(true);
    const t = window.setTimeout(async () => {
      try {
        const r = await scanSubmissions(subDir, questions, undefined, fileSlides, rules);
        if (alive) setProblems(r.problems);
      } catch {
        // Start reads the folder again and reports the error
      }
      if (alive) setChecking(false);
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
      setChecking(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanKey]);

  const pickKey = async () => {
    const f = await open({ filters: [{ name: "Answer key", extensions: ["msgkey"] }] });
    if (typeof f !== "string") return;
    try {
      const r = parseKeyFile(await readText(f, 20_000_000), { questions });
      setKeyFile({ path: f, marks: r.marks, mode: r.file.mode === "suggest" ? "suggest" : "grade", skipped: r.skipped });
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    }
  };

  const start = async () => {
    setErr(null);
    setBusy("Reading student annotations…");
    try {
      const scan = await scanSubmissions(subDir, questions, undefined, fileSlides, rules);
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
        ...(keyFile ? { key: { ...emptyKey(), mode: keyFile.mode, marks: keyFile.marks } } : {}),
        ...(Object.keys(fileSlides).length ? { fileSlides } : {}),
        readingRules: rules,
        ...(acked.size ? { scanAck: [...acked] } : {}),
      };
      // an imported key grades the matching pins straight away (nothing else is graded yet)
      if (session.key && session.key.mode === "grade") session.grades = applyPlan(session, planKey(session, session.key, 1));
      load(session);
      if (markFirst || markAfter.size) {
        // start on the first question whose answer is to be marked
        const first = [...markAfter].sort((a, b) => a - b)[0];
        const i = first ? buildTasks(session.questions, new Set(session.slides.map((r) => r.id))).findIndex((t) => t.q === first) : -1;
        if (i > 0) useStore.getState().setTask(i);
        useStore.getState().set({ keyMode: true });
      }
      await useStore.getState().saveNow();
      if (scan.warnings.length) console.warn(scan.warnings);
    } catch (e) {
      setErr(String(e));
    }
    setBusy(null);
  };

  return (
    <div className="startup" data-tauri-drag-region>
      <div className="startup-card wide" ref={fitRef} data-help="getting-started/create-a-session">
        <h1>New grading session</h1>

        <div className="step">
          <div className="step-n">1</div>
          <div className="step-body">
            <div className="step-head">
              <b>Exam questions</b>
              <span className="step-btns">
                {(examPath || questions.length > 0) && (
                  <button onClick={() => setEditing(true)} title="Fix, add or reorder questions, pick slides, and save them as an exam file" data-help="exam-questions">
                    Edit questions…
                  </button>
                )}
                <button onClick={pickExam}>{examPath ? "Change…" : "Choose exam PDF / JSON…"}</button>
              </span>
            </div>
            {examPath && <div className="muted small">{examPath}</div>}
            {!examPath && !questions.length && (
              <div className="muted small">
                No exam file?{" "}
                <button className="text-link" onClick={() => setEditing(true)} data-help="exam-questions">
                  Set up the questions by hand
                </button>
              </div>
            )}
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
            {checking && <div className="muted small">Checking the files…</div>}
            {!checking && problems && (
              <ScanProblemsRow problems={problems} acked={acked} fixed={Object.keys(fileSlides).length} onReview={() => setShowProblems(true)} />
            )}
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

        <div className="step" data-help="answer-key/in-a-new-session">
          <div className="step-n">5</div>
          <div className="step-body">
            <div className="step-head">
              <b>
                Answer key <span className="muted">(optional)</span>
              </b>
              <button onClick={pickKey} disabled={!questions.length} title={questions.length ? "Load a key saved from another session (.msgkey)" : "Choose the exam first"}>
                {keyFile ? "Change…" : "Import key…"}
              </button>
            </div>
            {keyFile ? (
              <div className="muted small">
                {keyFile.path} · {keyFile.marks.length} area{keyFile.marks.length === 1 ? "" : "s"}
                {keyFile.skipped ? ` (${keyFile.skipped} for questions or slides not in this exam skipped)` : ""} · pins in them are{" "}
                {keyFile.mode === "grade" ? "graded as soon as grading starts" : "suggested while you grade"}
              </div>
            ) : (
              <div className="muted small">Mark where the answers are and matching pins are graded for you, now and as late work comes in.</div>
            )}
            <label className="check key-first">
              <input type="checkbox" checked={markFirst} onChange={(e) => setMarkFirst(e.target.checked)} />
              {keyFile ? "Review the key before grading" : "Start by marking the answer key"}
            </label>
          </div>
        </div>

        {err && <p className="warn">{err}</p>}
        <div className="modal-actions">
          <button onClick={onCancel}>Cancel</button>
          <div className="grow" />
          {busy ? (
            <span className="muted">{busy}</span>
          ) : (
            needs && <span className="muted small start-needs" data-help="getting-started/create-a-session">{needs}</span>
          )}
          <span title={busy ? undefined : needs || undefined}>
            <button className="primary big" disabled={!ready || !!busy} onClick={start}>
              Start grading →
            </button>
          </span>
        </div>
      </div>
      {editing && (
        <ExamEditor
          questions={questions}
          slides={slides}
          examName={name || "Exam"}
          markAfter={markAfter}
          onMarkAfter={setMarkAfter}
          onDone={(qs) => {
            setQuestions(qs);
            if (!name) setName("Exam");
          }}
          onClose={() => setEditing(false)}
        />
      )}
      {showProblems && problems && (
        <ScanProblemsDialog problems={problems} onClose={() => setShowProblems(false)} onRecheck={() => setRecheck((n) => n + 1)} resolve={resolve} />
      )}
    </div>
  );
}
