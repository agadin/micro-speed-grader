/**
 * The help wiki: Markdown articles in docs/help (one source, read in the app's Help window and on GitHub).
 * Each article starts with front matter: title, blurb, order (and optional icon).
 * Images live in docs/help/img and are bundled with the app.
 */
import { parseMarkdown, type Doc } from "./markdown";

const RAW = import.meta.glob("../../../docs/help/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const IMG = import.meta.glob("../../../docs/help/img/*.{png,gif,jpg,webp}", { query: "?url", import: "default", eager: true }) as Record<
  string,
  string
>;

export interface Article extends Doc {
  id: string;
  title: string;
  blurb: string;
  order: number;
}

const fileId = (p: string) => p.split("/").pop()!.replace(/\.md$/, "");

export const ARTICLES: Article[] = Object.entries(RAW)
  .map(([p, src]) => {
    const d = parseMarkdown(src);
    const id = fileId(p);
    return {
      ...d,
      id,
      title: d.meta.title ?? d.headings[0]?.text ?? id,
      blurb: d.meta.blurb ?? "",
      order: Number(d.meta.order ?? 99),
    };
  })
  .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));

/** "index" is the home page; everything else is a topic */
export const HOME = ARTICLES.find((a) => a.id === "index");
export const TOPICS = ARTICLES.filter((a) => a.id !== "index");
export const article = (id: string) => ARTICLES.find((a) => a.id === id);

/** "img/grading.gif" → bundled URL */
export const helpImage = (src: string) => {
  const name = src.split("/").pop();
  const hit = Object.entries(IMG).find(([p]) => p.endsWith(`/img/${name}`));
  return hit?.[1];
};

/**
 * A help reference: "topic" or "topic/anchor" (as used by data-help attributes and open_help).
 * Markdown links look like "grading.md#lasso" — both forms resolve here.
 */
export function parseRef(ref: string): { id: string; anchor: string } {
  const [file, hash = ""] = ref.split("#");
  const [id, anchor = hash] = file.replace(/\.md$/, "").replace(/^\.\//, "").split("/");
  return { id: id || "index", anchor };
}

export interface Hit {
  id: string;
  title: string;
  anchor: string;
  /** heading or snippet that matched */
  label: string;
  score: number;
}

/** where a search hit points: "article" or "article/section" */
export const hitRef = (h: Hit) => (h.anchor ? `${h.id}/${h.anchor}` : h.id);

/** Search titles, headings and text. Every word must appear somewhere in the article. */
export function searchHelp(q: string, limit = 12): Hit[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits: Hit[] = [];
  for (const a of ARTICLES) {
    const all = `${a.title} ${a.blurb} ${a.text}`.toLowerCase();
    if (!words.every((w) => all.includes(w))) continue;
    const t = a.title.toLowerCase();
    const score = words.filter((w) => t.includes(w)).length * 5 + words.filter((w) => a.blurb.toLowerCase().includes(w)).length * 2;
    hits.push({ id: a.id, title: a.title, anchor: "", label: a.blurb, score: score + 1 });
    for (const h of a.headings) {
      const ht = h.text.toLowerCase();
      const n = words.filter((w) => ht.includes(w)).length;
      if (n && h.depth > 1) hits.push({ id: a.id, title: a.title, anchor: h.id, label: h.text, score: n * 4 + (n === words.length ? 3 : 0) });
    }
  }
  return hits.sort((x, y) => y.score - x.score).slice(0, limit);
}
