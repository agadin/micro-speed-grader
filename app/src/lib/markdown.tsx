/**
 * A small Markdown renderer for the help articles in docs/help (our own files, but still rendered as
 * React elements, never as raw HTML). Supports what the articles use, all of which GitHub also renders:
 *   # headings (ids from the text, as GitHub makes them), paragraphs, - lists, 1. steps,
 *   > notes, | tables |, ``` code ```, ![images](img/x.png), [links](other.md#anchor),
 *   **bold**, *italic*, `code`, <kbd>keys</kbd>, and a leading --- front matter --- block.
 */
import { Fragment, type ReactNode } from "react";

export interface Heading {
  depth: number;
  text: string;
  id: string;
}

export interface Doc {
  meta: Record<string, string>;
  blocks: Block[];
  headings: Heading[];
  /** plain text, for search */
  text: string;
}

/** a list item: its text plus any indented sub-bullets and continuation paragraphs */
interface Item {
  text: string;
  sub: string[];
  more: string[];
}

type Block =
  | { t: "h"; depth: number; text: string; id: string }
  | { t: "p"; text: string }
  | { t: "ul" | "ol"; items: Item[] }
  | { t: "note"; text: string }
  | { t: "table"; head: string[]; rows: string[][] }
  | { t: "code"; text: string }
  | { t: "img"; alt: string; src: string };

/** GitHub-style heading anchor: lower case, punctuation dropped, spaces → dashes */
export const slug = (s: string) =>
  stripInline(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s/g, "-");

const stripInline = (s: string) =>
  s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<\/?kbd>/g, "")
    .replace(/[*`]/g, "");

export function parseMarkdown(src: string): Doc {
  const meta: Record<string, string> = {};
  let lines = src.replace(/\r\n?/g, "\n").split("\n");
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) {
      for (const l of lines.slice(1, end)) {
        const m = /^(\w+):\s*(.*)$/.exec(l);
        if (m) meta[m[1]] = m[2].trim();
      }
      lines = lines.slice(end + 1);
    }
  }
  const blocks: Block[] = [];
  const used = new Map<string, number>();
  let i = 0;
  const isBreak = (l: string) => /^(#{1,6}\s|>|[-*]\s|\d+\.\s|\||```|!\[)/.test(l);
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) {
      i++;
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(l))) {
      const base = slug(m[2]);
      const n = used.get(base) ?? 0;
      used.set(base, n + 1);
      blocks.push({ t: "h", depth: m[1].length, text: m[2], id: n ? `${base}-${n}` : base });
      i++;
    } else if (l.startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) body.push(lines[i++]);
      i++;
      blocks.push({ t: "code", text: body.join("\n") });
    } else if ((m = /^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/.exec(l))) {
      blocks.push({ t: "img", alt: m[1], src: m[2] });
      i++;
    } else if (l.startsWith(">")) {
      const body: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) body.push(lines[i++].replace(/^>\s?/, ""));
      blocks.push({ t: "note", text: body.join(" ").replace(/^\[!\w+\]\s*/, "") });
    } else if (l.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        const cells = lines[i++].replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        if (!cells.every((c) => /^:?-+:?$/.test(c))) rows.push(cells);
      }
      blocks.push({ t: "table", head: rows[0] ?? [], rows: rows.slice(1) });
    } else if (/^([-*]|\d+\.)\s/.test(l)) {
      const ordered = /^\d+\./.test(l);
      const items: Item[] = [];
      let lastSub = false;
      while (i < lines.length) {
        const line = lines[i];
        if (!line.trim()) {
          // a blank line ends the list unless the next line is indented or another item
          const next = lines[i + 1] ?? "";
          if (/^\s{2,}\S/.test(next) || (ordered ? /^\d+\.\s/ : /^[-*]\s/).test(next)) {
            i++;
            lastSub = false;
            continue;
          }
          break;
        }
        const top = /^([-*]|\d+\.)\s+(.*)$/.exec(line);
        const sub = /^\s{2,}([-*]|\d+\.)\s+(.*)$/.exec(line);
        if (top) {
          if ((ordered ? !/^\d/.test(top[1]) : /^\d/.test(top[1]))) break;
          items.push({ text: top[2], sub: [], more: [] });
          lastSub = false;
        } else if (sub && items.length) {
          items[items.length - 1].sub.push(sub[2]);
          lastSub = true;
        } else if (items.length) {
          const it = items[items.length - 1];
          const t = line.trim();
          if (lastSub && /^\s{4,}/.test(line)) it.sub[it.sub.length - 1] += " " + t;
          else if (/^\s{2,}/.test(line) && lines[i - 1]?.trim() === "") it.more.push(t);
          else if (it.more.length) it.more[it.more.length - 1] += " " + t;
          else if (lastSub) it.sub[it.sub.length - 1] += " " + t;
          else it.text += " " + t;
        } else break;
        i++;
      }
      blocks.push({ t: ordered ? "ol" : "ul", items });
    } else {
      const body: string[] = [];
      while (i < lines.length && lines[i].trim() && !(body.length && isBreak(lines[i]))) body.push(lines[i++].trim());
      blocks.push({ t: "p", text: body.join(" ") });
    }
  }
  const headings = blocks.filter((b): b is Extract<Block, { t: "h" }> => b.t === "h").map((b) => ({ depth: b.depth, text: stripInline(b.text), id: b.id }));
  const text = blocks
    .map((b) =>
      b.t === "ul" || b.t === "ol" ? b.items.map((it) => [it.text, ...it.sub, ...it.more].join(" ")).join(" ") : b.t === "table" ? [b.head, ...b.rows].flat().join(" ") : b.t === "img" ? b.alt : (b as { text: string }).text,
    )
    .map(stripInline)
    .join("\n");
  return { meta, blocks, headings, text };
}

export interface RenderOpts {
  /** resolve an image path in the article to a URL (undefined = leave the image out) */
  image: (src: string) => string | undefined;
  /** a link was clicked: another article, an anchor, or an external URL */
  onLink: (href: string) => void;
}

/** inline: **bold**, *italic*, `code`, <kbd>k</kbd>, [text](href) */
function inline(s: string, o: RenderOpts, key = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`|<kbd>(.+?)<\/kbd>|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const k = `${key}.${n++}`;
    if (m[1] !== undefined) out.push(<b key={k}>{inline(m[1], o, k)}</b>);
    else if (m[2] !== undefined) out.push(<i key={k}>{inline(m[2], o, k)}</i>);
    else if (m[3] !== undefined) out.push(<code key={k}>{m[3]}</code>);
    else if (m[4] !== undefined) out.push(<kbd key={k}>{m[4]}</kbd>);
    else {
      const href = m[6];
      out.push(
        <a
          key={k}
          href={href}
          onClick={(e) => {
            e.preventDefault();
            o.onLink(href);
          }}
        >
          {inline(m[5], o, k)}
        </a>,
      );
    }
    last = re.lastIndex;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

function itemBody(it: Item, o: RenderOpts, k: string): ReactNode {
  return (
    <>
      {inline(it.text, o, k)}
      {it.sub.length > 0 && (
        <ul className="hp-sub">
          {it.sub.map((x, n) => (
            <li key={n}>{inline(x, o, `${k}.s${n}`)}</li>
          ))}
        </ul>
      )}
      {it.more.map((x, n) => (
        <p key={n} className="hp-more">
          {inline(x, o, `${k}.m${n}`)}
        </p>
      ))}
    </>
  );
}

export function renderMarkdown(doc: Doc, o: RenderOpts): ReactNode {
  return doc.blocks.map((b, i) => {
    const k = String(i);
    switch (b.t) {
      case "h": {
        const H = `h${Math.min(6, b.depth + 1)}` as "h2";
        return (
          <H key={k} id={b.id}>
            {inline(b.text, o, k)}
          </H>
        );
      }
      case "p":
        return <p key={k}>{inline(b.text, o, k)}</p>;
      case "ul":
        return (
          <ul key={k}>
            {b.items.map((it, j) => (
              <li key={j}>{itemBody(it, o, `${k}.${j}`)}</li>
            ))}
          </ul>
        );
      case "ol":
        return (
          <ol key={k} className="hp-steps">
            {b.items.map((it, j) => (
              <li key={j} className="hp-step">
                <span className="hp-n">{j + 1}</span>
                <div>{itemBody(it, o, `${k}.${j}`)}</div>
              </li>
            ))}
          </ol>
        );
      case "note":
        return (
          <p key={k} className="hp-note">
            {inline(b.text, o, k)}
          </p>
        );
      case "table":
        return (
          <table key={k} className="hp-table">
            <thead>
              <tr>
                {b.head.map((c, j) => (
                  <th key={j}>{inline(c, o, `${k}.h${j}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, j) => (
                    <td key={j}>{inline(c, o, `${k}.${ri}.${j}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        );
      case "code":
        return (
          <pre key={k} className="hp-code">
            {b.text}
          </pre>
        );
      case "img": {
        const url = o.image(b.src);
        return url ? (
          <figure key={k} className="hp-fig">
            <img src={url} alt={b.alt} loading="lazy" />
            {b.alt && <figcaption>{b.alt}</figcaption>}
          </figure>
        ) : (
          <Fragment key={k} />
        );
      }
    }
  });
}
