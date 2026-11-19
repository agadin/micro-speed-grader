// The LaTeX user manual. manual/ is a hand-edited LaTeX project (main.tex, chapters/, img/):
//   cd app && npm run manual
// copies it to manual/build/ with a fresh version.tex (version, commit, date), compiles it when
// tectonic or latexmk is installed, and zips it as manual/micro-speed-grader-manual-<version>-draft.zip
// (ready to upload to Overleaf).
//   npm run manual -- --regenerate
// first rewrites manual/chapters/ and manual/img/ from the in-app help (docs/help/*.md), with the
// app's own Markdown parser so sections and anchors match the Help window. That throws away the
// hand edits in chapters/ (git keeps them): use it to start over, or to see what changed in the help.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseMarkdown, type Doc } from "../src/lib/markdown";

const ROOT = path.resolve("..");
const HELP = path.join(ROOT, "docs/help");
const SRC = path.join(ROOT, "manual");
const OUT = path.join(SRC, "build");
const REPO = "https://github.com/agadin/micro-speed-grader";
type Block = Doc["blocks"][number];

// ---------------- text ----------------
const UNICODE: Record<string, string> = {
  "…": "\\ldots{}", "⌘": "\\cmdsym{}", "▸": "\\menuarrow{}", "·": "\\textperiodcentered{}", "⇧": "\\shiftsym{}", "↵": "\\returnsym{}",
  "→": "\\ensuremath{\\rightarrow}", "←": "\\ensuremath{\\leftarrow}", "↑": "\\ensuremath{\\uparrow}", "↓": "\\ensuremath{\\downarrow}",
  "✓": "\\checksym{}", "✗": "\\crosssym{}", "⌥": "\\optsym{}", "µ": "\\textmu{}", "×": "\\ensuremath{\\times}", "⌫": "\\deletesym{}",
  "⚠": "\\warnsym{}", "‹": "\\guilsinglleft{}", "›": "\\guilsinglright{}", "⇥": "\\tabsym{}", "²": "\\textsuperscript{2}",
  "κ": "\\ensuremath{\\kappa}", "↻": "\\ensuremath{\\circlearrowright}", "▶": "\\ensuremath{\\blacktriangleright}",
  "◀": "\\ensuremath{\\blacktriangleleft}", "─": "-", "–": "--", "—": "---", "“": "``", "”": "''", "’": "'", "‘": "`",
};
const SPECIAL: Record<string, string> = {
  "\\": "\\textbackslash{}", "{": "\\{", "}": "\\}", $: "\\$", "&": "\\&", "#": "\\#", "%": "\\%", _: "\\_",
  "^": "\\textasciicircum{}", "~": "\\textasciitilde{}", "<": "\\textless{}", ">": "\\textgreater{}", "|": "\\textbar{}",
};
const unknown = new Set<string>();
function esc(s: string) {
  let o = "";
  for (const ch of s) {
    if (SPECIAL[ch]) o += SPECIAL[ch];
    else if (UNICODE[ch]) o += UNICODE[ch];
    else if (ch.charCodeAt(0) > 127) {
      unknown.add(ch);
      o += ch;
    } else o += ch;
  }
  return o;
}

// ---------------- keys ----------------
const MODS = "⌘⇧⌥⌃";
const NAMED = /^(Esc|Space|Ctrl|Shift|Alt|Option|Tab|Enter|Return|Delete|Backspace|Home|End|PgUp|PgDn|F\d{1,2})$/;
const SINGLE = /^([A-Z0-9]|[[\]/=\-?,.;'`\\]|[←→↑↓↵⌫⇥])$/;
/** "⇧⌘Z" → ["⇧","⌘","Z"], "Ctrl+Z" → ["Ctrl","Z"]; null when it isn't a key */
function keyParts(tok: string): string[] | null {
  if (/^[A-Za-z]+\+/.test(tok)) {
    const parts = tok.split("+");
    return parts.every((p) => NAMED.test(p) || SINGLE.test(p.toUpperCase())) ? parts : null;
  }
  const mods = [...tok].filter((c, i) => MODS.includes(c) && [...tok].slice(0, i).every((x) => MODS.includes(x)));
  const rest = [...tok].slice(mods.length).join("");
  if (!rest) return mods.length ? mods : null;
  return NAMED.test(rest) || SINGLE.test(rest) ? [...mods, rest] : null;
}
const keycaps = (parts: string[]) => parts.map((p) => `\\keycap{${esc(p)}}`).join("\\keyplus{}");
/** Bold text that is only keys ("⌘Z", "↑ ↓", "⌘-click") becomes key caps; anything else stays null. */
function asKeys(s: string): string | null {
  const m = /^([⌘⇧⌥]+)-(click|drag)$/.exec(s);
  if (m) return `${keycaps([...m[1]])}-${m[2]}`;
  const toks = s.trim().split(/\s+/);
  const parts = toks.map(keyParts);
  if (parts.some((p) => !p)) return null;
  return parts.map((p) => keycaps(p!)).join(" ");
}
/** a cell of a shortcuts table: "⇧⌘Z or ⌘Y", "] or N", "Space (hold)" */
function keyCell(s: string) {
  return s
    .split(/(\s+or\s+|,\s+|\s+\/\s+)/)
    .map((part, i) => (i % 2 ? esc(part) : (asKeys(part) ?? inline(part))))
    .join("");
}

// ---------------- inline markdown ----------------
let FILE = "";
const label = (file: string, anchor = "") => `sec:${file}${anchor ? ":" + anchor : ""}`;
const labels = new Set<string>();
const refs: string[] = [];
/** the pages printed in full; the rest get a summary card pointing at the full page online */
const FULL = new Set(["index", "getting-started", "grading", "selecting", "answer-key", "export", "shortcuts", "handoff"]);
/** sections of the full pages left to the online help (by heading id) */
const ONLINE_ONLY: Record<string, string[]> = {
  "getting-started": ["new-and-changed-submissions", "review-changed-submissions", "updates"],
  grading: ["showing-the-pins-differently"],
  selecting: ["paint-with-pins-hidden", "pin-by-pin", "spotlight-and-small-pins", "moving-the-cluster-ring"],
  "answer-key": ["reuse-a-key", "with-other-graders", "new-submissions"],
  export: ["time-spent"],
  handoff: ["whats-in-the-files", "troubleshooting"],
};
const printed = (f: string, anchor: string) => FULL.has(f) && !(anchor && (ONLINE_ONLY[f] ?? []).includes(anchor));
const online = (f: string, anchor = "") => `${REPO}/blob/main/docs/help/${f}.md${anchor ? "#" + anchor : ""}`;
const href = (url: string, text: string) => `\\href{${url.replace(/[%#]/g, "\\$&")}}{${text}}`;
function link(text: string, href_: string) {
  if (/^https?:/.test(href_)) return href(href_, inline(text));
  const [file, anchor = ""] = href_.split("#");
  const f = file ? file.replace(/\.md$/, "").replace(/^\.\//, "") : FILE;
  if (!printed(f, anchor)) return `${href(online(f, anchor), inline(text))}\\,\\onlinemark{}`;
  refs.push(label(f, anchor));
  return `\\hyperref[${label(f, anchor)}]{${inline(text)}}`;
}
function inline(s: string): string {
  let o = "";
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    let m: RegExpExecArray | null;
    if ((m = /^`([^`]+)`/.exec(rest))) o += `\\texttt{${esc(m[1])}}`;
    else if ((m = /^<kbd>([^<]+)<\/kbd>/.exec(rest))) o += asKeys(m[1]) ?? `\\keycap{${esc(m[1])}}`;
    else if ((m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest))) o += link(m[1], m[2]);
    else if ((m = /^\*\*(.+?)\*\*/.exec(rest))) o += asKeys(m[1]) ?? `\\textbf{${inline(m[1])}}`;
    else if ((m = /^\*([^*\s][^*]*?)\*/.exec(rest))) o += `\\emph{${inline(m[1])}}`;
    else {
      o += esc(s[i]);
      i++;
      continue;
    }
    i += m[0].length;
  }
  return o;
}

// ---------------- images ----------------
const REGEN = process.argv.includes("--regenerate") || !fs.existsSync(path.join(SRC, "chapters"));
const CH = path.join(SRC, "chapters");
const imgDir = path.join(SRC, "img");
function probe(file: string) {
  const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,nb_frames", "-of", "csv=p=0", file], { encoding: "utf8" });
  const [w, h, n] = out.trim().split(",").map(Number);
  return { w, h, n };
}
/** copy the picture (an animation becomes its last-but-a-bit frame, which shows the result) and size it */
function picture(src: string) {
  const from = path.join(HELP, src);
  const base = path.basename(src).replace(/\.gif$/i, ".png");
  const to = path.join(imgDir, base);
  const anim = /\.gif$/i.test(src);
  if (anim) {
    const { n } = probe(from);
    const frame = Math.max(0, Math.round((n || 1) * 0.85) - 1);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", from, "-vf", `select=eq(n\\,${frame})`, "-frames:v", "1", to]);
  } else fs.copyFileSync(from, to);
  return { base, to, anim };
}
function image(src: string, alt: string) {
  const { base, to } = picture(src);
  // screenshots are 2× (retina): a 1600 px wide one fills the text width, smaller ones stay smaller
  const { w } = probe(to);
  const frac = Math.min(0.72, w / 2000);
  const cap = inline(alt);
  return `\\shot{${frac.toFixed(2)}\\linewidth}{img/${base}}{${cap}}`;
}

/** a small picture of a page that's only summarised */
function thumb(src: string, alt: string) {
  const { base } = picture(src);
  return `\\par\\smallskip{\\centering\\tcbox[enhanced, boxsep=0pt, left=0pt, right=0pt, top=0pt, bottom=0pt, arc=4pt, boxrule=0.5pt, colframe=black!22, colback=white, clip upper]{\\includegraphics[width=0.7\\linewidth, height=4.2cm, keepaspectratio]{img/${base}}}\\par{\\scriptsize\\color{black!55}${inline(alt)}}\\par}\\smallskip`;
}

// ---------------- blocks ----------------
const KEY_HEADS = /^(keys?|shortcut)$/i;
function table(b: Extract<Block, { t: "table" }>) {
  const keyCol = KEY_HEADS.test(b.head[0] ?? "");
  const cols = b.head.map((_, i) => (keyCol && i === 0 ? ">{\\raggedright\\arraybackslash}p{0.24\\linewidth}" : "Y")).join("");
  const row = (cells: string[], head = false) =>
    cells.map((c, i) => (head ? `\\textbf{${inline(c)}}` : keyCol && i === 0 ? keyCell(c) : inline(c))).join(" & ") + " \\\\";
  return [
    "\\begingroup\\renewcommand{\\arraystretch}{1.35}",
    `\\noindent\\begin{tabularx}{\\linewidth}{${cols}}`,
    "\\toprule",
    "\\rowcolor{soft} " + row(b.head, true),
    "\\midrule",
    ...b.rows.map((r) => row(r)),
    "\\bottomrule",
    "\\end{tabularx}\\endgroup\\par\\medskip",
  ].join("\n");
}
function list(b: Extract<Block, { t: "ul" | "ol" }>) {
  const env = b.t === "ol" ? "enumerate" : "itemize";
  const items = b.items.map((it) => {
    let s = `\\item ${inline(it.text)}`;
    if (it.sub.length) s += `\n\\begin{itemize}[topsep=1pt]\n${it.sub.map((x) => `\\item ${inline(x)}`).join("\n")}\n\\end{itemize}`;
    for (const p of it.more) s += `\n\n${inline(p)}`;
    return s;
  });
  return `\\begin{${env}}[topsep=2pt, itemsep=2pt]\n${items.join("\n")}\n\\end{${env}}`;
}
function code(text: string) {
  const body = text
    .split("\n")
    .map((l) => [...l].map((ch) => (ch === "\\" ? "\\textbackslash{}" : ch === "{" ? "\\{" : ch === "}" ? "\\}" : (UNICODE[ch] ?? ch))).join(""))
    .join("\n");
  return `\\begin{codebox}\\begin{alltt}\n${body}\n\\end{alltt}\\end{codebox}`;
}
const SECTION = ["", "section", "subsection", "subsubsection", "paragraph", "paragraph", "paragraph"];
function chapter(file: string, doc: Doc) {
  FILE = file;
  const out: string[] = [];
  const title = file === "index" ? "Introduction" : doc.meta.title;
  out.push(`\\section{${inline(title)}}\\label{${label(file)}}`);
  labels.add(label(file));
  const skipped: string[] = [];
  let skipping = false;
  for (const b of doc.blocks) {
    // the introduction's topic list is the table of contents here
    if (file === "index" && b.t === "h" && b.depth === 2) break;
    if (b.t === "h" && b.depth <= 2) {
      skipping = (ONLINE_ONLY[file] ?? []).includes(b.id);
      if (skipping) skipped.push(href(online(file, b.id), inline(b.text)) + "\\,\\onlinemark{}");
    }
    if (skipping) continue;
    if (b.t === "h") {
      labels.add(label(file, b.id));
      if (b.depth === 1) {
        out.push(`\\phantomsection\\label{${label(file, b.id)}}`);
        continue;
      }
      out.push(`\\${SECTION[b.depth]}{${inline(b.text)}}\\label{${label(file, b.id)}}`);
    } else if (b.t === "p") out.push(inline(b.text));
    else if (b.t === "note") out.push(`\\begin{note}${inline(b.text)}\\end{note}`);
    else if (b.t === "ul" || b.t === "ol") out.push(list(b));
    else if (b.t === "table") out.push(table(b));
    else if (b.t === "code") out.push(code(b.text));
    else if (b.t === "img") out.push(image(b.src, b.alt));
  }
  if (skipped.length) out.push(`{\\small\\color{black!65}\\textbf{Also in the online help:} ${skipped.join(" \\textperiodcentered{} ")}}`);
  return out.join("\n\n") + "\n";
}

/** a page not printed in full: what it's for, what it covers, and where to read it */
function card(file: string, doc: Doc) {
  FILE = file;
  const first = doc.blocks.find((b) => b.t === "p") as { text: string } | undefined;
  const topics = doc.blocks.filter((b) => b.t === "h" && b.depth === 2).map((b) => inline((b as { text: string }).text));
  const url = online(file);
  const pic = doc.blocks.find((b) => b.t === "img") as { src: string; alt: string } | undefined;
  labels.add(label(file));
  return [
    `\\begin{pagecard}\\phantomsection\\addcontentsline{toc}{subsection}{${inline(doc.meta.title)}}\\label{${label(file)}}`,
    `{\\large\\bfseries\\color{accent}${inline(doc.meta.title)}}\\par\\smallskip`,
    first ? inline(first.text) + "\\par" : "",
    pic ? thumb(pic.src, pic.alt) : "",
    topics.length ? `{\\small\\color{black!60}Covers: ${topics.join(" \\textperiodcentered{} ")}}` : "",
    "\\tcblower",
    `\\centering${href(url, "\\qrcode[height=1.75cm, nolink]{" + url + "}")}\\\\[3pt]{\\scriptsize\\raggedright ${href(url, "\\nolinkurl{" + url.replace(/^https:\/\//, "") + "}")}}`,
    "\\end{pagecard}",
    "",
  ].join("\n");
}

// ---------------- build ----------------
const conf = JSON.parse(fs.readFileSync(path.join(ROOT, "app/src-tauri/tauri.conf.json"), "utf8"));
const version: string = conf.version;
const git = (...a: string[]) => execFileSync("git", ["-C", ROOT, ...a], { encoding: "utf8" }).trim();
const commit = git("rev-parse", "--short", "HEAD");
// changes on main since the release this version names: say so on the cover
let ahead = 0;
try {
  ahead = Number(git("rev-list", "--count", `v${version}..HEAD`));
} catch {
  /* no tag here */
}
const date = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(
  path.join(OUT, "version.tex"),
  [
    `\\newcommand{\\appversion}{${version}}`,
    `\\newcommand{\\appcommit}{${commit}}`,
    `\\newcommand{\\builddate}{${date}}`,
    `\\newcommand{\\appchanges}{${ahead ? ", plus changes made since then that will be in the next release" : ""}}`,
    `\\newcommand{\\repourl}{${REPO}}`,
    `\\newcommand{\\releaseurl}{${REPO}/releases/latest}`,
    "",
  ].join("\n"),
);

let broken: string[] = [];
if (REGEN) {
  fs.mkdirSync(CH, { recursive: true });
  fs.mkdirSync(imgDir, { recursive: true });
  const pages = fs
    .readdirSync(HELP)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({ id: f.replace(/\.md$/, ""), doc: parseMarkdown(fs.readFileSync(path.join(HELP, f), "utf8")) }))
    .sort((a, b) => Number(a.doc.meta.order ?? 99) - Number(b.doc.meta.order ?? 99));
  const all: string[] = [];
  for (const p of pages.filter((p) => FULL.has(p.id))) {
    fs.writeFileSync(path.join(CH, `${p.id}.tex`), chapter(p.id, p.doc));
    all.push(`\\input{chapters/${p.id}}`);
  }
  const rest = pages.filter((p) => !FULL.has(p.id));
  fs.writeFileSync(
    path.join(CH, "more.tex"),
    `\\bigskip\n\\section{More in the online help}\\label{sec:more}\n` +
      `These pages of the Help are summarised here. Scan a code, or click a title's link, to read the full page; it's also in the app under \\textbf{Help}.\\par\\medskip\n\n` +
      rest.map((p) => card(p.id, p.doc)).join("\n"),
  );
  all.push("\\input{chapters/more}");
  fs.writeFileSync(path.join(CH, "all.tex"), all.join("\n") + "\n");

  broken = [...new Set(refs)].filter((r) => !labels.has(r));
  console.log(`${pages.length - rest.length} pages in full, ${rest.length} summarised, ${fs.readdirSync(imgDir).length} images, version ${version} (${commit}${ahead ? `, ${ahead} commits after v${version}` : ""})`);
  if (unknown.size) console.log(`characters with no LaTeX mapping: ${[...unknown].join(" ")}`);
  if (broken.length) console.log(`links to missing sections: ${broken.join(", ")}`);
}
// the LaTeX project as edited by hand
fs.copyFileSync(path.join(SRC, "main.tex"), path.join(OUT, "main.tex"));
fs.cpSync(CH, path.join(OUT, "chapters"), { recursive: true });
fs.cpSync(imgDir, path.join(OUT, "img"), { recursive: true });

// compile when a TeX engine is installed
const has = (cmd: string) => {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
let pdf = false;
if (has("tectonic")) {
  execFileSync("tectonic", ["-X", "compile", "--keep-logs", "main.tex"], { cwd: OUT, stdio: "inherit" });
  pdf = true;
} else if (has("latexmk")) {
  execFileSync("latexmk", ["-pdf", "-interaction=nonstopmode", "main.tex"], { cwd: OUT, stdio: "inherit" });
  pdf = true;
} else console.log("no tectonic or latexmk: zipping the LaTeX without a PDF");
const name = `micro-speed-grader-manual-${version}-draft`;
if (pdf) fs.copyFileSync(path.join(OUT, "main.pdf"), path.join(OUT, `${name}.pdf`));
for (const f of fs.readdirSync(OUT)) if (/\.(aux|log|out|toc|fls|fdb_latexmk|synctex\.gz)$/.test(f) || f === "main.pdf") fs.rmSync(path.join(OUT, f));
const zip = path.join(SRC, `${name}.zip`);
fs.rmSync(zip, { force: true });
execFileSync("zip", ["-qr", zip, "."], { cwd: OUT });
console.log(`wrote ${path.relative(ROOT, zip)}${pdf ? ` (with ${name}.pdf)` : ""}`);
if (broken.length) process.exit(1);
