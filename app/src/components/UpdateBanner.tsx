import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { useStore } from "../lib/store";

type State =
  | { kind: "idle" }
  | { kind: "available"; update: Update }
  | { kind: "downloading"; update: Update; pct: number | null }
  | { kind: "uptodate" }
  | { kind: "error"; msg: string };

const inTauri = () => "__TAURI_INTERNALS__" in window && !(window as { __MSG_TEST__?: boolean }).__MSG_TEST__;

/**
 * Checks GitHub Releases for a newer version once at launch (quietly) and from
 * Micro Speed Grader ▸ Check for Updates… (reports "up to date" too).
 */
export function UpdateBanner() {
  const [st, setSt] = useState<State>({ kind: "idle" });

  const run = async (manual: boolean) => {
    try {
      const update = await check();
      if (update) setSt({ kind: "available", update });
      else if (manual) setSt({ kind: "uptodate" });
    } catch (e) {
      if (manual) setSt({ kind: "error", msg: String(e) });
    }
  };

  useEffect(() => {
    if (!inTauri() || import.meta.env.DEV) return;
    void run(false);
  }, []);
  useEffect(() => {
    if (!inTauri()) return;
    const un = listen<string>("menu", ({ payload }) => payload === "check_updates" && void run(true));
    return () => void un.then((f) => f());
  }, []);

  const install = async (update: Update) => {
    let total = 0, got = 0;
    setSt({ kind: "downloading", update, pct: null });
    try {
      await update.downloadAndInstall((ev) => {
        if (ev.event === "Started") total = ev.data.contentLength ?? 0;
        else if (ev.event === "Progress") {
          got += ev.data.chunkLength;
          setSt({ kind: "downloading", update, pct: total ? Math.round((got / total) * 100) : null });
        }
      });
      await useStore.getState().saveNow?.();
      await relaunch();
    } catch (e) {
      setSt({ kind: "error", msg: String(e) });
    }
  };

  if (st.kind === "idle") return null;
  const close = () => setSt({ kind: "idle" });
  return (
    <div className="update-toast" role="status">
      {st.kind === "available" && (
        <>
          <span>
            <b>Version {st.update.version}</b> is available.
          </span>
          <button className="btn light" onClick={() => install(st.update)}>
            Install &amp; restart
          </button>
          <button className="btn ghost" onClick={close}>
            Later
          </button>
        </>
      )}
      {st.kind === "downloading" && <span>Downloading {st.update.version}… {st.pct != null ? `${st.pct}%` : ""}</span>}
      {st.kind === "uptodate" && (
        <>
          <span>You have the latest version.</span>
          <button className="btn ghost" onClick={close}>
            OK
          </button>
        </>
      )}
      {st.kind === "error" && (
        <>
          <span>Could not check for updates: {st.msg}</span>
          <button className="btn ghost" onClick={close}>
            OK
          </button>
        </>
      )}
    </div>
  );
}
