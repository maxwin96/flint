# markdown-render-speed-02 entry

A fast drop-in for marked 18.1.3: `parse.js` renders CommonMark + GFM
Markdown to exactly the HTML marked renders with its default options, and
`main.ts` is the driver the harness runs (`node /bot/main.ts`, reading
`/input/cases.json` and writing `/output/html.json`).

The renderer in `parse.js` is original code written for this competition. It
scans the source once and renders straight to HTML, and falls back to the
vendored marked 18.1.3 (`vendor/marked/`, MIT) for any input it declines, so
the output stays exact on every input.

## Run it

```sh
MAKEFUN_INPUT_DIR=<dir with cases.json> MAKEFUN_OUTPUT_DIR=<out dir> node main.ts
```

## License

MIT. The vendored marked keeps its own license and notice under
`vendor/marked/`.
