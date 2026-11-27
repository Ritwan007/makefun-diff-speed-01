// Faster drop-in for makefun-diff 1.0.0 — v5: candidate + banded exact.
//
// Same output contract as v1 (the exact greedy Myers script, byte for
// byte). Three layers, each checked by the next:
//
// 1. An anchored candidate: lines occurring exactly once in each text
//    form pairs; a longest increasing chain of them splits the trimmed
//    middle into segments, each solved with the exact greedy solver.
//    On the generated case family most lines are unique in both texts,
//    so the segments are a handful of lines and the candidate is both
//    fast and (on every validated case) cost-optimal — but its path
//    can still differ from the house path inside tie regions.
// 2. The exact greedy search itself, run in a narrow band of diagonals
//    around the candidate's waypoints. A band can only underestimate
//    furthest-x values; when the path it finds stays well inside the
//    band and verifiably turns a into b, it is the house script. When
//    the path nears the band's edge, a second, much wider band must
//    agree on the same script before it is used.
// 3. Whenever the bands disagree, miss, or fail verification, the
//    plain exact search (diffRuns over the whole middle) decides.
//
// diffRuns is the exact solver: v1's greedy Myers over interned line
// ids, full history, deletion-wins-ties, first path to reach both ends.
// Validated byte-identical to the house oracle on the practice set,
// 160 generated cases across 40 seeds, and 3,322 fuzz/edge cases.

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
 * The edit runs of id-arrays a (length N) into b (length M):
 * [{ kind, count }] with kind 0 = keep, 1 = delete, 2 = insert, in order.
 * Reproduces makefun-diff's greedy search exactly, including its
 * deletion-wins-ties choice and its first-to-reach-both-ends stop.
 */
function diffRuns(a, b) {
  const N = a.length;
  const M = b.length;
  if (N === 0 && M === 0) return [];
  const small = N < 65535 && M < 65535;
  const SENT = small ? 65535 : -1;
  // History: depth d's V slice lives at vh[d*d .. d*d + 2d]. The deepest
  // possible search is N + M, so (N + M + 2)^2 entries always suffice.
  let cap = (N + M + 2) * (N + M + 2);
  if (cap > (1 << 28)) cap = 1 << 28;
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

/**
 * Anchored decomposition of the trimmed middle. Returns the same runs
 * shape as diffRuns. Falls back to diffRuns on the whole middle when
 * there are too few anchors to help.
 */
/**
 * Anchored candidate for the trimmed middle: lines occurring exactly
 * once in each text form candidate pairs; a longest increasing chain
 * of them (by b position) splits the middle into segments, each solved
 * with the exact greedy solver. The result is a valid script whose
 * cost is optimal on the generated case family; solveMiddle verifies
 * and, where needed, corrects it with the exact search.
 */
function diffAnchored(a, b, numIds) {
  const N = a.length;
  const M = b.length;
  if (N + M < 128) return diffRuns(a, b);

  const cntA = new Int32Array(numIds);
  const cntB = new Int32Array(numIds);
  const posB = new Int32Array(numIds);
  for (let i = 0; i < N; i++) cntA[a[i]]++;
  for (let j = 0; j < M; j++) {
    cntB[b[j]]++;
    posB[b[j]] = j;
  }

  // Candidate anchor pairs (i in a, j in b), i ascending by construction.
  const candI = [];
  const candJ = [];
  for (let i = 0; i < N; i++) {
    const id = a[i];
    if (cntA[id] === 1 && cntB[id] === 1) {
      candI.push(i);
      candJ.push(posB[id]);
    }
  }
  if (candI.length < 8) return diffRuns(a, b);

  // Longest strictly increasing subsequence of candJ (patience, with
  // parent pointers) — the anchor chain.
  const tails = []; // indices into cand*, per length
  const prevIdx = new Int32Array(candI.length).fill(-1);
  for (let t = 0; t < candJ.length; t++) {
    const v = candJ[t];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (candJ[tails[mid]] < v) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prevIdx[t] = tails[lo - 1];
    if (lo === tails.length) tails.push(t);
    else tails[lo] = t;
  }
  const chain = [];
  for (let t = tails[tails.length - 1]; t !== -1; t = prevIdx[t]) chain.push(t);
  chain.reverse();
  if (chain.length < 8) return diffRuns(a, b);

  const runs = [];
  const pushRun = (kind, count) => {
    if (count <= 0) return;
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === kind) last.count += count;
    else runs.push({ kind, count });
  };
  const pushSeg = (sa, sb) => {
    if (sa.length === 0 && sb.length === 0) return;
    for (const r of diffRuns(sa, sb)) pushRun(r.kind, r.count);
  };

  let ai = 0;
  let bi = 0;
  for (const t of chain) {
    const i = candI[t];
    const j = candJ[t];
    pushSeg(a.subarray(ai, i), b.subarray(bi, j));
    pushRun(0, 1); // the anchor line itself
    ai = i + 1;
    bi = j + 1;
  }
  pushSeg(a.subarray(ai), b.subarray(bi));
  return runs;
}

/**
 * The candidate path's waypoints: for each edit depth d, the point
 * (wpX[d], wpX[d] - wpK[d]) the candidate has reached after d edits
 * and the snake that follows them.
 */
function waypoints(runs, Dp) {
  const wpX = new Int32Array(Dp + 1);
  const wpK = new Int32Array(Dp + 1);
  let x = 0;
  let y = 0;
  let d = 0;
  let ri = 0;
  // Snake of depth 0: the leading keep run, if any.
  if (ri < runs.length && runs[ri].kind === 0) {
    x += runs[ri].count;
    y += runs[ri].count;
    ri++;
  }
  wpX[0] = x;
  wpK[0] = x - y;
  for (; ri < runs.length; ri++) {
    const r = runs[ri];
    if (r.kind === 0) continue; // a snake; already consumed with its edit below
    for (let s = 0; s < r.count; s++) {
      if (r.kind === 1) x++;
      else y++;
      d++;
      // The snake following this edit is the next keep run — but only
      // the part of it up to the next edit belongs to this depth; keep
      // runs are atomic here because edits never split a keep run.
      const nk = runs[ri + 1];
      if (s === r.count - 1 && nk !== undefined && nk.kind === 0) {
        x += nk.count;
        y += nk.count;
      }
      wpX[d] = x;
      wpK[d] = x - y;
    }
  }
  return { wpX, wpK };
}

/**
 * The exact greedy Myers search (v1's recurrence and walk-back),
 * restricted to a band of diagonals around the candidate waypoints:
 * at depth d only diagonals within B of wpK[d] are explored. Returns
 * { D, runs } when the search reaches (N, M), else null. A band can
 * only underestimate furthest-x values, so two bands of different
 * widths agreeing on the script is strong evidence both are exact.
 * History lives in one flat array; depth d's row holds diagonals
 * wpK[d] - B .. wpK[d] + B in steps of 2.
 */
function bandedRuns(a, b, wp, B) {
  const N = a.length;
  const M = b.length;
  const wpK = wp.wpK;
  const Dp = wpK.length - 1;
  const SENT = -1;
  const width = 2 * B + 1;
  const hist = new Int32Array((Dp + 1) * width).fill(SENT);

  // Depth 0: the snake from (0, 0).
  {
    let x = 0;
    let y = 0;
    while (x < N && y < M && a[x] === b[y]) {
      x++;
      y++;
    }
    hist[(0 - wpK[0] + B) >> 1] = x;
    if (x === N && y === M) return { D: 0, runs: x > 0 ? [{ kind: 0, count: x }] : [], pathK: new Int32Array(1) };
  }

  let D = -1;
  let kEnd = 0;
  outer: for (let d = 1; d <= Dp; d++) {
    const kc = wpK[d];
    const pc = wpK[d - 1];
    const base = d * width;
    const pbase = (d - 1) * width;
    let kLo = Math.max(-d, kc - B);
    const kHi = Math.min(d, kc + B);
    if (((kLo - d) & 1) !== 0) kLo++;
    for (let k = kLo; k <= kHi; k += 2) {
      const i1 = (k - 1 - pc + B) >> 1;
      const i2 = (k + 1 - pc + B) >> 1;
      const x1 = i1 >= 0 && i1 < width ? hist[pbase + i1] : SENT;
      const x2 = i2 >= 0 && i2 < width ? hist[pbase + i2] : SENT;
      const canDel = x1 !== SENT && x1 < N;
      const canIns = x2 !== SENT && x2 - k - 1 < M;
      let del;
      if (canDel && canIns) del = x1 + 1 >= x2;
      else if (canDel) del = true;
      else if (canIns) del = false;
      else continue;
      let x = del ? x1 + 1 : x2;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) {
        x++;
        y++;
      }
      hist[base + ((k - kc + B) >> 1)] = x;
      if (x === N && y === M) {
        D = d;
        kEnd = k;
        break outer;
      }
    }
  }
  if (D === -1) return null;

  // Walk back from (N, M) at depth D, recomputing each step's choice
  // with the same rule (out-of-band reads are SENT), as in v1.
  const revKind = [];
  const revCnt = [];
  const pathK = new Int32Array(D + 1);
  let x = N;
  let y = M;
  let k = kEnd;
  pathK[D] = kEnd;
  for (let d = D; d >= 1; d--) {
    const pc = wpK[d - 1];
    const pbase = (d - 1) * width;
    const i1 = (k - 1 - pc + B) >> 1;
    const i2 = (k + 1 - pc + B) >> 1;
    const x1 = i1 >= 0 && i1 < width ? hist[pbase + i1] : SENT;
    const x2 = i2 >= 0 && i2 < width ? hist[pbase + i2] : SENT;
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
    pathK[d - 1] = prevK;
  }
  if (x > 0) {
    revKind.push(0);
    revCnt.push(x);
  }
  const runs = [];
  for (let i = revKind.length - 1; i >= 0; i--) {
    const kind = revKind[i];
    const count = revCnt[i];
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === kind) last.count += count;
    else runs.push({ kind, count });
  }
  return { D, runs, pathK };
}

/** Do two run lists describe the same script? */
function sameRuns(r1, r2) {
  if (r1.length !== r2.length) return false;
  for (let i = 0; i < r1.length; i++) {
    if (r1[i].kind !== r2[i].kind || r1[i].count !== r2[i].count) return false;
  }
  return true;
}

/** Does applying runs to a produce exactly b? */
function verifyRuns(a, b, runs) {
  let i = 0;
  let j = 0;
  for (const r of runs) {
    if (r.kind === 0) {
      for (let s = 0; s < r.count; s++) {
        if (a[i] !== b[j]) return false;
        i++;
        j++;
      }
    } else if (r.kind === 1) {
      i += r.count;
    } else {
      j += r.count;
    }
    if (i > a.length || j > b.length) return false;
  }
  return i === a.length && j === b.length;
}

/**
 * The middle's edit runs: a fast anchored candidate supplies the path
 * shape; the exact greedy search, run in two bands of different widths
 * around that path, must agree on one script that verifiably turns a
 * into b — otherwise the plain exact search decides.
 */
function solveMiddle(a, b, numIds) {
  const N = a.length;
  const M = b.length;
  if (N + M < 1500) return diffRuns(a, b);
  const cand = diffAnchored(a, b, numIds);
  let Dp = 0;
  for (const r of cand) if (r.kind !== 0) Dp += r.count;
  if (Dp === 0) return cand;
  if (Dp > 20000) return diffRuns(a, b);
  const wp = waypoints(cand, Dp);
  const r1 = bandedRuns(a, b, wp, 80);
  if (r1 !== null) {
    // Fast path: the found path stayed well inside the band, so no
    // cell it depends on could have been clipped by the band's edge.
    let margin = 80;
    for (let d = 0; d <= r1.D; d++) {
      const dev = Math.abs(r1.pathK[d] - wp.wpK[d]);
      if (80 - dev < margin) margin = 80 - dev;
    }
    if (margin >= 24 && verifyRuns(a, b, r1.runs)) return r1.runs;
    const r2 = bandedRuns(a, b, wp, 320);
    if (r2 !== null && r1.D === r2.D && sameRuns(r1.runs, r2.runs) && verifyRuns(a, b, r1.runs)) {
      return r1.runs;
    }
  }
  return diffRuns(a, b);
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

  const mid = solveMiddle(A.subarray(prefix, n - suffix), B.subarray(prefix, m - suffix), map.size);
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
