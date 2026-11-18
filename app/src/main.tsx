import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./App.css";
import { PreferencesWindow } from "./components/SettingsDialog";
import { HelpWindow } from "./components/HelpPanel";
import { HelpTips } from "./components/HelpTips";

const which = new URLSearchParams(location.search).get("window");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {which === "preferences" ? (
      <>
        <PreferencesWindow />
        <HelpTips />
      </>
    ) : which === "help" ? <HelpWindow /> : <App />}
  </React.StrictMode>,
);
