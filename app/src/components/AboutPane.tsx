import { useEffect, useState } from "react";
import iconUrl from "../../../docs/icon.png";
import pkg from "../../package.json";
import { emit } from "@tauri-apps/api/event";
import { openExternal, showHelp } from "../lib/backend";

const REPO = "https://github.com/agadin/micro-speed-grader";


/** Preferences ▸ About: version, help, updates, credits. */
export function AboutPane() {
  const [version, setVersion] = useState<string>(pkg.version);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    import("@tauri-apps/api/app")
      .then((m) => m.getVersion())
      .then(setVersion)
      .catch(() => {});
  }, []);

  const checkUpdates = async () => {
    // the main window owns the update banner; ask it to check (the same as the menu item)
    setChecking(true);
    try {
      await emit("menu", "check_updates");
    } catch {
      /* not in the app */
    }
    setTimeout(() => setChecking(false), 1500);
  };

  return (
    <div className="about">
      <div className="about-id">
        <img src={iconUrl} alt="" width={72} height={72} />
        <div>
          <div className="about-name">Micro Speed Grader</div>
          <div className="about-ver">Version {version}</div>
          <div className="muted small">Grade histology practicals one question at a time.</div>
        </div>
      </div>

      <div className="group about-actions">
        <button className="btn" onClick={() => void showHelp("index")}>
          Help
        </button>
        <button className="btn" onClick={() => void showHelp("shortcuts")}>
          Keyboard shortcuts
        </button>
        <button className="btn" onClick={checkUpdates} disabled={checking} title="The result shows in the main window">
          {checking ? "Checking…" : "Check for Updates…"}
        </button>
        <button className="btn" onClick={() => void openExternal(REPO)}>
          Project page ↗
        </button>
      </div>

      <div className="about-credits muted small">
        <p>
          Released under the MIT License. Slide images are read with OpenSlide (LGPL 2.1) and shown with OpenSeadragon
          (BSD 3-Clause). Built with Tauri and React.
        </p>
        <p>Grading data stays on this computer: the app sends nothing anywhere except its update check to GitHub.</p>
      </div>
    </div>
  );
}
