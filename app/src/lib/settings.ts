import { create } from "zustand";
import { COLUMN_INFO, EXPORT_PRESETS, type ExportColumn } from "./exportCsv";
import type { ReadingRules } from "./types";

/** flag / pushpin mirror NDP.view's annotation icons */
export type PinStyle = "flag" | "pushpin" | "dot" | "cross";
export type LabelMode = "none" | "title" | "student";
export type SelectTool = "lasso" | "brush" | "polygon";
export const SELECT_TOOLS: SelectTool[] = ["lasso", "brush", "polygon"];

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
  /** reading submissions: how pin titles are matched to questions (new sessions take these) */
  readCount: ReadingRules["count"];
  titleBareNumbers: boolean;
  titleOtherQuestion: ReadingRules["otherQuestion"];
  readLeftover: boolean;
  titleUnlabelled: ReadingRules["unlabelled"];
  readMultiple: ReadingRules["multiple"];
  wrongDefaultText: string;
  doubleMessage: string;
  noAnswerMessage: string;
  /** feedback wording; {q} {text} {note} {score} {total} {percent} are filled in */
  fbHeader: string;
  fbLine: string;
  fbCorrect: string;
  fbCorrectNote: string;
  fbWrongNote: string;
  fbUngraded: string;
  fbScore: string;
  fbScoreOn: boolean;
  /** list every question, or only the ones not answered correctly */
  fbShow: "all" | "notCorrect";
  fbAllCorrect: string;
  showOtherQuestions: boolean;
  /** draw the answer key's areas on the slide while grading */
  showKey: boolean;
  selectTool: SelectTool;
  /** which selection tools appear in the tool switcher (B cycles through them) */
  tools: Record<SelectTool, boolean>;
  /** plain click on a pin adds/removes it from the selection (⌘-click opens the grade menu) */
  clickToggle: boolean;
  /** with pins hidden, brush / lasso / polygon strokes paint an area; unhide to grade by it */
  hiddenPaint: boolean;
  /** offer the pin-by-pin mode (O): step through a cluster showing one pin at a time */
  pinByPin: boolean;
  /** hovering a pin hides every other pin */
  spotlight: boolean;
  /** draw pins as small dots once zoomed in past shrinkUmPerPx */
  shrinkPins: boolean;
  shrinkUmPerPx: number;
  /** marker used once zoomed past shrinkUmPerPx */
  shrinkStyle: PinStyle;
  /** brush radius in screen pixels */
  brushPx: number;
  /** keyboard-shortcut panel over the image expanded */
  showKeyHints: boolean;
  /** opacity of faded pins from other questions (0–1) */
  otherOpacity: number;
  /** true: left-drag selects (lasso / brush), right-drag pans */
  swapMouse: boolean;
  /** zoom factor per scroll-wheel step */
  zoomPerScroll: number;
  dblClickZoom: boolean;
  /** zoom to each cluster when it becomes current */
  autoZoomCluster: boolean;
  /** smooth zoom / pan animation */
  animate: boolean;
  /** export: CSV columns in order (header text editable, each on/off) */
  exportColumns: ExportColumn[];
  exportUid: "folder" | "blank";
  exportUngraded: "blank" | "0";
  /** export: also write feedback/<student>.txt */
  exportFeedback: boolean;
  /** background of the marker preview in Preferences (he / toluidine / ihc / reticulin) */
  previewStain: string;
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
    paint: string;
  };
}

/** the pin-title rules in Preferences, as a session stores them */
export const readingRules = (s: Settings): ReadingRules => ({
  count: s.readCount === "pins" || s.readCount === "all" ? s.readCount : "shapes",
  bareNumbers: s.titleBareNumbers !== false,
  otherQuestion: s.titleOtherQuestion === "omit" ? "omit" : "slide",
  leftover: s.readLeftover !== false,
  unlabelled: s.titleUnlabelled === "first" || s.titleUnlabelled === "omit" ? s.titleUnlabelled : "all",
  multiple: s.readMultiple === "grade" ? "grade" : "wrong",
});

/** paint brush size range, px */
export const BRUSH_MIN = 6;
export const BRUSH_MAX = 200;

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
  readCount: "shapes",
  titleBareNumbers: true,
  titleOtherQuestion: "slide",
  readLeftover: true,
  titleUnlabelled: "all",
  readMultiple: "wrong",
  wrongDefaultText: "Incorrect",
  doubleMessage: "Multiple pins submitted (only one allowed)",
  noAnswerMessage: "No answer",
  fbHeader: "Overall Feedback",
  fbLine: "Q{q}: {text}",
  fbCorrect: "Correct",
  fbCorrectNote: "Correct ({note})",
  fbWrongNote: "{note}",
  fbUngraded: "Ungraded",
  fbScore: "Score: {score}/{total}",
  fbScoreOn: true,
  fbShow: "all",
  fbAllCorrect: "All answers correct.",
  showOtherQuestions: false,
  showKey: true,
  selectTool: "lasso",
  tools: { lasso: true, brush: true, polygon: true },
  clickToggle: false,
  hiddenPaint: true,
  pinByPin: true,
  spotlight: false,
  shrinkPins: false,
  shrinkUmPerPx: 0.5,
  shrinkStyle: "dot",
  brushPx: 28,
  showKeyHints: false,
  otherOpacity: 0.35,
  swapMouse: false,
  zoomPerScroll: 1.2,
  dblClickZoom: true,
  autoZoomCluster: true,
  animate: true,
  previewStain: "he",
  exportColumns: EXPORT_PRESETS[0].columns,
  exportUid: "folder",
  exportUngraded: "blank",
  exportFeedback: true,
  collapsedPanels: ["reasons"],
  panelsVersion: 1,
  colors: {
    ungraded: "#e9e6e1",
    correct: "#86c46d",
    wrong: "#ee6a5c",
    double: "#4fd6c8",
    selected: "#f4c04e",
    cluster: "#f6f1e7",
    paint: "#5ec8f2",
  },
};

/** saved column list → valid: known ids only, each once, any missing ones appended (off) */
function fixColumns(cols: unknown): ExportColumn[] {
  if (!Array.isArray(cols)) return defaultSettings.exportColumns;
  const seen = new Set<string>();
  const out: ExportColumn[] = [];
  for (const c of cols as ExportColumn[])
    if (c && c.id in COLUMN_INFO && !seen.has(c.id)) {
      seen.add(c.id);
      out.push({ id: c.id, header: typeof c.header === "string" ? c.header : COLUMN_INFO[c.id].header, on: !!c.on });
    }
  for (const c of defaultSettings.exportColumns) if (!seen.has(c.id)) out.push({ ...c, on: false });
  return out;
}

/** the tool actually in use: the chosen one if enabled, else the first enabled one */
export function activeTool(s: Settings): SelectTool {
  if (s.tools[s.selectTool]) return s.selectTool;
  return SELECT_TOOLS.find((t) => s.tools[t]) ?? "lasso";
}

const KEY = "msg.settings.v2";
/** v1 stored the old colour scheme; carry everything else over, take the new default colours */
const OLD_KEY = "msg.settings.v1";

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw);
      const pinStyle = ["flag", "pushpin", "dot", "cross"].includes(s.pinStyle) ? s.pinStyle : "flag";
      const out = {
        ...defaultSettings,
        ...s,
        pinStyle,
        tools: { ...defaultSettings.tools, ...(s.tools ?? {}) },
        exportColumns: fixColumns(s.exportColumns),
        colors: { ...defaultSettings.colors, ...(s.colors ?? {}) },
      };
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
