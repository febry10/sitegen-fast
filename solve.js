// sitegen-fast: a fast drop-in for makefun-site 1.0.0.
// run(input) returns, byte for byte, what makefun-site 1.0.0's build returns.
// Written from the reference (vendor/makefun-site) with the same rules, but:
//  - no per-character regex work in the hot paths (chunked HTML escaping, manual
//    line classification, range-based inline rendering without slicing),
//  - slugify / longDate results cached (tag names and dates repeat heavily),
//  - templates rendered by a tree walk that appends to one array per render
//    instead of string-concatenating per node,
//  - the Markdown lexer and renderer fused into one pass over the body's lines,
//  - cards / reading minutes computed once per source and reused.
// Dependency-free ES module; Node stdlib only (nothing imported at all).

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `text` with & < > " and ' escaped. Chunked: untouched text is returned as-is. */
export function escapeHtml(text) {
  let out = null;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let rep;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    else continue;
    if (out === null) out = [];
    if (i > last) out.push(text.slice(last, i));
    out.push(rep);
    last = i + 1;
  }
  if (out === null) return text;
  if (last < text.length) out.push(text.slice(last));
  return out.join('');
}

const SLUG_MAX = 64;
const slugCache = new Map();

/** The slug of `text` (see the reference README, "Text"). Results cached. */
export function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let out;
  // ASCII fast path: NFKD is the identity on ASCII and there are no combining marks.
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) { ascii = false; break; }
  }
  if (ascii) {
    let s = '';
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = s.length > 0;
        continue;
      }
      if (gap) s += '-';
      gap = false;
      s += keep;
    }
    out = s;
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    let s = '';
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = s.length > 0;
        continue;
      }
      if (gap) s += '-';
      gap = false;
      s += keep;
    }
    out = s;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
export function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDateCache = new Map();

/** A YYYY-MM-DD date in words, from the string alone. Results cached. */
export function longDate(date) {
  let hit = longDateCache.get(date);
  if (hit !== undefined) return hit;
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  hit = `${d} ${MONTHS[m - 1]} ${y}`;
  longDateCache.set(date, hit);
  return hit;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    // '"'
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // '['
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = false;
      let y = 0;
      let mo = 0;
      let d = 0;
      if (raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45) {
        const isDig = (c) => c >= 48 && c <= 57;
        const c0 = raw.charCodeAt(0);
        const c1 = raw.charCodeAt(1);
        const c2 = raw.charCodeAt(2);
        const c3 = raw.charCodeAt(3);
        const c5 = raw.charCodeAt(5);
        const c6 = raw.charCodeAt(6);
        const c8 = raw.charCodeAt(8);
        const c9 = raw.charCodeAt(9);
        if (isDig(c0) && isDig(c1) && isDig(c2) && isDig(c3) && isDig(c5) && isDig(c6) && isDig(c8) && isDig(c9)) {
          y = (c0 - 48) * 1000 + (c1 - 48) * 100 + (c2 - 48) * 10 + (c3 - 48);
          mo = (c5 - 48) * 10 + (c6 - 48);
          d = (c8 - 48) * 10 + (c9 - 48);
          ok = true;
        }
      }
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let i = 0; i < t.length; i++) {
          const c = t[i];
          if (c === '"' || c === '[' || c === ']') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-')) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-')) return { error: 'key "slug": not a slug' };
      }
      if (raw.charCodeAt(0) === 45 || raw.charCodeAt(raw.length - 1) === 45 || raw.includes('--')) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Whether `line` is blank (spaces and tabs only). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter and body lines: { data, bodyLines }, or { error }.
 * `lines` is the source's text split on '\n' (line ends already '\n').
 */
export function parseFrontMatterLines(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlank(line) || line.charCodeAt(0) === 35) continue; // '#' comment
    // `^([a-z_]+):(?: (.*))?$` by hand.
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    if (k === 0 || k >= line.length || line.charCodeAt(k) !== 58) return { error: `line ${i + 1} is not "key: value"` };
    const key = line.slice(0, k);
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
    else return { error: `line ${i + 1} is not "key: value"` };
    // Trailing spaces and tabs dropped.
    let e = raw.length;
    while (e > 0) {
      const c = raw.charCodeAt(e - 1);
      if (c === 32 || c === 9) e--;
      else break;
    }
    if (e < raw.length) raw = raw.slice(0, e);
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyLines: lines.slice(close + 1) };
}

// ---------------------------------------------------------------- markdown

/** The characters a backslash escapes. */
const ESCAPABLE = new Uint8Array(128);
for (const ch of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']) ESCAPABLE[ch.charCodeAt(0)] = 1;

/** Whether one character is JS-whitespace (\s). */
function isWSCode(c) {
  return (
    c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 ||
    c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 ||
    c === 8239 || c === 8287 || c === 12288 || c === 65279
  );
}

/** A line with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c === 32 || c === 9) a++;
    else break;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c === 32 || c === 9) b--;
    else break;
  }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** A fence-open line's language, or null. */
function fenceOpenLang(line) {
  if (!line.startsWith('```')) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  for (; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, i);
}

/** Whether `line` closes a fence. */
function isFenceClose(line) {
  if (!line.startsWith('```')) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's depth and text, or null. */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  if (n >= line.length) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let e = line.length;
  while (e > n + 1) {
    const cc = line.charCodeAt(e - 1);
    if (cc === 32 || cc === 9) e--;
    else break;
  }
  if (e === n + 1) return null;
  return { depth: n, text: line.slice(n + 1, e) };
}

/** Whether `line` is a thematic break. */
function isHr(line) {
  if (!(line.startsWith('---') || line.startsWith('***'))) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet list item's text, or null. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return { ordered: false, text: line.slice(2) };
  return null;
}

/** An ordered list item's number and text, or null. */
function orderedOf(line) {
  let i = 0;
  while (i < line.length && i < 9) {
    const c = line.charCodeAt(i);
    if (c >= 48 && c <= 57) i++;
    else break;
  }
  if (i === 0) return null;
  if (line.charCodeAt(i) === 46 && line.charCodeAt(i + 1) === 32) {
    return { ordered: true, start: Number(line.slice(0, i)), text: line.slice(i + 2) };
  }
  return null;
}

/** Whether `line` continues a list item (two or more spaces, then a non-space). */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i < 2) return false;
  if (i >= line.length) return false;
  return !isWSCode(line.charCodeAt(i));
}

/** Whether `line` ends a paragraph. */
function endsParagraph(line) {
  return isBlank(line) || fenceOpenLang(line) !== null || headingOf(line) !== null || isHr(line);
}

/** The first index in [from, end) where `s` holds `what` outside an escape, or -1. */
function findUnescaped(s, what, from, end) {
  const wlen = what.length;
  for (let j = from; j <= end - wlen; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < end && ESCAPABLE[s.charCodeAt(j + 1)] === 1) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * in [from, end) outside an escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < end && ESCAPABLE[s.charCodeAt(j + 1)] === 1) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (j + 1 < end && s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** The first `ch` at or after `from` and before `end`, or -1. */
function indexBefore(s, ch, from, end) {
  const j = s.indexOf(ch, from);
  return j === -1 || j >= end ? -1 : j;
}

/** Whether `target` holds whitespace (the link rule's test). */
function hasWS(target) {
  for (let i = 0; i < target.length; i++) {
    if (isWSCode(target.charCodeAt(i))) return true;
  }
  return false;
}

/**
 * `s[a..b)` rendered inline into `out`; `env.link(target)` is a link's href.
 * No slicing: recursion works on ranges of the same string.
 */
function inlineInto(s, a, b, env, out) {
  let i = a;
  let last = a;
  const flush = () => {
    if (i > last) out.push(escapeHtml(s.slice(last, i)));
  };
  while (i < b) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < b && ESCAPABLE[s.charCodeAt(i + 1)] === 1) {
      flush();
      out.push(ESCAPES[s[i + 1]] ?? s[i + 1]);
      i += 2;
      last = i;
      continue;
    }
    if (c === 96) {
      // '`'
      const j = indexBefore(s, '`', i + 1, b);
      if (j > i + 1) {
        flush();
        out.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        i = j + 1;
        last = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === 42) {
      // '*'
      if (i + 1 < b && s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2, b);
        if (j > i + 2) {
          flush();
          out.push('<strong>');
          inlineInto(s, i + 2, j, env, out);
          out.push('</strong>');
          i = j + 2;
          last = i;
        } else {
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1, b);
      if (j > i + 1) {
        flush();
        out.push('<em>');
        inlineInto(s, i + 1, j, env, out);
        out.push('</em>');
        i = j + 1;
        last = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === 91) {
      // '['
      const k = findUnescaped(s, ']', i + 1, b);
      let m = -1;
      let target = '';
      if (k !== -1 && k + 1 < b && s.charCodeAt(k + 1) === 40) {
        const r = indexBefore(s, ')', k + 2, b);
        if (r !== -1) {
          m = r;
          target = s.slice(k + 2, m);
        }
      }
      if (m !== -1 && target !== '' && !hasWS(target)) {
        flush();
        out.push('<a href="', escapeHtml(env.link(target)), '">');
        inlineInto(s, i + 1, k, env, out);
        out.push('</a>');
        i = m + 1;
        last = i;
      } else {
        i++;
      }
      continue;
    }
    i++;
  }
  flush();
}

/** `s` rendered inline. */
function inlineStr(s, env) {
  const out = [];
  inlineInto(s, 0, s.length, env, out);
  return out.join('');
}

/**
 * The body's lines rendered: HTML, table of contents and excerpt.
 * One fused pass: lexing and rendering together, no token objects.
 */
function renderMarkdown(lines, env) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const N = lines.length;
  while (i < N) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceOpenLang(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < N && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      let code = '';
      for (const l of body) {
        code += escapeHtml(l);
        code += '\n';
      }
      blocks.push(`<pre><code${cls}>${code}</code></pre>`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inlineStr(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      // '>'
      const body = [];
      while (i < N && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1)));
      }
      let kept = null;
      for (const l of body) {
        if (l !== '') {
          if (kept === null) kept = [];
          kept.push(l);
        }
      }
      blocks.push(kept === null ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inlineStr(kept.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    const firstBullet = bulletOf(line);
    const firstOrdered = firstBullet === null ? orderedOf(line) : null;
    if (firstBullet !== null || firstOrdered !== null) {
      const isOrdered = firstOrdered !== null;
      const start = isOrdered ? firstOrdered.start : 1;
      const items = [];
      while (i < N) {
        const m = isOrdered ? orderedOf(lines[i]) : bulletOf(lines[i]);
        if (m !== null) {
          items.push([trimLine(m.text)]);
          i++;
        } else if (isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let html = `${open}\n`;
      for (const item of items) html += `<li>${inlineStr(item.join('\n'), env)}</li>\n`;
      html += `</${tag}>`;
      blocks.push(html);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < N && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inlineStr(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  let html = '';
  for (const blk of blocks) {
    html += blk;
    html += '\n';
  }
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

export const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
export class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
export function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain (frames, innermost last). */
function lookup(frames, path) {
  let v;
  let found = false;
  for (let i = frames.length - 1; i >= 0; i--) {
    if (Object.hasOwn(frames[i], path[0])) {
      v = frames[i][path[0]];
      found = true;
      break;
    }
  }
  if (!found) return undefined;
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text. */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered into `out` (an array of strings) in scope `frames`. */
function renderNodes(nodes, frames, out, templates, depth) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escapeHtml(textOf(lookup(frames, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(frames, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(frames, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, frames, out, templates, depth);
        break;
      }
      case 'for': {
        const xs = lookup(frames, n.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        const fr = { [n.name]: null, loop: { index: 0, first: false, last: false, length: len } };
        frames.push(fr);
        for (let k = 0; k < len; k++) {
          fr[n.name] = xs[k];
          const lp = fr.loop;
          lp.index = k + 1;
          lp.first = k === 0;
          lp.last = k === len - 1;
          renderNodes(n.body, frames, out, templates, depth);
        }
        frames.pop();
        break;
      }
      case 'include': {
        const t = templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, frames, out, templates, depth + 1);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- build

/** The top-level directories the generator writes itself. */
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);
export const REPORT_FILE = 'build-report.txt';

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isWSCode(text.charCodeAt(i))) inWord = false;
    else if (!inWord) {
      n++;
      inWord = true;
    }
  }
  return n;
}

/** The words of a body's lines (the '\n' joins are whitespace, so lines count apart). */
function wordsOfLines(lines) {
  let n = 0;
  for (const line of lines) {
    let inWord = false;
    for (let i = 0; i < line.length; i++) {
      if (isWSCode(line.charCodeAt(i))) inWord = false;
      else if (!inWord) {
        n++;
        inWord = true;
      }
    }
  }
  return n;
}

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  let i = 0;
  while (i <= rel.length) {
    let j = rel.indexOf('/', i);
    if (j === -1) j = rel.length;
    const seg = rel.slice(i, j);
    if (seg === '' || seg === '.') {
      // skip
    } else if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
    i = j + 1;
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** One site's output tree: path -> text. */
export function run(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, lines: f.content.replace(/\r\n?/g, '\n').split('\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // Front matter, in source order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatterLines(s.lines);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyLines = fm.bodyLines;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) {
        own = d;
        break;
      }
    }
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks.
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, its links resolved.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (
          (target.charCodeAt(0) >= 65 && target.charCodeAt(0) <= 90) ||
          (target.charCodeAt(0) >= 97 && target.charCodeAt(0) <= 122)
        ) {
          // A scheme: [A-Za-z][A-Za-z0-9+.-]*:
          let i = 1;
          while (i < target.length) {
            const c = target.charCodeAt(i);
            if (
              (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
              c === 43 || c === 46 || c === 45
            ) {
              i++;
            } else break;
          }
          if (i < target.length && target.charCodeAt(i) === 58) return target;
        }
        if (target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null) {
          const page = bySource.get(path);
          if (page !== undefined) return `${page.url}${frag}`;
          if (staticPaths.has(path)) return `${base}/${path}${frag}`;
        }
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.bodyLines, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.reading = Math.max(1, Math.ceil(wordsOfLines(s.bodyLines) / 200));
  }

  // Collections: posts, newest first, then by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags.
  const bySlug = new Map();
  const ownTagNames = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTagNames(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTagNames(s).map((name) => {
      const slug = slugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards, computed once per source and reused (page render + lists).
  const linkOf = (s) =>
    s === null
      ? null
      : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.reading,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  for (const s of kept) s.card = cardOf(s);
  const pageOf = (s) => ({
    ...s.card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // Layouts.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, [{ site, tags: allTags, recent, ...vars }], out, templates, 0);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pagesCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pagesCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
