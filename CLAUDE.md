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
  grid invisible. The renderer keeps the straight segments but rounds every
  corner into an arc (`roundedPath`, radius clamped under half each adjoining
  wall so lanes never pinch) so holes sweep like real mini-golf, and wraps the
  field/hazards/walls in a subtle `feTurbulence` displacement filter for a
  hand-drawn wobble. Tee/cup/flag/labels stay outside the filter to read crisply.
- **Classic lane look**: lanes are a **uniform width** for the whole hole (no
  room bulges or widened tee/cup pads), and their two ends are drawn as true
  **semicircular caps** — `lanePath` renders the tee/cup end edges (found by
  `capEdges` via `hole.laneW` + tee/cup position) as outward-bulging arcs, other
  corners stay `roundedPath`-style. The card field is a soft green **grass**
  background with a soft **clay** lane on top (`COL.grass` / `COL.field`), light
  enough to print. Keep `:root` CSS vars and the `COL` map in sync.
- **Hole shapes**: `carveRegion` dispatches to `buildDescending` (tee at top →
  cup at bottom, several slalom-biased jogs and occasional "room" bulges;
  tee/cup pinned to the top/bottom-most cells via `extremePlayable`) or
  `buildHairpin` (~1/3 of holes on wide grids) — a U with two vertical arms and
  an uncarved divider, so the lane genuinely doubles back on itself. Each hole
  crops its SVG to a `view` bbox so it fills its card. `corridorPath` returns
  the tee→cup BFS path; `protectedCorridor` dilates it; `par` scales with path
  length.
- **Obstacles** all live in `hole.hazards`, each tagged by `type`. Terrain
  blobs (`placeTerrain`): sand, water, rocks, trees, flower-bed `island`, and
  passable `hill` (carries a `dir` for the downhill arrow). Solid obstacles:
  `bar` (bumper wall slalom, `placeBars`), `post` (rounded-square pillar,
  `placePosts`), and `gate` (a windmill/tunnel — an internal wall across the
  lane at a straight vertical point on the path with a single gap, `placeGate`,
  placed first). A shared `avoid` mask keeps everything from overlapping or
  crowding the tee/cup. Render posts/bars/gates as distinct shapes — never a
  ringed circle (reads as the tee) or a plain dark disc (reads as the cup).
- **Playability**: `isReachable` flood-fills tee→cup over playable, non-blocking
  cells. Sand, water and hills are passable (`BLOCKS_PATH`); rocks, trees,
  island, posts, bars and gates block (a gate's gap sits on the path). The
  generator drops the last-placed *blocking* obstacle until the cup is
  reachable again. This is a sanity gate, not a dice solver.
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
