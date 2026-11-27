// Driver the harness runs as `node /bot/main.ts` (node22): reads every case
// from /input/cases.json, answers them all with runAll() from solve.js
// (which diffs in WebAssembly and emits answers.json directly), and writes
// /output/answers.json. Outside a container MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of
// its work runs under it (the rules allow an entry to tune V8's flags).
setFlagsFromString('--no-incremental-marking');

/** solve.js, imported by its URL (a .js module carries no types). */
const { runAll } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  runAll: (fileBytes: unknown) => Uint8Array;
};

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const casesFile = readFileSync(join(INPUT_DIR, 'cases.json'));
const answers = runAll(casesFile);
mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(join(OUTPUT_DIR, 'answers.json'), answers);
