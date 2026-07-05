/*
 * Headless checks for the Paper Mini Golf generator.
 *
 *   node test/generator.test.js
 *
 * No test framework — plain assert()s; exits nonzero on the first failure.
 * Covers: RNG determinism, course/hole determinism, tee->cup connectivity,
 * closed & rectilinear wall outlines, and hazards never sealing the hole.
 */
'use strict';

var PMG = require('../minigolf.js');

var passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('FAIL: ' + msg); process.exit(1); }
  passed++;
}

/* ---- RNG determinism ------------------------------------------------ */
(function () {
  var a = PMG.makeRng('hello'), b = PMG.makeRng('hello'), c = PMG.makeRng('world');
  var sa = [a.next(), a.next(), a.next()];
  var sb = [b.next(), b.next(), b.next()];
  assert(sa[0] === sb[0] && sa[1] === sb[1] && sa[2] === sb[2], 'same seed -> same RNG stream');
  assert(sa[0] !== c.next(), 'different seed -> different RNG stream');
  var f1 = PMG.makeRng('x').fork('tag').next();
  var f2 = PMG.makeRng('x').fork('tag').next();
  var f3 = PMG.makeRng('x').fork('other').next();
  assert(f1 === f2, 'fork(tag) is deterministic');
  assert(f1 !== f3, 'different fork tags diverge');
})();

/* ---- collinearMerge ------------------------------------------------- */
(function () {
  var square = [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2], [1, 2], [0, 2], [0, 1]];
  var merged = PMG.collinearMerge(square);
  assert(merged.length === 4, 'a square merges to 4 corners (got ' + merged.length + ')');
})();

/* ---- traceMask on a fixed fixture ----------------------------------- */
(function () {
  // 3x3 grid, an L-shape carved (bottom row + left column).
  var cols = 3, rows = 3;
  var g = new Uint8Array(9);
  var set = function (c, r) { g[r * cols + c] = 1; };
  set(0, 0); set(0, 1); set(0, 2); set(1, 2); set(2, 2);
  var loop = PMG.traceMask(g, cols, rows);
  assert(loop.length === 6, 'L-shape outline has 6 corners (got ' + loop.length + ')');
  // every consecutive edge is axis-aligned (shares x or y)
  var straight = true;
  for (var i = 0; i < loop.length; i++) {
    var a = loop[i], b = loop[(i + 1) % loop.length];
    if (a[0] !== b[0] && a[1] !== b[1]) straight = false;
  }
  assert(straight, 'fixture outline is fully rectilinear');
})();

/* ---- course determinism --------------------------------------------- */
(function () {
  var c1 = PMG.generateCourse('demo-course', { holes: 6 });
  var c2 = PMG.generateCourse('demo-course', { holes: 6 });
  assert(JSON.stringify(strip(c1)) === JSON.stringify(strip(c2)),
    'same seed -> identical course');
  var c3 = PMG.generateCourse('other-seed', { holes: 6 });
  assert(JSON.stringify(strip(c1)) !== JSON.stringify(strip(c3)),
    'different seed -> different course');
  assert(c1.name === c2.name, 'course name is deterministic');
  // Uint8Array grids don't JSON-stringify usefully; drop them for compare.
  function strip(course) {
    return course.holes.map(function (h) {
      return { outline: h.outline, tee: h.tee, cup: h.cup, hazards: h.hazards, baffles: h.baffles, par: h.par };
    });
  }
})();

/* ---- per-hole invariants over many seeds ---------------------------- */
(function () {
  var seedsChecked = 0, holesChecked = 0;
  for (var s = 0; s < 120; s++) {
    var course = PMG.generateCourse('seed-' + s, { holes: 5 });
    assert(course.holes.length === 5, 'course has requested hole count');
    for (var i = 0; i < course.holes.length; i++) {
      var h = course.holes[i];
      holesChecked++;

      // outline closed & rectilinear
      assert(h.outline.length >= 4, 'hole outline has >= 4 corners (seed ' + s + ')');
      var rect = true;
      for (var k = 0; k < h.outline.length; k++) {
        var a = h.outline[k], b = h.outline[(k + 1) % h.outline.length];
        if (a.x !== b.x && a.y !== b.y) rect = false;
      }
      assert(rect, 'outline fully rectilinear (seed ' + s + ' hole ' + i + ')');

      // tee != cup, both on playable cells
      var tc = h.tee.cell, cc = h.cup.cell;
      assert(!(tc[0] === cc[0] && tc[1] === cc[1]), 'tee != cup (seed ' + s + ')');
      assert(h.grid[tc[1] * h.cols + tc[0]] === 1, 'tee on playable cell');
      assert(h.grid[cc[1] * h.cols + cc[0]] === 1, 'cup on playable cell');

      // hazards fully inside the playable region
      for (var z = 0; z < h.hazards.length; z++) {
        var cells = h.hazards[z].cells;
        for (var q = 0; q < cells.length; q++) {
          assert(h.grid[cells[q][1] * h.cols + cells[q][0]] === 1,
            'hazard cell is inside region (seed ' + s + ')');
        }
      }

      // cup reachable from tee with blocking hazards applied
      var blocked = new Uint8Array(h.cols * h.rows);
      for (var b2 = 0; b2 < h.hazards.length; b2++) {
        if (!PMG.BLOCKS_PATH[h.hazards[b2].type]) continue;
        var hc = h.hazards[b2].cells;
        for (var m = 0; m < hc.length; m++) blocked[hc[m][1] * h.cols + hc[m][0]] = 1;
      }
      assert(PMG.isReachable(h.grid, h.cols, h.rows, tc, cc, blocked),
        'cup reachable from tee (seed ' + s + ' hole ' + i + ')');
    }
    seedsChecked++;
  }
  console.log('checked ' + holesChecked + ' holes across ' + seedsChecked + ' seeds');
})();

console.log('OK — ' + passed + ' assertions passed');
