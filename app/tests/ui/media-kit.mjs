// Shared bits for recording help media: a drawn cursor + key badges (headless captures show no
// pointer), and a screencast → GIF recorder cropped to a rectangle.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/** init script: draws a cursor and shows pressed keys as badges */
export const cursorScript = () => {
  const css = `
    #__cur { position: fixed; left: 0; top: 0; z-index: 2147483647; pointer-events: none; will-change: transform; }
    #__cur svg { display: block; filter: drop-shadow(0 1px 2px rgba(0,0,0,.6)); }
    #__cur .btn { position: absolute; left: -9px; top: -9px; width: 18px; height: 18px; border-radius: 50%;
      border: 2px solid #ffd257; opacity: 0; transition: opacity .1s; }
    #__cur.down .btn { opacity: 1; }
    #__key { position: fixed; z-index: 2147483647; pointer-events: none; padding: 8px 16px; border-radius: 12px;
      background: rgba(20,20,22,.9); color: #fff; font: 700 26px -apple-system, sans-serif; min-width: 24px; text-align: center;
      box-shadow: 0 2px 10px rgba(0,0,0,.5); border: 1px solid rgba(255,255,255,.25); opacity: 0; transition: opacity .15s; }
    #__key.on { opacity: 1; }`;
  const names = { " ": "Space", Enter: "↵", Escape: "Esc", ArrowRight: "→", ArrowLeft: "←", Backspace: "⌫", Meta: "⌘", Shift: "⇧", Alt: "⌥" };
  let x = 0, y = 0, timer = 0;
  window.addEventListener("DOMContentLoaded", () => {
    const st = document.createElement("style");
    st.textContent = css;
    document.head.appendChild(st);
    const c = document.createElement("div");
    c.id = "__cur";
    c.innerHTML = `<div class="btn"></div><svg width="18" height="22" viewBox="0 0 18 22"><path d="M1 1v17l4.5-4.2 3 6.6 2.6-1.2-3-6.4H14Z" fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg>`;
    document.body.appendChild(c);
    const k = document.createElement("div");
    k.id = "__key";
    document.body.appendChild(k);
  });
  const move = (e) => {
    x = e.clientX;
    y = e.clientY;
    const c = document.getElementById("__cur");
    if (c) c.style.transform = `translate(${x}px, ${y}px)`;
  };
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerdown", (e) => (move(e), document.getElementById("__cur")?.classList.add("down")), true);
  window.addEventListener("pointerup", () => document.getElementById("__cur")?.classList.remove("down"), true);
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.repeat || ["Meta", "Shift", "Alt", "Control"].includes(e.key)) return;
      const k = document.getElementById("__key");
      if (!k || window.__noKeys) return;
      const mods = (e.metaKey ? "⌘" : "") + (e.shiftKey && e.key.length > 1 ? "⇧" : "");
      k.textContent = mods + (names[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key));
      const a = window.__keyAt ?? { x: x + 22, y: y + 18 };
      k.style.left = a.x + "px";
      k.style.top = a.y + "px";
      k.classList.add("on");
      clearTimeout(timer);
      timer = setTimeout(() => k.classList.remove("on"), 750);
    },
    true,
  );
};

/**
 * Record `fn` as a GIF cropped to `crop` ({x,y,width,height} in CSS px, viewport scale 1).
 * `width` is the GIF's output width.
 */
export async function recordGif(context, page, { file, crop, work, width = 640, fps = 12 }, fn) {
  const frames = [];
  const cdp = await context.newCDPSession(page);
  cdp.on("Page.screencastFrame", (f) => {
    frames.push({ t: f.metadata.timestamp, data: f.data });
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  const vp = page.viewportSize();
  await cdp.send("Page.startScreencast", { format: "png", maxWidth: vp.width, maxHeight: vp.height, everyNthFrame: 1 });
  await page.waitForTimeout(500);
  await fn();
  await page.waitForTimeout(900);
  await cdp.send("Page.stopScreencast");
  await cdp.detach();
  const dir = path.join(work, path.basename(file, ".gif"));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const list = [];
  frames.forEach((f, i) => {
    const fp = path.join(dir, `f${String(i).padStart(5, "0")}.png`);
    fs.writeFileSync(fp, Buffer.from(f.data, "base64"));
    const dur = i + 1 < frames.length ? frames[i + 1].t - f.t : 1.5;
    list.push(`file '${fp}'`, `duration ${dur.toFixed(3)}`);
  });
  list.push(list[list.length - 2]);
  fs.writeFileSync(path.join(dir, "frames.txt"), list.join("\n"));
  const c = { x: Math.round(crop.x), y: Math.round(crop.y), w: Math.round(crop.width) & ~1, h: Math.round(crop.height) & ~1 };
  const vf = `crop=${c.w}:${c.h}:${c.x}:${c.y},fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
  execFileSync("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", path.join(dir, "frames.txt"), "-vf", vf, "-loop", "0", file], { stdio: "ignore" });
  return { frames: frames.length, kb: Math.round(fs.statSync(file).size / 1e3) };
}
