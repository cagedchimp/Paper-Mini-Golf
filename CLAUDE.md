# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

A single-page web app that procedurally generates **printable paper mini-golf
courses**. The physical game is a freeform pen-drag / flick activity (put the
marker on the tee, close your eyes, drag until you stop = one stroke) for ages
5+ — there is **no dice, no movement grid, and no stroke solver**. Plain
HTML/CSS/JS served as static files: no build step, no dependencies, no framework.

## Files

- `index.html` — the entire app: styles, controls, the SVG hole renderer, the
  print layouts (roomy one-per-page and compact 4-up), the title and scorecard
  pages, and URL sync. Script is ES5-style vanilla JS (`var`, string-concat
  SVG); match that style. SVG colors are literal hex in the `COL` map because
  `var(--x)` is unreliable inside SVG presentation attributes.
- `minigolf.js` — the pure logic module (`window.PaperMiniGolf` in the browser,
  `module.exports` in Node). Seeded RNG, region carving, wall tracing, hazard /
  baffle placement, and the reachability gate. **All course generation lives
  here**, never in `index.html`, so it stays testable headlessly.
- `test/generator.test.js` — headless checks. Run with:

  ```sh
  node test/generator.test.js
  ```

  No framework — plain `assert()` helpers, exits nonzero on failure.

## Invariants to preserve

- **Determinism**: courses come from a seeded RNG (`xmur3` + `mulberry32`, with
  `rng.fork(tag)` sub-streams). The same seed + hole count must always produce
  the identical course — never call `Math.random()` inside generation logic
  (the UI's random-seed button is the only allowed use).
- **Straight walls, hidden grid**: holes are carved on a hidden coarse cell grid
  (`cols`×`rows`) and their outline is traced along cell edges
  (`traceMask` + `collinearMerge`), so every wall segment is axis-aligned. The
  grid is never drawn. This is the whole point — keep the walls straight and the
  grid invisible. The renderer only *wobbles* wall segments with pinned
  endpoints (`wobbleEdges`) for a hand-drawn look; corners stay crisp.
- **Full-length holes**: `carveRegion` descends from a tee at the top to a cup
  at the bottom with horizontal jogs; tee/cup are pinned to the top-most and
  bottom-most playable cells (`extremePlayable`) so they're always at opposite
  ends. Each hole crops its SVG to a `view` bbox so it fills its card.
- **Playability**: `isReachable` flood-fills tee→cup over playable, non-blocking
  cells. Sand and water are passable (`BLOCKS_PATH`), rocks/trees block;
  blocking hazards that would seal the hole are dropped until it's reachable
  again. This is a sanity gate, not a dice solver.
- **Print-friendly**: light line-art, minimal heavy fills, Letter `@page`. Print
  with margins None + background graphics on. Keep new art light on ink.
- **Browser + Node**: `minigolf.js` must keep working in both.
- **Shareable URLs**: `seed`, `holes`, `layout` live in the query string; keep
  `syncURL()` and the boot restore in sync when adding state.

## Deploy

`.github/workflows/pages.yml` runs the test, then deploys `index.html` and
`minigolf.js` to GitHub Pages (both via the Actions deployment and the
`gh-pages` branch). Live site:
<https://cagedchimp.github.io/Paper-Mini-Golf/>. If you add a new file the site
needs, add it to the workflow's staging steps.
