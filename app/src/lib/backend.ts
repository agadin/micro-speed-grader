import { invoke } from "@tauri-apps/api/core";
import type { SlideInfo } from "./types";

export const openSlide = (path: string) => invoke<SlideInfo>("open_slide", { path });
export const listFiles = (dir: string, suffixes: string[] = []) =>
  invoke<string[]>("list_files", { dir, suffixes });
/** maxBytes: reject files larger than this (used for untrusted student files) */
export const readText = (path: string, maxBytes?: number) => invoke<string>("read_text", { path, maxBytes });
export const readBytes = async (path: string) =>
  new Uint8Array(await invoke<ArrayBuffer>("read_bytes", { path }));
export const writeText = (path: string, contents: string, keepBackup = false) =>
  invoke<void>("write_text", { path, contents, keepBackup });
export const pathExists = (path: string) => invoke<boolean>("path_exists", { path });
/** opens/focuses the separate Preferences window; rejects outside Tauri */
export const openPreferencesWindow = () => invoke<void>("open_preferences");
export const openHelpWindow = (topic: string) => invoke<void>("open_help", { topic });
/** Open a help article ("article" or "article/section") in the Help window; in a plain browser, the in-page panel. */
export const showHelp = async (ref: string) => {
  try {
    await openHelpWindow(ref);
  } catch {
    const { useStore } = await import("./store");
    useStore.getState().set({ help: ref });
  }
};

const isWindows = navigator.userAgent.includes("Windows");
/** Base URL of the custom `slide://` tile protocol (differs on Windows/WebView2). */
export const tileBase: string =
  (window as unknown as { __MSG_TILE_BASE__?: string }).__MSG_TILE_BASE__ ?? // headless UI tests (tests/ui)
  (isWindows ? "http://slide.localhost" : "slide://localhost");

export const sep = isWindows ? "\\" : "/";
export const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;
export const dirname = (p: string) => {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i <= 0 ? p : p.slice(0, i);
};
export const joinPath = (...parts: string[]) =>
  parts.map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, "") : p.replace(/^[\\/]+|[\\/]+$/g, ""))).join(sep);

