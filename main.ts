// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves a successful edit made, as [old, new] pairs, for the `R` output rows. */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** Section 5: a file's text as lines, its line break, whether it ends with one (section 3). */
interface FileText {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const trimEndST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadST = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndST(a) === trimEndST(b);
  return trimST(a) === trimST(b);
}

/** Positions i >= from where O matches the file's lines at the tier; occurrences may overlap. */
function occurrences(O: string[], F: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, from); i + O.length <= F.length; i += 1) {
    let ok = true;
    for (let j = 0; j < O.length; j += 1) {
      if (!lineEq(O[j]!, F[i + j]!, tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier with an occurrence at or after `from`, or null (section 5). */
function findTier(O: string[], F: string[], strict: boolean, from: number): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(O, F, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** N with context lines taken from the file's matched lines, other lines re-indented at tier 2. */
function buildNew(N: { text: string; ctx: number }[], F: string[], pos: number, tier: number, O: string[]): string[] {
  const P = O.length > 0 ? leadST(O[0]!) : '';
  const F0 = pos < F.length ? leadST(F[pos]!) : '';
  return N.map((n) => {
    if (n.ctx >= 0) return F[pos + n.ctx]!;
    if (tier !== 2) return n.text;
    if (n.text.trim() === '') return n.text;
    return n.text.startsWith(P) ? F0 + n.text.slice(P.length) : n.text;
  });
}

/** One body line of a hunk or chunk: ' ' context, '-' old, '+' new, '\' no-newline mark. */
interface BodyLine {
  kind: string;
  text: string;
  empty: boolean;
}

/** A hunk or chunk body split into old lines O and new lines N (ctx: the O index of a context line). */
function bodyON(body: BodyLine[]): { O: string[]; N: { text: string; ctx: number }[] } {
  const O: string[] = [];
  const N: { text: string; ctx: number }[] = [];
  for (const b of body) {
    if (b.kind === ' ') { N.push({ text: b.text, ctx: O.length }); O.push(b.text); }
    else if (b.kind === '-') O.push(b.text);
    else if (b.kind === '+') N.push({ text: b.text, ctx: -1 });
  }
  return { O, N };
}

/** Whether a `\` line follows the body's last context or `+` line. */
function backslashAfterLast(body: BodyLine[]): boolean {
  for (let k = body.length - 1; k >= 0; k -= 1) {
    if (body[k]!.kind === ' ' || body[k]!.kind === '+') return body[k + 1] !== undefined && body[k + 1]!.kind === '\\';
  }
  return false;
}

/** Section 6: one unified-diff section. */
interface Hunk {
  a: number;
  body: BodyLine[];
}

interface Section {
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  hasPair: boolean;
  renameOld: string | null;
  renameNew: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
  oldPath: string | null;
  newPath: string | null;
}

const DIFF_RE = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The path of a `--- ` or `+++ ` header line: after the four characters, up to the first tab, trimmed, a/ or b/ removed; /dev/null is null. */
function headerPath(line: string): string | null {
  const rest = line.slice(4).split('\t', 1)[0]!.trim();
  const p = rest.startsWith('a/') || rest.startsWith('b/') ? rest.slice(2) : rest;
  return p === '/dev/null' ? null : p;
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  const fresh = (dOld: string | null, dNew: string | null): Section => ({
    diffOld: dOld, diffNew: dNew, pairOld: null, pairNew: null, hasPair: false,
    renameOld: null, renameNew: null, isCreate: false, isDelete: false,
    hunks: [], oldPath: null, newPath: null,
  });
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh(m[1]!, m[2]!);
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.hunks.length > 0) {
        cur = fresh(null, null);
        sections.push(cur);
      }
      cur.pairOld = headerPath(line);
      cur.pairNew = headerPath(lines[i + 1]!);
      cur.hasPair = true;
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: parseInt(m[1]!, 10), body: [] };
      i += 1;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          hunk.body.push({ kind: b === '' ? ' ' : b[0]!, text: b === '' ? '' : b.slice(1), empty: b === '' });
          i += 1;
        } else break;
      }
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.empty) hunk.body.pop();
      cur.hunks.push(hunk);
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameOld = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameNew = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  for (const s of sections) {
    s.oldPath = s.hasPair ? s.pairOld : s.renameOld !== null ? s.renameOld : s.diffOld;
    s.newPath = s.hasPair ? s.pairNew : s.renameNew !== null ? s.renameNew : s.diffNew;
  }
  return sections;
}

/** The file a creation section makes: the `+` lines of all its hunks, in order. */
function creationText(hunks: Hunk[]): string {
  const lines: string[] = [];
  let last: { h: Hunk; k: number } | null = null;
  for (const h of hunks) {
    for (let k = 0; k < h.body.length; k += 1) {
      if (h.body[k]!.kind === '+') { lines.push(h.body[k]!.text); last = { h, k }; }
    }
  }
  if (lines.length === 0) return '';
  const noBreak = last !== null && last.h.body[last.k + 1] !== undefined && last.h.body[last.k + 1]!.kind === '\\';
  return `${lines.join('\n')}${noBreak ? '' : '\n'}`;
}

/** A section's hunks applied in order to a file's text (section 6). */
function applyHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(before);
  let d = 0;
  for (const h of hunks) {
    const { O, N } = bodyON(h.body);
    if (O.length === 0) {
      const at = Math.min(h.a + d, f.lines.length);
      const added = N.map((n) => n.text);
      f.lines.splice(at, 0, ...added);
      if (at === f.lines.length - added.length) {
        let noBreak = false;
        for (let k = h.body.length - 1; k >= 0; k -= 1) {
          if (h.body[k]!.kind === '+') { noBreak = h.body[k + 1] !== undefined && h.body[k + 1]!.kind === '\\'; break; }
        }
        f.final = !noBreak;
      }
      d += N.length;
      continue;
    }
    const found = findTier(O, f.lines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.occ[0]!;
    for (const p of found.occ) {
      if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
    }
    const added = buildNew(N, f.lines, pos, found.tier, O);
    const runsToEnd = pos + O.length === f.lines.length;
    f.lines.splice(pos, O.length, ...added);
    if (runsToEnd) f.final = !backslashAfterLast(h.body);
    d += N.length - O.length;
  }
  return joinFile(f);
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((s) => {
    const oldP = s.oldPath;
    const newP = s.newPath;
    const isCreate = (s.isCreate || oldP === null) && newP !== null;
    const isDelete = !isCreate && (s.isDelete || newP === null) && oldP !== null;
    return (tree: Tree): void => {
      if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (newP !== null && newP !== oldP && !safe(newP)) throw new Fail('unsafe', newP);
      if (isCreate) {
        if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
        tree.now.set(newP!, creationText(s.hunks));
        return;
      }
      if (isDelete) {
        if (tree.get(oldP!) === null) throw new Fail('missing', oldP!);
        tree.now.set(oldP!, null);
        return;
      }
      if (oldP !== null && newP !== null && oldP !== newP) {
        const before = tree.get(oldP);
        if (before === null) throw new Fail('missing', oldP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const text = applyHunks(before, s.hunks, strict, oldP);
        tree.now.set(oldP, null);
        tree.now.set(newP, text);
        tree.moves.push([oldP, newP]);
        return;
      }
      if (oldP === null && newP === null) return;
      const p = (oldP ?? newP)!;
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      tree.now.set(p, applyHunks(before, s.hunks, strict, p));
    };
  });
}

/** Section 7: SEARCH/REPLACE blocks. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  for (;;) {
    let s = -1;
    for (let k = i; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') { s = k; break; }
    }
    if (s < 0) break;
    let path: string | null = null;
    for (let k = s - 1; k >= prevEnd; k -= 1) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    let eq = -1;
    for (let k = s + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '=======') { eq = k; break; }
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') { rep = k; break; }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree: Tree): void => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const f = splitFile(before);
      const found = findTier(oldLines, f.lines, strict, 0);
      if (found === null) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const pos = found.occ[0]!;
      const added = buildNew(newLines.map((t) => ({ text: t, ctx: -1 })), f.lines, pos, found.tier, oldLines);
      f.lines.splice(pos, oldLines.length, ...added);
      tree.now.set(p, joinFile(f));
    });
    prevPath = p;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/** Section 8: V4A patches. */
interface VChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

/** An Update File section's chunks applied in order, with the cursor (section 8). */
function applyV4a(before: string, chunks: VChunk[], strict: boolean, path: string): string {
  const f = splitFile(before);
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      const found = findTier([ch.anchor], f.lines, strict, cursor);
      if (found === null) throw new Fail('no-match', path);
      cursor = found.occ[0]! + 1;
    }
    const { O, N } = bodyON(ch.body);
    if (O.length === 0) {
      const at = ch.eof ? f.lines.length : cursor;
      const added = N.map((n) => n.text);
      f.lines.splice(at, 0, ...added);
      cursor = at + added.length;
      continue;
    }
    const found = findTier(O, f.lines, strict, cursor);
    if (found === null) throw new Fail('no-match', path);
    let pos = -1;
    for (const p of found.occ) {
      if (ch.eof && p + O.length !== f.lines.length) continue;
      pos = p;
      break;
    }
    if (pos < 0) throw new Fail('no-match', path);
    const added = buildNew(N, f.lines, pos, found.tier, O);
    f.lines.splice(pos, O.length, ...added);
    cursor = pos + added.length;
  }
  return joinFile(f);
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) { last = k; break; }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) { i += 1; continue; }
    if (line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ')) {
      const content: { text: string; num: number }[] = [];
      let j = i + 1;
      while (j < last) {
        const l = lines[j]!;
        if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
        content.push({ text: l, num: j + 1 });
        j += 1;
      }
      while (content.length > 0 && blank(content[content.length - 1]!.text)) content.pop();
      if (line.startsWith('*** Add File: ')) {
        const p = line.slice(14).trim();
        const fileLines: string[] = [];
        for (const c of content) {
          if (c.text === '') fileLines.push('');
          else if (c.text[0] === '+') fileLines.push(c.text.slice(1));
          else throw new Exit2(`error: parse ${c.num}`);
        }
        const text = fileLines.length === 0 ? '' : `${fileLines.join('\n')}\n`;
        edits.push((tree: Tree): void => {
          if (!safe(p)) throw new Fail('unsafe', p);
          if (tree.get(p) !== null) throw new Fail('exists', p);
          tree.now.set(p, text);
        });
      } else if (line.startsWith('*** Delete File: ')) {
        const p = line.slice(17).trim();
        for (const c of content) throw new Exit2(`error: parse ${c.num}`);
        edits.push((tree: Tree): void => {
          if (!safe(p)) throw new Fail('unsafe', p);
          if (tree.get(p) === null) throw new Fail('missing', p);
          tree.now.set(p, null);
        });
      } else {
        const p = line.slice(17).trim();
        const headerNum = i + 1;
        let moveTo: string | null = null;
        let k = 0;
        if (content.length > 0 && content[0]!.text.startsWith('*** Move to: ')) {
          moveTo = content[0]!.text.slice(13).trim();
          k = 1;
        }
        const chunks: VChunk[] = [];
        let cur: VChunk | null = null;
        for (; k < content.length; k += 1) {
          const c = content[k]!;
          if (c.text.startsWith('@@')) {
            const anchor = c.text.slice(2).trim();
            cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
            chunks.push(cur);
          } else if (c.text === '*** End of File') {
            if (cur === null) throw new Exit2(`error: parse ${c.num}`);
            cur.eof = true;
            cur = null;
          } else if (c.text === '' || c.text[0] === ' ' || c.text[0] === '-' || c.text[0] === '+') {
            if (cur === null) { cur = { anchor: null, body: [], eof: false }; chunks.push(cur); }
            cur.body.push({ kind: c.text === '' ? ' ' : c.text[0]!, text: c.text === '' ? '' : c.text.slice(1), empty: c.text === '' });
          } else {
            throw new Exit2(`error: parse ${c.num}`);
          }
        }
        if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerNum}`);
        const chs = chunks;
        const mt = moveTo;
        edits.push((tree: Tree): void => {
          if (!safe(p)) throw new Fail('unsafe', p);
          if (mt !== null && !safe(mt)) throw new Fail('unsafe', mt);
          const before = tree.get(p);
          if (before === null) throw new Fail('missing', p);
          if (mt !== null && tree.get(mt) !== null) throw new Fail('exists', mt);
          const text = applyV4a(before, chs, strict, p);
          if (mt !== null) {
            tree.now.set(p, null);
            tree.now.set(mt, text);
            tree.moves.push([p, mt]);
          } else {
            tree.now.set(p, text);
          }
        });
      }
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byPath = new Map<string, string>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    byPath.set(p, was === null ? 'A' : now === null ? 'D' : 'M');
  }
  const out: { key: string; text: string }[] = [];
  for (const [oldP, newP] of tree.moves) {
    if (byPath.get(oldP) === 'D' && byPath.get(newP) === 'A') {
      byPath.delete(oldP);
      byPath.delete(newP);
      out.push({ key: newP, text: `R ${oldP} -> ${newP}` });
    }
  }
  for (const [p, k] of byPath) out.push({ key: p, text: `${k} ${p}` });
  out.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = out.map((r) => r.text);
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
