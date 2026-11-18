// Builds the LaTeX user manual from the in-app help pages (docs/help/*.md), with the app's own
// Markdown parser so sections and anchors match the Help window exactly.
//   cd app && npm run manual
// Writes manual/build/ (main.tex, version.tex, chapters/, img/, icon.png), compiles it when
// tectonic or latexmk is installed, and zips it as manual/micro-speed-grader-manual-<version>-draft.zip.
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
function link(text: string, href: string) {
  if (/^https?:/.test(href)) return `\\href{${href.replace(/[%#]/g, "\\$&")}}{${inline(text)}}`;
  const [file, anchor = ""] = href.split("#");
  const f = file ? file.replace(/\.md$/, "").replace(/^\.\//, "") : FILE;
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
const imgDir = path.join(OUT, "img");
function probe(file: string) {
  const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,nb_frames", "-of", "csv=p=0", file], { encoding: "utf8" });
  const [w, h, n] = out.trim().split(",").map(Number);
  return { w, h, n };
}
/** copy the picture (an animation becomes its last-but-a-bit frame, which shows the result) and size it */
function image(src: string, alt: string) {
  const from = path.join(HELP, src);
  const base = path.basename(src).replace(/\.gif$/i, ".png");
  const to = path.join(imgDir, base);
  const anim = /\.gif$/i.test(src);
  if (anim) {
    const { n } = probe(from);
    const frame = Math.max(0, Math.round((n || 1) * 0.85) - 1);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", from, "-vf", `select=eq(n\\,${frame})`, "-frames:v", "1", to]);
  } else fs.copyFileSync(from, to);
  // screenshots are 2× (retina): a 1600 px wide one fills the text width, smaller ones stay smaller
  const { w } = probe(to);
  const frac = Math.min(1, w / 1600);
  const cap = inline(alt) + (anim ? ` \\textcolor{black!45}{(animated in the online help)}` : "");
  return `\\shot{${frac.toFixed(2)}\\linewidth}{img/${base}}{${cap}}`;
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
  out.push(`\\clearpage\n\\section{${inline(title)}}\\label{${label(file)}}`);
  labels.add(label(file));
  if (doc.meta.blurb && file !== "index") out.push(`{\\color{black!55}\\itshape ${inline(doc.meta.blurb)}}\\par\\medskip`);
  for (const b of doc.blocks) {
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
  return out.join("\n\n") + "\n";
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
fs.mkdirSync(path.join(OUT, "chapters"), { recursive: true });
fs.mkdirSync(imgDir, { recursive: true });
fs.copyFileSync(path.join(SRC, "main.tex"), path.join(OUT, "main.tex"));
fs.copyFileSync(path.join(ROOT, "app/src-tauri/icons/icon.png"), path.join(OUT, "icon.png"));
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

const pages = fs
  .readdirSync(HELP)
  .filter((f) => f.endsWith(".md"))
  .map((f) => ({ id: f.replace(/\.md$/, ""), doc: parseMarkdown(fs.readFileSync(path.join(HELP, f), "utf8")) }))
  .sort((a, b) => Number(a.doc.meta.order ?? 99) - Number(b.doc.meta.order ?? 99));
const all: string[] = [];
for (const p of pages) {
  fs.writeFileSync(path.join(OUT, "chapters", `${p.id}.tex`), chapter(p.id, p.doc));
  all.push(`\\input{chapters/${p.id}}`);
}
fs.writeFileSync(path.join(OUT, "chapters", "all.tex"), all.join("\n") + "\n");

const broken = [...new Set(refs)].filter((r) => !labels.has(r));
console.log(`${pages.length} chapters, ${fs.readdirSync(imgDir).length} images, version ${version} (${commit}${ahead ? `, ${ahead} commits after v${version}` : ""})`);
if (unknown.size) console.log(`characters with no LaTeX mapping: ${[...unknown].join(" ")}`);
if (broken.length) console.log(`links to missing sections: ${broken.join(", ")}`);

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
