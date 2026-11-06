// Headless UI harness: runs the real front end (vite dev server) in Playwright WebKit
// with a stand-in for Tauri. File commands are served from Node; slides come from the
// Rust tile server (src-tauri/examples/tileserver.rs), so tiles are the app's real ones.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { webkit, chromium } from "playwright";

export const APP = path.resolve(import.meta.dirname, "../..");
export const ROOT = path.resolve(APP, "..");
const TILE_PORT = 8787;
const TILE = `http://127.0.0.1:${TILE_PORT}`;

async function waitFor(url, ms = 120000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {}
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

export async function startTileServer() {
  try {
    await fetch(`${TILE}/`);
    return { stop() {} }; // already running
  } catch {}
  const p = spawn("cargo", ["run", "--release", "--example", "tileserver", "--", String(TILE_PORT)], {
    cwd: path.join(APP, "src-tauri"),
    stdio: ["ignore", "inherit", "inherit"],
  });
  await waitFor(`${TILE}/`, 600000);
  return { stop: () => p.kill() };
}

// ---- command implementations (mirror src-tauri/src/lib.rs) ----
function listFiles(dir, suffixes) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "__MACOSX") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (!suffixes.length || suffixes.some((s) => e.name.toLowerCase().endsWith(s.toLowerCase()))) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

async function command(cmd, a) {
  switch (cmd) {
    case "open_slide": {
      const r = await fetch(`${TILE}/open?path=${encodeURIComponent(a.path)}`);
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    }
    case "list_files":
      return listFiles(a.dir, a.suffixes ?? []);
    case "read_text":
      return fs.readFileSync(a.path, "utf8").replace(/^﻿/, "");
    case "read_bytes":
      return { __bytes: fs.readFileSync(a.path).toString("base64") };
    case "write_text": {
      fs.mkdirSync(path.dirname(a.path), { recursive: true });
      if (a.keepBackup && fs.existsSync(a.path)) fs.copyFileSync(a.path, a.path + ".bak");
      fs.writeFileSync(a.path + ".tmp-write", a.contents);
      fs.renameSync(a.path + ".tmp-write", a.path);
      return null;
    }
    case "path_exists":
      return fs.existsSync(a.path);
    default:
      throw new Error(`unknown command ${cmd}`);
  }
}

// ---- in-page Tauri stand-in ----
const SHIM = (tile) => {
  window.__MSG_TILE_BASE__ = tile;
  window.__dialogQueue = [];
  window.__dialogLog = [];
  const callbacks = new Map();
  const listeners = new Map(); // event -> [callback id]
  let next = 1;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback(cb, once) {
      const id = next++;
      callbacks.set(id, (x) => {
        if (once) callbacks.delete(id);
        return cb(x);
      });
      return id;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
    convertFileSrc: (p) => p,
    async invoke(cmd, args = {}) {
      if (cmd === "plugin:event|listen") {
        listeners.set(args.event, [...(listeners.get(args.event) ?? []), args.handler]);
        return args.handler;
      }
      if (cmd.startsWith("plugin:event|")) return null;
      if (cmd.startsWith("plugin:window|")) return null; // no native window in the test browser
      if (cmd === "plugin:dialog|open" || cmd === "plugin:dialog|save") {
        window.__dialogLog.push({ cmd, options: args.options });
        if (!window.__dialogQueue.length) throw new Error(`unexpected dialog ${cmd}`);
        return window.__dialogQueue.shift();
      }
      const r = await fetch("/__invoke/" + cmd, { method: "POST", body: JSON.stringify(args) });
      const j = await r.json();
      if (j.error) throw j.error;
      if (j.ok && j.ok.__bytes) return Uint8Array.from(atob(j.ok.__bytes), (c) => c.charCodeAt(0)).buffer;
      return j.ok;
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__emit = (event, payload) => {
    for (const id of listeners.get(event) ?? []) callbacks.get(id)?.({ event, id, payload });
  };
};

/** Tauri stand-in + command routes on a browser context; returns the list that collects problems */
export async function installShim(context) {
  await context.addInitScript(SHIM, `${TILE}/tile`);
  const issues = [];
  await context.route("**/__invoke/**", async (route) => {
    const cmd = route.request().url().split("/__invoke/")[1];
    const args = JSON.parse(route.request().postData() || "{}");
    try {
      route.fulfill({ json: { ok: (await command(cmd, args)) ?? null } });
    } catch (e) {
      issues.push(`command ${cmd} failed: ${e.message ?? e}`);
      route.fulfill({ json: { error: String(e.message ?? e) } });
    }
  });
  return issues;
}

export async function launch({ url = "http://localhost:1420/", headless = true, viewport = { width: 1440, height: 900 } } = {}) {
  await waitFor(url, 30000);
  // UI_BROWSER=chromium renders backdrop blur in headless mode (WebKit headless does not)
  const browser = await (process.env.UI_BROWSER === "chromium" ? chromium : webkit).launch({ headless });
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const issues = await installShim(context);
  const page = await context.newPage();
  page.on("pageerror", (e) => issues.push(`pageerror: ${e.message}\n${(e.stack ?? "").split("\n").slice(0, 6).join("\n")}`));
  page.on("console", (m) => m.type() === "error" && issues.push(`console: ${m.text()}`));
  page.on("requestfailed", (r) => issues.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  return {
    browser,
    page,
    issues,
    /** queue answers for the next file dialogs */
    dialog: (...answers) => page.evaluate((a) => window.__dialogQueue.push(...a), answers),
    emit: (event, payload) => page.evaluate(([e, p]) => window.__emit(e, p), [event, payload]),
  };
}
