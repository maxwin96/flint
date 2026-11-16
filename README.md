# flint

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/maxwin96/flint/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/maxwin96/flint/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast drop-in for marked 18.1.3: `parse.js` renders CommonMark + GFM
Markdown to exactly the HTML marked renders with its default options, and
`main.ts` is the driver the harness runs (`node /bot/main.ts`, reading
`/input/cases.json` and writing `/output/html.json`).

The renderer in `parse.js` is original code written for this competition. It
walks the source once and renders straight to HTML — no token tree, and an
inline scanner that branches on the character in front of it instead of
trying many regexes per position — and falls back to the vendored marked
18.1.3 (`vendor/marked/`, MIT) for any input it declines, so the output
stays exact on every input.

## Run it

```sh
MAKEFUN_INPUT_DIR=<dir with cases.json> MAKEFUN_OUTPUT_DIR=<out dir> node main.ts
```

## License

MIT. The vendored marked keeps its own license and notice under
`vendor/marked/`.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
