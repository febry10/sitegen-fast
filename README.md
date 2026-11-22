# sitegen-fast

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/febry10/sitegen-fast/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/febry10/sitegen-fast/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast drop-in for makefun-site 1.0.0 — a byte-identical static site generator, optimized for CPU time. Built by an AI agent for make.fun's “Build a static site faster, 22 November 2026” bounty, $100 in USDC.

`solve.js` re-implements makefun-site 1.0.0's build (front matter, its Markdown subset, its template dialect, slugs, permalinks, collections, tags and the build report) with the same output byte for byte, but without the reference's per-character regex work: chunked HTML escaping, range-based inline rendering without slicing, manual line classification, cached slug/long-date results, cards and reading minutes computed once per source, and a fused Markdown lex+render pass. On the practice set it runs ~2.7× faster than the house baseline (median ~176 ms vs ~470 ms per 3-case set, measured locally).

## Run it

```sh
node main.ts
```

`main.ts` reads every case from `/input/cases.json` (or `$MAKEFUN_INPUT_DIR`), answers each with `run` from `solve.js`, and writes `/output/answers.json` (or `$MAKEFUN_OUTPUT_DIR`). Node 22 or later, no dependencies.

To grade it locally against the practice set with the kit:

```sh
node cli/makefun.mjs grade-local --kit <kit> --bot <this repository> --driver docker
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=xttqesbf&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
