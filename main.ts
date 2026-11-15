// Driver for the markdown-render-speed-02 entry.
//
// The harness runs `node /bot/main.ts` with the case set at /input/cases.json
// (or $MAKEFUN_INPUT_DIR outside a container) and expects the rendered HTML
// at /output/html.json (or $MAKEFUN_OUTPUT_DIR): a JSON array of one HTML
// string per case, in the cases' order. Each case is rendered alone through
// parse() from parse.js, which is the fast renderer in this repository; it
// falls back to the vendored marked for any input it declines.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

interface Case {
  id: string;
  markdown: string;
}

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as Case[];
const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i]!.markdown);
}
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
