import { create } from "zustand";

/** flag / pushpin mirror NDP.view's annotation icons */
export type PinStyle = "flag" | "pushpin" | "dot" | "cross";
export type LabelMode = "none" | "title" | "student";
export type SelectTool = "lasso" | "brush";

export interface Settings {
  pinStyle: PinStyle;
  pinSize: number;
  labelMode: LabelMode;
  toggleFlagsKey: string;
  minimapKey: string;
  clusterRadiusUm: number;
  minClusterSize: number;
  /** Width of the field of view when zooming to a single pin (µm). */
  singleFieldUm: number;
  clusterPaddingUm: number;
  wrongNeedsReason: boolean;
  wrongDefaultText: string;
  doubleMessage: string;
  noAnswerMessage: string;
  showOtherQuestions: boolean;
  selectTool: SelectTool;
  /** brush radius in screen pixels */
  brushPx: number;
  /** keyboard-shortcut panel over the image expanded */
  showKeyHints: boolean;
  /** opacity of faded pins from other questions (0–1) */
  otherOpacity: number;
  /** collapsed side panels (by id) */
  collapsedPanels: string[];
  /** bumped when default panel layout changes, so new defaults reach saved settings once */
  panelsVersion: number;
  colors: {
    ungraded: string;
    correct: string;
    wrong: string;
    double: string;
    selected: string;
    cluster: string;
  };
}

export const defaultSettings: Settings = {
  pinStyle: "flag",
  pinSize: 14,
  labelMode: "none",
  toggleFlagsKey: " ",
  minimapKey: "m",
  clusterRadiusUm: 25,
  minClusterSize: 2,
  singleFieldUm: 250,
  clusterPaddingUm: 40,
  wrongNeedsReason: true,
  wrongDefaultText: "Incorrect",
  doubleMessage: "Multiple pins submitted (only one allowed)",
  noAnswerMessage: "No answer",
  showOtherQuestions: false,
  selectTool: "lasso",
  brushPx: 28,
  showKeyHints: false,
  otherOpacity: 0.35,
  collapsedPanels: ["reasons"],
  panelsVersion: 1,
  colors: {
    ungraded: "#e9e6e1",
    correct: "#86c46d",
    wrong: "#ee6a5c",
    double: "#4fd6c8",
    selected: "#f4c04e",
    cluster: "#f6f1e7",
  },
};

const KEY = "msg.settings.v2";
/** v1 stored the old colour scheme; carry everything else over, take the new default colours */
const OLD_KEY = "msg.settings.v1";

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw);
      const pinStyle = ["flag", "pushpin", "dot", "cross"].includes(s.pinStyle) ? s.pinStyle : "flag";
      const out = { ...defaultSettings, ...s, pinStyle, colors: { ...defaultSettings.colors, ...(s.colors ?? {}) } };
      if ((s.panelsVersion ?? 0) < 1) {
        out.collapsedPanels = [...new Set([...(s.collapsedPanels ?? []), "reasons"])];
        out.panelsVersion = 1;
      }
      return out;
    }
    const old = localStorage.getItem(OLD_KEY);
    if (old) {
      const { colors: _c, ...rest } = JSON.parse(old);
      return { ...defaultSettings, ...rest, pinStyle: ["dot", "cross"].includes(rest.pinStyle) ? rest.pinStyle : "flag" };
    }
  } catch {
    /* ignore */
  }
  return defaultSettings;
}

interface SettingsStore {
  s: Settings;
  set: (patch: Partial<Settings>) => void;
  reset: () => void;
}

export const useSettings = create<SettingsStore>((set, get) => ({
  s: load(),
  set: (patch) => {
    const s = { ...get().s, ...patch };
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
      /* ignore */
    }
    set({ s });
  },
  reset: () => {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
    set({ s: defaultSettings });
  },
}));

// keep every window (main + Preferences) in sync: localStorage changes fire "storage" elsewhere
if (typeof window !== "undefined")
  window.addEventListener("storage", (e) => {
    if (e.key === KEY || e.key === null) useSettings.setState({ s: load() });
  });

export const keyLabel = (k: string) => (k === " " ? "Space" : k.length === 1 ? k.toUpperCase() : k);
