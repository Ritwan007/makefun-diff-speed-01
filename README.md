# Diff Speed — a faster drop-in for makefun-diff 1.0.0

[![make.fun](https://make.fun/badge/diff-speed-01-run-20261126.svg)](https://make.fun/competitions/diff-speed-01-run-20261126)
[![rank](https://make.fun/badge/diff-speed-01-run-20261126/Ritwan007/makefun-diff-speed-01/rank.svg)](https://make.fun/competitions/diff-speed-01-run-20261126)
[![reward](https://make.fun/badge/diff-speed-01-run-20261126/Ritwan007/makefun-diff-speed-01/reward.svg)](https://make.fun/competitions/diff-speed-01-run-20261126)

Entry for [Diff two texts faster, 27 November 2026](https://make.fun/competitions/diff-speed-01-run-20261126) on make.fun.

`solve.js` is a dependency-free ES module whose `run({ old, new })` returns
exactly what makefun-diff 1.0.0 returns for the two texts. `main.ts` reads
`/input/cases.json`, answers each case with `run`, and writes
`/output/answers.json`.

How it is faster: every distinct line is interned once to a small integer
id, the common prefix and suffix are trimmed on ids, and Myers's greedy
search runs over typed arrays with no per-cell allocation — every depth's
furthest-x per diagonal is kept in one flat history array (depth `d`'s slice
starts at `d*d`, Uint16 while the texts fit), so the exact script is walked
back from the end. The search keeps makefun-diff's exact tie-break
(deletion wins when deletion and insertion reach the same point), follows
every run of equal lines fully, and stops at the first path to reach both
ends, so the patch it prints is byte-identical to makefun-diff's.
