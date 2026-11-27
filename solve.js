// Faster drop-in for makefun-diff 1.0.0.
//
// Semantics (from the competition rules): a text is cut after every '\n';
// the common line prefix is kept, then the common suffix of what is left;
// between them Myers's greedy search, deletion preferred when a deletion
// and an insertion reach the same point, never past either text's end, no
// edge-diagonal pruning, every run of equal lines followed fully; the first
// path to reach both ends is the script. The patch prints the header line,
// hunks with 3 kept lines of context each side, runs at most 6 kept lines
// apart sharing a hunk, deletions before insertions in each change run, and
// a '%' line after a final line written with an added newline.
//
// Speed plan: intern every distinct line to a small integer id once (one
// Map per call, shared by both texts), trim prefix/suffix on ids, run
// Myers over Int32Arrays with no per-cell allocation, keep every depth's
// furthest-x per diagonal in one flat history array (depth d's slice starts
// at d*d, so the walk back needs no offsets table; Uint16 while the texts
// are short enough for it, Int32 otherwise), then emit the patch in a
// single pass. The inner loop walks the predecessor slice and its own
// slice with running pointers, reading the two predecessor cells at
// adjacent slots.

/** Split text into lines (each keeping its '\n', except a final bare line). */
function tokenize(text, map, ids, lines) {
  let pos = 0;
  const len = text.length;
  while (pos < len) {
    const nl = text.indexOf('\n', pos);
    let line;
    if (nl === -1) {
      line = text.slice(pos);
      pos = len;
    } else {
      line = text.slice(pos, nl + 1);
      pos = nl + 1;
    }
    let id = map.get(line);
    if (id === undefined) {
      id = map.size;
      map.set(line, id);
    }
    ids.push(id);
    lines.push(line);
  }
}

/**
 * The edit runs of trimmed id-arrays a (length N) into b (length M):
 * [{ kind, count }] with kind 0 = keep, 1 = delete, 2 = insert, in order.
 * Reproduces makefun-diff's greedy search exactly, including its
 * deletion-wins-ties choice and its first-to-reach-both-ends stop.
 */
function diffRuns(a, b) {
  const N = a.length;
  const M = b.length;
  if (N === 0 && M === 0) return [];
  // History: depth d's V slice lives at vh[d*d .. d*d + 2d], slot j holding
  // diagonal k = 2j - d. x values never exceed N, so Uint16Array holds them
  // while N < 65535 (the generator caps texts at 40,000 lines); SENT marks
  // an unreachable diagonal. It grows by doubling; a slice never moves
  // once written, so the walk back reads it in place.
  const small = N < 65535 && M < 65535;
  const SENT = small ? 65535 : -1;
  let cap = 1 << 24;
  let vh = small ? new Uint16Array(cap) : new Int32Array(cap);

  // Depth 0: the snake from (0, 0).
  let x = 0;
  let y = 0;
  while (x < N && y < M && a[x] === b[y]) {
    x++;
    y++;
  }
  vh[0] = x;
  if (x === N && y === M) {
    return x > 0 ? [{ kind: 0, count: x }] : [];
  }

  let D = -1;
  let kEnd = 0;
  const maxD = N + M;
  outer: for (let d = 1; d <= maxD; d++) {
    const base = d * d;
    if ((d + 1) * (d + 1) > cap) {
      const grown = small ? new Uint16Array(cap * 2) : new Int32Array(cap * 2);
      grown.set(vh);
      vh = grown;
      cap *= 2;
    }
    const pbase = (d - 1) * (d - 1);
    let pv = pbase;
    let wv = base;
    let k = -d;
    for (let j = 0; j <= d; j++, k += 2, pv++, wv++) {
      const x1 = j === 0 ? SENT : vh[pv - 1];
      const x2 = j === d ? SENT : vh[pv];
      const canDel = x1 !== SENT && x1 < N;
      const canIns = x2 !== SENT && x2 - k - 1 < M;
      let del;
      if (canDel && canIns) del = x1 + 1 >= x2;
      else if (canDel) del = true;
      else if (canIns) del = false;
      else {
        vh[wv] = SENT;
        continue;
      }
      x = del ? x1 + 1 : x2;
      y = x - k;
      while (x < N && y < M && a[x] === b[y]) {
        x++;
        y++;
      }
      vh[wv] = x;
      if (x === N && y === M) {
        D = d;
        kEnd = k;
        break outer;
      }
    }
  }
  if (D === -1) throw new Error('makefun-diff: the search ended without reaching both ends');

  // Walk back from (N, M) at depth D, recomputing each step's choice with
  // the same rule, and collect runs in reverse.
  const revKind = [];
  const revCnt = [];
  x = N;
  y = M;
  let k = kEnd;
  for (let d = D; d >= 1; d--) {
    const pbase = (d - 1) * (d - 1);
    const half = d - 1;
    let x1 = SENT;
    let x2 = SENT;
    if (k - 1 >= -half && k - 1 <= half) x1 = vh[pbase + ((k - 1 + half) >> 1)];
    if (k + 1 >= -half && k + 1 <= half) x2 = vh[pbase + ((k + 1 + half) >> 1)];
    const canDel = x1 !== SENT && x1 < N;
    const canIns = x2 !== SENT && x2 - k - 1 < M;
    let del;
    if (canDel && canIns) del = x1 + 1 >= x2;
    else del = canDel;
    let xe;
    let xPrev;
    let prevK;
    if (del) {
      xPrev = x1;
      prevK = k - 1;
      xe = x1 + 1;
    } else {
      xPrev = x2;
      prevK = k + 1;
      xe = x2;
    }
    const snake = x - xe;
    if (snake > 0) {
      revKind.push(0);
      revCnt.push(snake);
    }
    revKind.push(del ? 1 : 2);
    revCnt.push(1);
    x = xPrev;
    y = xPrev - prevK;
    k = prevK;
  }
  if (x > 0) {
    revKind.push(0);
    revCnt.push(x);
  }

  // Reverse and merge adjacent runs of one kind.
  const runs = [];
  for (let i = revKind.length - 1; i >= 0; i--) {
    const kind = revKind[i];
    const count = revCnt[i];
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === kind) last.count += count;
    else runs.push({ kind, count });
  }
  return runs;
}

/** A patch line: op + line, plus a '%' line when the line had no newline. */
function written(op, line) {
  return line.endsWith('\n') ? op + line : op + line + '\n%\n';
}

/** makefun-diff 1.0.0's answer for one case's input { old, new }. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const map = new Map();
  const aIds = [];
  const bIds = [];
  const aLines = [];
  const bLines = [];
  tokenize(input.old, map, aIds, aLines);
  tokenize(input.new, map, bIds, bLines);
  const A = Int32Array.from(aIds);
  const B = Int32Array.from(bIds);
  const n = A.length;
  const m = B.length;

  // Common prefix, then common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && A[prefix] === B[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && A[n - 1 - suffix] === B[m - 1 - suffix]) suffix++;

  const mid = diffRuns(A.subarray(prefix, n - suffix), B.subarray(prefix, m - suffix));
  const runs = [];
  const pushRun = (kind, count) => {
    if (count <= 0) return;
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === kind) last.count += count;
    else runs.push({ kind, count });
  };
  pushRun(0, prefix);
  for (const r of mid) pushRun(r.kind, r.count);
  pushRun(0, suffix);

  // Change runs: consecutive deletions/insertions between kept lines.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const r of runs) {
    if (r.kind === 0) {
      o += r.count;
      p += r.count;
      continue;
    }
    let c = changes[changes.length - 1];
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (r.kind === 1) {
      c.dels += r.count;
      o += r.count;
      deleted += r.count;
    } else {
      c.ins += r.count;
      p += r.count;
      inserted += r.count;
    }
  }

  // Hunks: change runs at most 6 kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks[hunks.length - 1];
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 6) h.push(c);
    else hunks.push([c]);
  }

  const out = [`makefun-diff/1 old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - 3);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(3, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) out.push(written('=', aLines[at]));
      for (let i = 0; i < c.dels; i++) out.push(written('-', aLines[c.o + i]));
      for (let i = 0; i < c.ins; i++) out.push(written('+', bLines[c.p + i]));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(written('=', aLines[at]));
  }
  return out.join('');
}
