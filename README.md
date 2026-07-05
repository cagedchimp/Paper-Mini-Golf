# ⛳ Paper Mini Golf

Generate a **printable paper mini-golf course**, then play it with a marker:
put your pen tip on **START**, close your eyes, and drag until you stop —
that's one stroke. Start the next stroke where the last one ended, keep going
until you reach the flag, and count your strokes. Fewest wins!

Based on the *Paper Mini Golf* activity (inspired by Paper Golf from
[playmeo.com](https://www.playmeo.com/)) — a drawing-and-putting game for ages
5+.

## Use it

**Open it here: <https://cagedchimp.github.io/Paper-Mini-Golf/>**
(deployed automatically by GitHub Actions on every push)

Or just open `index.html` in any browser — no build step, no server, no
dependencies.

- **Seed** — every course is procedurally generated from a seed. The same seed
  always makes the same course, and the seed, hole count and layout live in the
  URL, so you can share a link and print the same track.
- **🎲 New course** — roll up a fresh random course.
- **Holes** — 3 to 9.
- **Layout**
  - **Roomy** — one big hole per page, best for younger kids with a marker.
  - **Compact** — four holes per page with cut guides, to save paper.
- **🖨 Print** — print with margins set to **None** and **Background graphics**
  **on**. A course prints as a title / how-to-play page → the holes → a
  scorecard.

Each hole is an enclosed, straight-walled mini-golf shape (doglegs, zig-zags
and straights) with a tee, a flagged cup at the far end, and hazards to steer
around — sand pits, water, rocks, trees, and the odd wall bump. The look is
hand-drawn but the walls are straight, like a real mini-golf hole.

## How to play

1. Put your marker tip on the **START** dot of hole 1.
2. **Close your eyes** and drag the marker until you decide to stop — 1 stroke.
3. Start your next stroke where the last one ended. Keep going until you reach
   the flag.
4. Write your strokes for each hole on the scorecard. **Fewest strokes wins!**
5. Try to stay inside the walls and go around the hazards.

**Variations:** *Pen flicker* — eyes open, flick the marker to move.
*Take turns* — two players, two colours, lowest total wins.

## Files

- `index.html` — the whole app: controls, SVG rendering, print layouts, scorecard
- `minigolf.js` — pure course generator: seeded RNG, region carving, straight-wall
  tracing, hazards, and a reachability check (runs in the browser and in Node)
- `test/generator.test.js` — headless checks: determinism, tee→cup connectivity,
  and closed rectilinear walls over many seeds

Run the generator checks:

```sh
node test/generator.test.js
```

## Guaranteed playable

Every hole is carved so the tee and cup sit at opposite ends, and a flood-fill
check confirms the cup stays reachable from the tee (blocking hazards that would
seal it are dropped). It's a freeform pen game, so there's no dice or stroke
solver — just a hole that always has a way through.

*Not affiliated with playmeo — go check out their activity library.*
