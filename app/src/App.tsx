import { useEffect, useState } from "react";
import { UpdateBanner } from "./components/UpdateBanner";
import { openPreferencesWindow } from "./lib/backend";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { useStore } from "./lib/store";
import { Startup } from "./components/Startup";
import { Grader } from "./components/Grader";
import { SettingsDialog } from "./components/SettingsDialog";


export default function App() {
  const session = useStore((s) => s.session);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const set = useStore((s) => s.set);
  // Small window for the start screen; grow to (most of) the screen for grading.
  const hasSession = !!session;
  useEffect(() => {
    let w;
    try {
      w = getCurrentWindow();
    } catch {
      return; // not running inside Tauri (UI tests)
    }
    const grow = async () => {
      const W = Math.round(Math.min(1680, screen.availWidth * 0.94));
      const H = Math.round(Math.min(1050, screen.availHeight * 0.94));
      await w.setMinSize(new LogicalSize(1100, 700));
      await w.setSize(new LogicalSize(Math.max(1100, W), Math.max(700, H)));
      await w.center();
    };
    // the start-up screens size the window to their card themselves (Startup.tsx)
    if (hasSession) grow().catch(() => {});
  }, [hasSession]);

  // Preferences open in their own window; outside Tauri (UI tests) fall back to a modal
  const [prefsFallback, setPrefsFallback] = useState(false);
  useEffect(() => {
    if (!settingsOpen) return;
    openPreferencesWindow()
      .then(() => set({ settingsOpen: false }))
      .catch(() => setPrefsFallback(true));
  }, [settingsOpen, set]);

  // native menu bar (Micro Speed Grader ▸ Preferences…, File ▸ …)
  useEffect(() => {
    const un = listen<string>("menu", async ({ payload }) => {
      const st = useStore.getState();
      const leave = async () => {
        if (st.session) {
          await st.saveNow();
          st.close();
        }
      };
      if (payload === "preferences") st.set({ settingsOpen: true, menu: null });
      else if (payload === "export" && st.session) st.set({ exportOpen: true, menu: null });
      else if (payload === "close_session") await leave();
      else if (payload === "new_session") {
        await leave();
        useStore.getState().set({ startupIntent: "new" });
      } else if (payload === "open_session") {
        await leave();
        useStore.getState().set({ startupIntent: "open" });
      }
    });
    return () => void un.then((f) => f());
  }, []);

  return (
    <>
      {session ? <Grader session={session} /> : <Startup />}
      <UpdateBanner />
      {settingsOpen && prefsFallback && <SettingsDialog onClose={() => set({ settingsOpen: false })} />}
    </>
  );
}
