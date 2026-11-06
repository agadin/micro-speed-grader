import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./App.css";
import { PreferencesWindow } from "./components/SettingsDialog";

const isPrefs = new URLSearchParams(location.search).get("window") === "preferences";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isPrefs ? <PreferencesWindow /> : <App />}
  </React.StrictMode>,
);
