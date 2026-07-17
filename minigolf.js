/*
 * Paper Mini Golf — course generator
 *
 * Procedurally generates printable "Paper Mini Golf" holes: enclosed,
 * STRAIGHT-WALLED rectilinear course shapes (rectangles, L / U / dogleg /
 * zig-zag silhouettes) with a tee, a cup + flag, and internal hazards.
 * The physical game is a freeform pen-drag / flick activity (see the
 * paper_mini_golf_activity.pdf) — there is NO dice, NO movement grid, and
 * NO stroke solver. So this module has just enough logic to lay out a
 * good-looking, obviously-playable hole and prove it stays connected.
 *
 * Design notes:
 *  - Two coordinate spaces. Generation happens on a HIDDEN coarse cell grid
 *    (cols x rows). The grid is never drawn; walls are traced along cell
 *    edges, so every wall segment is axis-aligned (perfectly straight).
 *    Everything the renderer needs is emitted in WORLD units.
 *  - Determinism. The same seed always produces the same course. All random
 *    draws come from a seeded RNG (xmur3 + mulberry32), with labelled
 *    sub-streams via rng.fork(tag) so changing hazard logic later doesn't
 *    shift the silhouette for a given seed.
 *
 * Pure module: works in the browser (window.PaperMiniGolf) and Node
 * (module.exports) so it can be tested headlessly.
 */
(function (global) {
  'use strict';

  var CELL = 46;          // world units per grid cell
  var MARGIN = 34;        // world padding around the grid

  // Hazards / obstacles that stop the ball (block the reachability check).
  // Sand and water are passable — you just drag across them, they only
  // flavor / score. Rocks, trees, posts, bumper bars and islands are solid.
  var BLOCKS_PATH = {
    sand: false, water: false, hill: false,
    rocks: true, trees: true, island: true, post: true, bar: true, gate: true
  };

  /* ------------------------------------------------------------------ *
   * Seeded RNG (xmur3 + mulberry32) — same as the reference app        *
   * ------------------------------------------------------------------ */

  function xmur3(str) {
    var h = 1779033703 ^ str.length;
    for (var i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function () {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return (h ^= h >>> 16) >>> 0;
    };
  }

  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // A small RNG object: float next(), inclusive int(a,b), pick, chance, and
  // fork(tag) for an independent labelled sub-stream.
  function makeRng(seedStr) {
    seedStr = String(seedStr);
    var next = mulberry32(xmur3(seedStr)());
    return {
      seed: seedStr,
      next: next,
      int: function (a, b) { return a + Math.floor(next() * (b - a + 1)); },
      pick: function (arr) { return arr[Math.floor(next() * arr.length)]; },
      chance: function (p) { return next() < p; },
      fork: function (tag) { return makeRng(seedStr + ':' + tag); }
    };
  }

  /* ------------------------------------------------------------------ *
   * Grid helpers                                                        *
   * ------------------------------------------------------------------ */

  function makeGrid(cols, rows) { return new Uint8Array(cols * rows); }
  function gi(cols, c, r) { return r * cols + c; }
  function inGrid(cols, rows, c, r) { return c >= 0 && c < cols && r >= 0 && r < rows; }

  function getCell(g, cols, rows, c, r) {
    return inGrid(cols, rows, c, r) ? g[gi(cols, c, r)] : 0;
  }

  // Carve an axis-aligned block of cells (clamped to the grid) to playable.
  function carveRect(g, cols, rows, x0, y0, x1, y1) {
    var a = Math.max(0, Math.min(x0, x1)), b = Math.min(cols - 1, Math.max(x0, x1));
    var c = Math.max(0, Math.min(y0, y1)), d = Math.min(rows - 1, Math.max(y0, y1));
    for (var r = c; r <= d; r++) {
      for (var x = a; x <= b; x++) g[gi(cols, x, r)] = 1;
    }
  }

  var N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  // Keep only the largest 4-connected component, then fill any fully
  // enclosed 1+ cell interior holes so the region is simply connected
  // (a single clean wall loop, no islands).
  function normalizeRegion(g, cols, rows) {
    var seen = new Uint8Array(cols * rows);
    var best = null, bestLen = 0;
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var id = gi(cols, c, r);
        if (!g[id] || seen[id]) continue;
        var stack = [[c, r]], comp = [];
        seen[id] = 1;
        while (stack.length) {
          var p = stack.pop(); comp.push(p);
          for (var k = 0; k < 4; k++) {
            var nc = p[0] + N4[k][0], nr = p[1] + N4[k][1];
            if (!inGrid(cols, rows, nc, nr)) continue;
            var nid = gi(cols, nc, nr);
            if (g[nid] && !seen[nid]) { seen[nid] = 1; stack.push([nc, nr]); }
          }
        }
        if (comp.length > bestLen) { bestLen = comp.length; best = comp; }
      }
    }
    var out = makeGrid(cols, rows);
    if (best) for (var i = 0; i < best.length; i++) out[gi(cols, best[i][0], best[i][1])] = 1;

    // Fill holes: flood the OUTSIDE from the border through empty cells;
    // any empty cell not reached is an interior hole -> carve it.
    var outside = new Uint8Array(cols * rows);
    var q = [];
    for (var x = 0; x < cols; x++) {
      pushOutside(out, outside, q, cols, rows, x, 0);
      pushOutside(out, outside, q, cols, rows, x, rows - 1);
    }
    for (var y = 0; y < rows; y++) {
      pushOutside(out, outside, q, cols, rows, 0, y);
      pushOutside(out, outside, q, cols, rows, cols - 1, y);
    }
    while (q.length) {
      var cur = q.pop();
      for (var m = 0; m < 4; m++) {
        var ac = cur[0] + N4[m][0], ar = cur[1] + N4[m][1];
        pushOutside(out, outside, q, cols, rows, ac, ar);
      }
    }
    for (var rr = 0; rr < rows; rr++) {
      for (var cc = 0; cc < cols; cc++) {
        var gid = gi(cols, cc, rr);
        if (!out[gid] && !outside[gid]) out[gid] = 1; // enclosed hole -> fill
      }
    }
    return out;
  }

  function pushOutside(region, outside, q, cols, rows, c, r) {
    if (!inGrid(cols, rows, c, r)) return;
    var id = gi(cols, c, r);
    if (region[id] || outside[id]) return;
    outside[id] = 1; q.push([c, r]);
  }

  /* ------------------------------------------------------------------ *
   * Region carving — a thick rectilinear corridor from tee to cup      *
   * ------------------------------------------------------------------ */

  // Carve a corridor that descends from a tee at the TOP to a cup at the
  // BOTTOM, taking a few horizontal jogs on the way. Legs only run along an
  // axis and turn 90°, so the thickened union is a rectilinear region whose
  // silhouette reads as straight / dogleg / zig-zag depending on the jogs.
  // The full-traversal shape (top -> bottom) keeps tee and cup far apart.
  // Returns { grid, tee, cup }.
  //
  // Dispatcher: most holes descend top->bottom; some are hairpins that fold
  // back on themselves (down one arm, around the bottom, back up the other).
  function carveRegion(rng, cols, rows) {
    if (cols >= 9 && rng.chance(0.34)) return buildHairpin(rng, cols, rows);
    return buildDescending(rng, cols, rows);
  }

  // A U-shaped hole: two vertical arms joined at the bottom, with an uncarved
  // divider between them so the lane genuinely doubles back on itself.
  function buildHairpin(rng, cols, rows) {
    var g = makeGrid(cols, rows);
    var lane = 1;
    var pad = lane;
    var bottom = rows - 1 - pad;
    var gap = 2 * lane + 2;               // keeps >=1 uncarved divider column
    var leftX = rng.int(pad + 1, Math.max(pad + 1, ((cols / 2) | 0) - 1));
    var rightX = clampi(leftX + gap + rng.int(0, 1), leftX + gap, cols - 1 - pad);
    if (rightX - leftX < gap) return buildDescending(rng, cols, rows);
    // right arm sometimes stops short so the cup sits partway up
    var rightTop = rng.chance(0.5) ? pad : clampi(pad + rng.int(2, 4), pad, bottom - 2);

    thicken(g, cols, rows, leftX, pad, leftX, bottom, lane);       // left arm, full
    thicken(g, cols, rows, leftX, bottom, rightX, bottom, lane);   // bottom connector
    thicken(g, cols, rows, rightX, rightTop, rightX, bottom, lane); // right arm, up to cup

    carveRect(g, cols, rows, leftX - lane, pad - lane, leftX + lane, pad + lane);
    carveRect(g, cols, rows, rightX - lane, rightTop - lane, rightX + lane, rightTop + lane);

    g = normalizeRegion(g, cols, rows);
    var tee = nearestPlayable(g, cols, rows, leftX, pad);
    var cup = nearestPlayable(g, cols, rows, rightX, rightTop);
    return { grid: g, tee: tee, cup: cup, lane: lane };
  }

  function buildDescending(rng, cols, rows) {
    var g = makeGrid(cols, rows);
    var lane = rng.pick([1, 1, 1, 2]);   // half-width: 1 -> 3 cells, 2 -> 5 cells
    var pad = lane;
    var minX = pad, maxX = cols - 1 - pad;
    if (maxX < minX) { minX = maxX = (cols - 1) >> 1; }
    var bottom = rows - 1 - pad;

    var x = rng.int(minX, maxX);
    var tee = [x, pad];
    // More doglegs -> longer, more zig-zagging holes. Capped by how many
    // descents fit in the available height.
    var maxByHeight = Math.max(2, Math.floor((bottom - pad) / 2) - 1);
    var jogs = Math.min(rng.int(3, 6), maxByHeight);
    var segTop = pad;
    var lastDir = rng.pick([-1, 1]);

    for (var j = 0; j <= jogs; j++) {
      var remaining = jogs - j;                              // descents still to come
      var room = bottom - segTop;
      var yTarget = (j === jogs) ? bottom
        : Math.min(bottom - remaining, segTop + rng.int(2, 3));
      if (yTarget <= segTop) yTarget = Math.min(bottom, segTop + 1);
      thicken(g, cols, rows, x, segTop, x, yTarget, lane);   // descend
      segTop = yTarget;
      if (j < jogs) {                                        // then jog sideways
        // sweep across, biased to alternate sides for a real slalom
        var dir = (x <= minX) ? 1 : (x >= maxX ? -1
          : (rng.chance(0.7) ? -lastDir : rng.pick([-1, 1])));
        lastDir = dir;
        var nx = clampi(x + dir * rng.int(2, 4), minX, maxX);
        if (nx === x) nx = clampi(x - dir * rng.int(2, 4), minX, maxX);
        thicken(g, cols, rows, x, segTop, nx, segTop, lane);
        x = nx;
      }
    }
    var cup = [x, bottom];

    // Uniform lane, classic style: no widened pads or room bulges.
    g = normalizeRegion(g, cols, rows);

    // Pin the tee to the very top of the carved region and the cup to the
    // very bottom, biased toward their corridor columns — so they always sit
    // at the extremes (a full-length hole).
    tee = extremePlayable(g, cols, rows, tee[0], true);
    cup = extremePlayable(g, cols, rows, cup[0], false);
    return { grid: g, tee: tee, cup: cup, lane: lane };
  }

  function clampi(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // The top-most (top=true) or bottom-most playable cell, tie-broken by
  // closeness to column `x`.
  function extremePlayable(g, cols, rows, x, top) {
    var best = null;
    for (var r = 0; r < rows; r++) {
      var rr = top ? r : rows - 1 - r;
      var found = false;
      for (var c = 0; c < cols; c++) {
        if (g[gi(cols, c, rr)]) {
          if (best === null || Math.abs(c - x) < Math.abs(best[0] - x)) best = [c, rr];
          found = true;
        }
      }
      if (found) break; // first row with any playable cell = the extreme row
    }
    return best || [x, top ? 0 : rows - 1];
  }

  // Carve a lane of half-width `hw` along an axis-aligned segment.
  function thicken(g, cols, rows, x0, y0, x1, y1, hw) {
    if (x0 === x1) carveRect(g, cols, rows, x0 - hw, y0, x1 + hw, y1);
    else carveRect(g, cols, rows, x0, y0 - hw, x1, y1 + hw);
  }

  /* ------------------------------------------------------------------ *
   * Wall tracing — cell-edge boundary -> straight rectilinear polygon  *
   * ------------------------------------------------------------------ */

  // Trace the outline of a mask as a closed loop of grid-corner points,
  // collinear-merged so each straight wall is a single segment. Corners are
  // in cell units (a cell (c,r) spans corners (c,r)..(c+1,r+1)).
  function traceMask(mask, cols, rows) {
    // Directed boundary edges, walking each playable cell clockwise
    // (y down). Interior edges cancel; the outer boundary chains into one
    // clockwise loop, so map[startCorner] = endCorner is unambiguous.
    var map = {};
    function key(x, y) { return x + ',' + y; }
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        if (!mask[gi(cols, c, r)]) continue;
        if (!getMaskCell(mask, cols, rows, c, r - 1)) map[key(c, r)] = [c + 1, r];       // top  ->
        if (!getMaskCell(mask, cols, rows, c + 1, r)) map[key(c + 1, r)] = [c + 1, r + 1]; // right v
        if (!getMaskCell(mask, cols, rows, c, r + 1)) map[key(c + 1, r + 1)] = [c, r + 1]; // bot  <-
        if (!getMaskCell(mask, cols, rows, c - 1, r)) map[key(c, r + 1)] = [c, r];         // left ^
      }
    }
    var startKey = null;
    for (var kk in map) { if (map.hasOwnProperty(kk)) { startKey = kk; break; } }
    if (!startKey) return [];

    var startPt = startKey.split(',').map(Number);
    var loop = [startPt];
    var cur = startPt, guard = 0, limit = cols * rows * 4 + 8;
    while (guard++ < limit) {
      var nxt = map[key(cur[0], cur[1])];
      if (!nxt) break;
      if (nxt[0] === startPt[0] && nxt[1] === startPt[1]) break;
      loop.push(nxt);
      cur = nxt;
    }
    return collinearMerge(loop);
  }

  function getMaskCell(mask, cols, rows, c, r) {
    return inGrid(cols, rows, c, r) ? mask[gi(cols, c, r)] : 0;
  }

  // Drop vertices that lie on a straight line between their neighbors.
  function collinearMerge(pts) {
    var n = pts.length;
    if (n < 3) return pts.slice();
    var out = [];
    for (var i = 0; i < n; i++) {
      var a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
      var collinear = (a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1]);
      if (!collinear) out.push(b);
    }
    return out;
  }

  function cornerToWorld(pt) {
    return { x: MARGIN + pt[0] * CELL, y: MARGIN + pt[1] * CELL };
  }
  function cellCenter(c, r) {
    return { x: MARGIN + (c + 0.5) * CELL, y: MARGIN + (r + 0.5) * CELL };
  }

  /* ------------------------------------------------------------------ *
   * Reachability gate (sanity check, not a solver)                     *
   * ------------------------------------------------------------------ */

  // Flood fill from tee over playable cells minus any blocking hazard
  // cells; returns whether the cup is reached.
  function isReachable(grid, cols, rows, tee, cup, blocked) {
    var seen = new Uint8Array(cols * rows);
    function isBlocked(c, r) { return blocked && blocked[gi(cols, c, r)]; }
    if (!getCell(grid, cols, rows, tee[0], tee[1]) || isBlocked(tee[0], tee[1])) return false;
    var stack = [tee]; seen[gi(cols, tee[0], tee[1])] = 1;
    while (stack.length) {
      var p = stack.pop();
      if (p[0] === cup[0] && p[1] === cup[1]) return true;
      for (var k = 0; k < 4; k++) {
        var nc = p[0] + N4[k][0], nr = p[1] + N4[k][1];
        if (!inGrid(cols, rows, nc, nr)) continue;
        var id = gi(cols, nc, nr);
        if (seen[id] || !grid[id] || isBlocked(nc, nr)) continue;
        seen[id] = 1; stack.push([nc, nr]);
      }
    }
    return false;
  }

  // BFS parent-trace tee->cup; returns the path as an ordered list of cells
  // (tee first, cup last), or [] if the cup is unreachable.
  function corridorPath(grid, cols, rows, tee, cup) {
    var prev = new Int32Array(cols * rows); for (var i = 0; i < prev.length; i++) prev[i] = -2;
    var q = [tee]; prev[gi(cols, tee[0], tee[1])] = -1; var head = 0;
    while (head < q.length) {
      var p = q[head++];
      if (p[0] === cup[0] && p[1] === cup[1]) break;
      for (var k = 0; k < 4; k++) {
        var nc = p[0] + N4[k][0], nr = p[1] + N4[k][1];
        if (!inGrid(cols, rows, nc, nr)) continue;
        var id = gi(cols, nc, nr);
        if (prev[id] !== -2 || !grid[id]) continue;
        prev[id] = gi(cols, p[0], p[1]); q.push([nc, nr]);
      }
    }
    if (prev[gi(cols, cup[0], cup[1])] === -2) return [];
    var path = [];
    var walk = gi(cols, cup[0], cup[1]);
    while (walk >= 0) {
      var wc = walk % cols, wr = (walk - wc) / cols;
      path.push([wc, wr]);
      walk = prev[walk];
    }
    path.reverse();
    return path;
  }

  // The corridor path dilated by 1 -> the protected corridor that blocking
  // obstacles must never seal.
  function protectedCorridor(grid, cols, rows, path) {
    var prot = new Uint8Array(cols * rows);
    for (var i = 0; i < path.length; i++) {
      var wc = path[i][0], wr = path[i][1];
      for (var dr = -1; dr <= 1; dr++) {
        for (var dc = -1; dc <= 1; dc++) {
          if (inGrid(cols, rows, wc + dc, wr + dr)) prot[gi(cols, wc + dc, wr + dr)] = 1;
        }
      }
    }
    return prot;
  }

  function nearestPlayable(g, cols, rows, c, r) {
    if (getCell(g, cols, rows, c, r)) return [c, r];
    for (var rad = 1; rad < Math.max(cols, rows); rad++) {
      for (var dr = -rad; dr <= rad; dr++) {
        for (var dc = -rad; dc <= rad; dc++) {
          if (getCell(g, cols, rows, c + dc, r + dr)) return [c + dc, r + dr];
        }
      }
    }
    return [c, r];
  }

  /* ------------------------------------------------------------------ *
   * Hazards + baffles                                                   *
   * ------------------------------------------------------------------ */

  var HAZARD_TYPES = ['sand', 'sand', 'water', 'water', 'rocks', 'trees', 'trees', 'island', 'hill', 'hill'];

  // Grow a small orthogonal blob of playable cells around a seed, staying
  // off the tee, the cup and the protected corridor.
  function growBlob(rng, grid, cols, rows, prot, avoid, size) {
    var starts = [];
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var id = gi(cols, c, r);
        if (grid[id] && !prot[id] && !avoid[id]) starts.push([c, r]);
      }
    }
    if (!starts.length) return [];
    var s = starts[rng.int(0, starts.length - 1)];
    var blob = [s], used = {}; used[s[0] + ',' + s[1]] = 1;
    var frontier = [s];
    var tries = 0, maxTries = size * 12 + 24; // bounded: a blob may be boxed in
    while (blob.length < size && frontier.length && tries++ < maxTries) {
      var f = frontier[rng.int(0, frontier.length - 1)];
      var dir = N4[rng.int(0, 3)];
      var nc = f[0] + dir[0], nr = f[1] + dir[1], kk = nc + ',' + nr;
      if (!inGrid(cols, rows, nc, nr) || used[kk]) continue;
      var nid = gi(cols, nc, nr);
      if (!grid[nid] || prot[nid] || avoid[nid]) continue;
      used[kk] = 1; blob.push([nc, nr]); frontier.push([nc, nr]);
    }
    return blob;
  }

  // Terrain hazards: sand / water / rocks / trees / flower-bed islands, grown
  // as blobs. Pushes into `out` and reserves their cells in `avoid`.
  function placeTerrain(rng, grid, cols, rows, avoid, prot, out, count) {
    for (var h = 0; h < count; h++) {
      var type = rng.pick(HAZARD_TYPES);
      var size = (type === 'water' || type === 'island') ? rng.int(3, 6) : rng.int(1, 3);
      var blob = growBlob(rng, grid, cols, rows, prot, avoid, size);
      if (!blob.length) continue;
      var mask = makeGrid(cols, rows);
      for (var b = 0; b < blob.length; b++) {
        var id = gi(cols, blob[b][0], blob[b][1]);
        mask[id] = 1; avoid[id] = 1;
        markRing(avoid, cols, rows, blob[b], 0);
      }
      var haz = {
        type: type,
        cells: blob,
        outline: traceMask(mask, cols, rows).map(cornerToWorld)
      };
      if (type === 'hill') haz.dir = rng.pick(N4);   // downhill direction
      out.push(haz);
    }
  }

  function markRing(avoid, cols, rows, cell, extra) {
    var rad = 1 + extra;
    for (var dr = -rad; dr <= rad; dr++) {
      for (var dc = -rad; dc <= rad; dc++) {
        if (inGrid(cols, rows, cell[0] + dc, cell[1] + dr)) {
          avoid[gi(cols, cell[0] + dc, cell[1] + dr)] = 1;
        }
      }
    }
  }

  // Bumper bars: thick rounded wall stubs that reach in from the outer wall
  // to make a slalom, alternating sides down the hole. They cover the cells
  // they span (so the reachability gate keeps a gap open) and carry a world
  // segment + width for the renderer.
  function placeBars(rng, grid, cols, rows, tee, cup, prot, avoid, out) {
    var candidates = [];
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var id = gi(cols, c, r);
        if (!grid[id] || prot[id] || avoid[id]) continue;
        if (near(c, r, tee, 1) || near(c, r, cup, 1)) continue;
        for (var k = 0; k < 4; k++) {                 // only orthogonal (side) walls
          if (k > 1) break;                           // k 0,1 = left/right neighbours
          var oc = c + (k === 0 ? -1 : 1), or_ = r;
          if (!getCell(grid, cols, rows, oc, or_)) { candidates.push([c, r, (k === 0 ? -1 : 1)]); break; }
        }
      }
    }
    candidates.sort(function (a, b) { return a[1] - b[1]; });   // top -> bottom
    var want = rng.int(2, 4);
    var placed = 0, lastY = -99;
    for (var i = 0; i < candidates.length && placed < want; i++) {
      var cand = candidates[i];
      var cx = cand[0], cy = cand[1], side = cand[2];   // side = -1 wall on left, +1 wall on right
      if (cy - lastY < 2) continue;                     // space them out vertically
      var inward = -side;                               // reach into the lane
      var cells = [[cx, cy]];
      var reach = rng.int(1, 2);
      var nx = cx;
      for (var s = 1; s <= reach; s++) {
        var tx = cx + inward * s;
        if (!getCell(grid, cols, rows, tx, cy) || prot[gi(cols, tx, cy)]) break;
        cells.push([tx, cy]); nx = tx;
      }
      lastY = cy;
      placed++;
      for (var m = 0; m < cells.length; m++) { avoid[gi(cols, cells[m][0], cells[m][1])] = 1; }
      var outerX = cx + 0.5 + side * 0.5;               // touch the wall
      var innerX = nx + 0.5 - inward * 0.15;
      out.push({
        type: 'bar',
        cells: cells,
        seg: [
          { x: MARGIN + outerX * CELL, y: MARGIN + (cy + 0.5) * CELL },
          { x: MARGIN + innerX * CELL, y: MARGIN + (cy + 0.5) * CELL }
        ],
        width: CELL * 0.4
      });
    }
  }

  // Posts / pillars: single circular bumpers standing in open space.
  function placePosts(rng, grid, cols, rows, tee, cup, prot, avoid, out) {
    var spots = [];
    for (var r = 1; r < rows - 1; r++) {
      for (var c = 1; c < cols - 1; c++) {
        var id = gi(cols, c, r);
        if (!grid[id] || prot[id] || avoid[id]) continue;
        if (near(c, r, tee, 1) || near(c, r, cup, 1)) continue;
        // interior: all four neighbours playable, so it reads as a pillar
        if (getCell(grid, cols, rows, c - 1, r) && getCell(grid, cols, rows, c + 1, r) &&
            getCell(grid, cols, rows, c, r - 1) && getCell(grid, cols, rows, c, r + 1)) {
          spots.push([c, r]);
        }
      }
    }
    var want = rng.int(1, 3);
    for (var i = 0; i < want && spots.length; i++) {
      var p = spots.splice(rng.int(0, spots.length - 1), 1)[0];
      if (avoid[gi(cols, p[0], p[1])]) continue;
      avoid[gi(cols, p[0], p[1])] = 1;
      markRing(avoid, cols, rows, p, 0);
      out.push({ type: 'post', cells: [p], pos: cellCenter(p[0], p[1]), r: CELL * 0.28 });
    }
  }

  function near(c, r, cell, rad) {
    return Math.abs(c - cell[0]) <= rad && Math.abs(r - cell[1]) <= rad;
  }

  // A classic gate obstacle — a windmill or a tunnel: an internal wall across
  // the lane at a straight vertical point on the path, with a single gap to
  // aim through. Blocks the crossed cells except the gap; the path threads
  // the gap so the hole stays playable.
  function placeGate(rng, grid, cols, rows, path, avoid, out) {
    if (path.length < 6) return;
    var cands = [];
    for (var i = 2; i < path.length - 2; i++) {
      var a = path[i - 1], b = path[i], c = path[i + 1];
      if (a[0] === b[0] && b[0] === c[0]) cands.push(b);   // vertical straight run
    }
    if (!cands.length) return;
    var g0 = cands[rng.int(0, cands.length - 1)];
    var gc = g0[0], gr = g0[1];
    if (avoid[gi(cols, gc, gr)]) return;

    var cl = gc, cr = gc;
    while (getCell(grid, cols, rows, cl - 1, gr)) cl--;
    while (getCell(grid, cols, rows, cr + 1, gr)) cr++;
    if (cr - cl < 1) return;                                // nothing to wall off

    var cells = [];
    for (var x = cl; x <= cr; x++) {
      if (x === gc) continue;
      if (avoid[gi(cols, x, gr)]) return;                  // don't build over other stuff
      cells.push([x, gr]);
    }
    if (!cells.length) return;
    for (var m = 0; m < cells.length; m++) avoid[gi(cols, cells[m][0], cells[m][1])] = 1;
    avoid[gi(cols, gc, gr)] = 1;

    var y = MARGIN + (gr + 0.5) * CELL;
    var walls = [];
    if (gc > cl) walls.push([{ x: MARGIN + cl * CELL, y: y }, { x: MARGIN + gc * CELL, y: y }]);
    if (gc < cr) walls.push([{ x: MARGIN + (gc + 1) * CELL, y: y }, { x: MARGIN + (cr + 1) * CELL, y: y }]);
    out.push({
      type: 'gate',
      variant: rng.chance(0.5) ? 'windmill' : 'tunnel',
      cells: cells,
      walls: walls,
      gap: { x: MARGIN + (gc + 0.5) * CELL, y: y, w: CELL }
    });
  }

  /* ------------------------------------------------------------------ *
   * Hole + course assembly                                              *
   * ------------------------------------------------------------------ */

  function blockedMask(grid, cols, rows, hazards) {
    var blocked = new Uint8Array(cols * rows);
    for (var i = 0; i < hazards.length; i++) {
      if (!BLOCKS_PATH[hazards[i].type]) continue;
      var cells = hazards[i].cells;
      for (var j = 0; j < cells.length; j++) blocked[gi(cols, cells[j][0], cells[j][1])] = 1;
    }
    return blocked;
  }

  function generateHole(seed, index) {
    var rng = makeRng(seed + '#' + index);
    var cols = rng.pick([8, 9, 9, 10]);
    var rows = rng.pick([11, 12, 13, 14]);

    var region = carveRegion(rng, cols, rows);
    var grid = region.grid, tee = region.tee, cup = region.cup;

    var path = corridorPath(grid, cols, rows, tee, cup);
    var prot = protectedCorridor(grid, cols, rows, path);

    // Shared reservation mask so hazards and obstacles never overlap or
    // crowd the tee / cup.
    var avoid = new Uint8Array(cols * rows);
    markRing(avoid, cols, rows, tee, 1);
    markRing(avoid, cols, rows, cup, 1);

    var hazards = [];
    // A classic windmill / tunnel gate on some holes (placed first so its
    // wall isn't drawn over other features).
    if (rng.chance(0.55)) placeGate(rng.fork('gate'), grid, cols, rows, path, avoid, hazards);

    var area = 0;
    for (var a = 0; a < grid.length; a++) area += grid[a];
    var terrainCount = Math.max(2, Math.min(5, Math.round(area / 22)));
    placeTerrain(rng.fork('terrain'), grid, cols, rows, avoid, prot, hazards, terrainCount);
    placeBars(rng.fork('bars'), grid, cols, rows, tee, cup, prot, avoid, hazards);
    placePosts(rng.fork('posts'), grid, cols, rows, tee, cup, prot, avoid, hazards);

    // Drop the last-placed BLOCKING obstacle (deterministically) until the
    // cup is reachable again. Passable hazards never affect this.
    var blocked = blockedMask(grid, cols, rows, hazards);
    while (!isReachable(grid, cols, rows, tee, cup, blocked)) {
      var removed = false;
      for (var i = hazards.length - 1; i >= 0; i--) {
        if (BLOCKS_PATH[hazards[i].type]) { hazards.splice(i, 1); removed = true; break; }
      }
      if (!removed) break;
      blocked = blockedMask(grid, cols, rows, hazards);
    }

    var outline = traceMask(grid, cols, rows).map(cornerToWorld);
    // Par scales with how far the ball has to travel (longer / bounce-back
    // holes play to a higher par).
    var par = clampi(2 + Math.round(path.length / 9), 2, 5);

    // Crop the drawing box to the carved region (+ padding for the flag
    // above the cup and the START label below the tee) so every hole fills
    // its card instead of floating in empty grid space.
    var pad = CELL;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var v = 0; v < outline.length; v++) {
      var pt = outline[v];
      if (pt.x < minX) minX = pt.x; if (pt.x > maxX) maxX = pt.x;
      if (pt.y < minY) minY = pt.y; if (pt.y > maxY) maxY = pt.y;
    }
    var view = {
      x: minX - pad, y: minY - pad,
      w: (maxX - minX) + pad * 2, h: (maxY - minY) + pad * 2
    };

    return {
      index: index,
      cols: cols, rows: rows, cell: CELL,
      laneW: (2 * region.lane + 1) * CELL,   // world lane width (for end-cap radius)
      view: view,
      grid: grid,
      outline: outline,
      tee: { cell: tee, pos: cellCenter(tee[0], tee[1]) },
      cup: { cell: cup, pos: cellCenter(cup[0], cup[1]) },
      hazards: hazards,
      par: par
    };
  }

  /* ------------------------------------------------------------------ *
   * Course naming                                                       *
   * ------------------------------------------------------------------ */

  var NAME_A = ['Sunny', 'Breezy', 'Wobbly', 'Happy', 'Mighty', 'Whistling',
    'Rolling', 'Lazy', 'Bumpy', 'Golden', 'Misty', 'Sleepy', 'Jolly', 'Crazy'];
  var NAME_B = ['Acres', 'Hollow', 'Meadow', 'Ridge', 'Gardens', 'Greens',
    'Springs', 'Dunes', 'Cove', 'Pines', 'Creek', 'Hills', 'Bluffs', 'Fields'];

  function courseName(rng) {
    return rng.pick(NAME_A) + ' ' + rng.pick(NAME_B) + ' Mini Golf';
  }

  /* ------------------------------------------------------------------ *
   * Public: generate a whole course                                     *
   * ------------------------------------------------------------------ */

  function generateCourse(seed, opts) {
    opts = opts || {};
    seed = String(seed == null ? 'course' : seed);
    var holeCount = Math.max(3, Math.min(9, opts.holes || 6));
    var layout = opts.layout === 'compact' ? 'compact' : 'roomy';

    var holes = [];
    for (var i = 1; i <= holeCount; i++) holes.push(generateHole(seed, i));

    var totalPar = 0;
    for (var h = 0; h < holes.length; h++) totalPar += holes[h].par;

    return {
      seed: seed,
      name: courseName(makeRng(seed + ':name')),
      holes: holes,
      layout: layout,
      par: totalPar
    };
  }

  var api = {
    generateCourse: generateCourse,
    generateHole: generateHole,
    carveRegion: carveRegion,
    traceMask: traceMask,
    collinearMerge: collinearMerge,
    isReachable: isReachable,
    makeRng: makeRng,
    CELL: CELL,
    MARGIN: MARGIN,
    BLOCKS_PATH: BLOCKS_PATH
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.PaperMiniGolf = api;

})(typeof window !== 'undefined' ? window : this);
