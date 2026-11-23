#!/usr/bin/env node
// The GitHub wiki, written from the help pages in docs/help (the one source: also the app's Help window).
//   node tools/sync-wiki.mjs <dir>
// writes the wiki's pages into <dir> (a clone of <repo>.wiki.git, or any folder to look at the result):
// Home from index.md with the list of topics, one page per article named after its title, a sidebar and
// a footer. Links between articles become wiki links, images point at docs/help/img on main, notes
// become GitHub note boxes, and long pages get a contents list. Every *.md already in <dir> is replaced,
// so a page that's renamed or removed in docs/help goes from the wiki too.
// It fails when a link points at a page or section that isn't there (and writes each section link with the anchor GitHub gives that heading).
// The Wiki workflow runs this on every push to main that touches docs/help.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HELP = path.join(ROOT, "docs/help");
const REPO = process.env.GITHUB_REPOSITORY || "agadin/micro-speed-grader";
const WIKI = `https://github.com/${REPO}/wiki`;
const IMG = `https://raw.githubusercontent.com/${REPO}/main/docs/help`;
const SOURCE = `https://github.com/${REPO}/blob/main/docs/help`;

const out = process.argv[2];
if (!out) {
  console.error("usage: node tools/sync-wiki.mjs <dir>");
  process.exit(2);
}

// ---------------- read ----------------
const plain = (s) =>
  s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<\/?kbd>/g, "")
    .replace(/[*`]/g, "");
/** the anchor the app gives a heading (app/src/lib/markdown.tsx), which links in docs/help use */
const appSlug = (s) => plain(s).toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s/g, "-");
/** the anchor GitHub gives it: the same, but nothing is trimmed, so "Unlabelled pins (?)" ends in a dash */
const slug = (s) => plain(s).trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");

function read(file) {
  const id = file.replace(/\.md$/, "");
  let lines = fs.readFileSync(path.join(HELP, file), "utf8").replace(/\r\n?/g, "\n").split("\n");
  const meta = {};
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    for (const l of lines.slice(1, end)) {
      const m = /^(\w+):\s*(.*)$/.exec(l);
      if (m) meta[m[1]] = m[2].trim();
    }
    lines = lines.slice(end + 1);
  }
  const title = meta.title ?? id;
  // the wiki shows the page's name as its title: the article's own "# Title" would repeat it
  const h1 = lines.findIndex((l) => l.trim());
  let dropped = "";
  if (id !== "index" && /^#\s/.test(lines[h1] ?? "")) dropped = lines.splice(h1, 1)[0].replace(/^#\s+/, "");
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  return { id, title, dropped, blurb: meta.blurb ?? "", order: Number(meta.order ?? 99), lines, page: id === "index" ? "Home" : title.replace(/[\\/:*?"<>|#%]/g, "").trim().replace(/\s+/g, "-") };
}

const pages = fs
  .readdirSync(HELP)
  .filter((f) => f.endsWith(".md"))
  .map(read)
  .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
const byId = new Map(pages.map((p) => [p.id, p]));
const home = byId.get("index");
const topics = pages.filter((p) => p !== home);
const names = new Set();
for (const p of pages) {
  if (names.has(p.page.toLowerCase())) throw new Error(`two help pages would both be the wiki page "${p.page}"`);
  names.add(p.page.toLowerCase());
}
const url = (p, anchor = "") => (p === home ? WIKI : `${WIKI}/${encodeURI(p.page)}`) + (anchor ? `#${anchor}` : "");

// ---------------- transform ----------------
const bad = [];
/** run fn on every line outside ``` code blocks */
function prose(lines, fn) {
  let code = false;
  return lines.flatMap((l, i) => {
    if (l.startsWith("```")) {
      code = !code;
      return [l];
    }
    return code ? [l] : [fn(l, i)].flat();
  });
}

// headings as GitHub will anchor them (a repeated heading gets -1, -2, …)
for (const p of pages) {
  p.heads = [];
  const used = new Map();
  // the app still counts the "# Title" taken off above when it numbers repeated headings
  const usedApp = new Map(p.dropped ? [[appSlug(p.dropped), 1]] : []);
  const nth = (map, base) => {
    const n = map.get(base) ?? 0;
    map.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };
  prose(p.lines, (l) => {
    const m = /^(#{1,6})\s+(.*)$/.exec(l);
    if (m) p.heads.push({ depth: m[1].length, text: m[2], id: nth(used, slug(m[2])), app: nth(usedApp, appSlug(m[2])) });
    return l;
  });
}

function links(p, line) {
  return line.replace(/(!?)\[([^\]]*)\]\(([^)\s]+)\)/g, (all, bang, text, href) => {
    if (/^(https?:|mailto:)/.test(href)) return all;
    if (bang) {
      if (!fs.existsSync(path.join(HELP, href))) bad.push(`${p.id}.md: image ${href} is missing`);
      return `![${text}](${IMG}/${href.replace(/^\.\//, "")})`;
    }
    const [file, anchor = ""] = href.split("#");
    const to = file ? byId.get(file.replace(/^\.\//, "").replace(/\.md$/, "")) : p;
    if (!to) {
      bad.push(`${p.id}.md: link to ${href}: no such page`);
      return all;
    }
    // the link names the section as the app does; the wiki needs GitHub's name for it
    const head = anchor && to.heads.find((h) => h.app === anchor);
    if (anchor && !head) bad.push(`${p.id}.md: link to ${href}: no such section`);
    const id = head ? head.id : "";
    // a link within the page stays a plain anchor (no reload)
    return `[${text}](${to === p ? `#${id}` : url(to, id)})`;
  });
}

function body(p) {
  let lines = p.lines;
  // Home ends with the list of topics, written below
  if (p === home) {
    const at = lines.findIndex((l) => /^##\s+Topics\s*$/.test(l));
    if (at >= 0) lines = lines.slice(0, at);
  }
  return prose(lines, (l, i) => {
    const t = links(p, l);
    // "> a note" becomes a GitHub note box, unless it already says which kind ("> [!WARNING]")
    if (t.startsWith(">") && !lines[i - 1]?.startsWith(">") && !/^>\s*\[!\w+\]/.test(t)) return ["> [!NOTE]", t];
    return t;
  });
}

const GENERATED = (p) => `<!-- Written from docs/help/${p.id}.md by tools/sync-wiki.mjs. Change that file: edits made here are overwritten. -->`;

function topicPage(p, i) {
  const o = [GENERATED(p), "", `*${p.blurb}*`, ""];
  const h2 = p.heads.filter((h) => h.depth === 2);
  if (h2.length >= 4) o.push("**On this page:** " + h2.map((h) => `[${h.text.replace(/[*`]/g, "")}](#${h.id})`).join(" · "), "");
  o.push(...body(p), "", "---", "");
  const prev = i ? topics[i - 1] : home;
  const next = topics[i + 1];
  o.push(
    [`← [${prev === home ? "Help home" : prev.title}](${url(prev)})`, next ? `[${next.title}](${url(next)}) →` : `[Help home](${url(home)})`].join(
      " &nbsp;·&nbsp; ",
    ),
  );
  return o.join("\n") + "\n";
}

function homePage() {
  const o = [GENERATED(home), "", ...body(home)];
  while (!o.at(-1).trim()) o.pop();
  o.push("", "## Topics", "", "| | |", "|---|---|");
  for (const p of topics) o.push(`| **[${p.title}](${url(p)})** | ${p.blurb.replace(/\|/g, "\\|")} |`);
  o.push(
    "",
    "## Get the app",
    "",
    `[Download the latest version](https://github.com/${REPO}/releases/latest) for macOS or Windows. These pages are also inside the app: **Help ▸ Micro Speed Grader Help** (**⌘?**).`,
  );
  return o.join("\n") + "\n";
}

const sidebar =
  [
    `**[Micro Speed Grader Help](${url(home)})**`,
    "",
    ...topics.map((p) => `- [${p.title}](${url(p)})`),
    "",
    "---",
    "",
    `[Download the app](https://github.com/${REPO}/releases/latest)  `,
    `[Report a problem](https://github.com/${REPO}/issues)`,
  ].join("\n") + "\n";
const footer = `These pages are also in the app: **Help ▸ Micro Speed Grader Help**. They are written from [docs/help](${SOURCE}); to suggest a change, [open an issue](https://github.com/${REPO}/issues).\n`;

// ---------------- write ----------------
const files = new Map([
  ["Home.md", homePage()],
  ...topics.map((p, i) => [`${p.page}.md`, topicPage(p, i)]),
  ["_Sidebar.md", sidebar],
  ["_Footer.md", footer],
]);
if (bad.length) {
  console.error(bad.join("\n"));
  process.exit(1);
}
fs.mkdirSync(out, { recursive: true });
for (const f of fs.readdirSync(out)) if (f.endsWith(".md")) fs.rmSync(path.join(out, f));
for (const [name, text] of files) fs.writeFileSync(path.join(out, name), text);
console.log(`wiki: ${files.size - 2} pages, sidebar and footer written to ${out}`);
