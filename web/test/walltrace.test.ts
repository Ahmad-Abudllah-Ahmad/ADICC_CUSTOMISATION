import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildWallMask,
  floodWallInk,
  breakWallOpenings,
  MASK_MAX_DIM,
  SENS_STRICT,
  SENS_BALANCED,
} from "../src/lib/oneclick";
import {
  buildWallMaskFromSegs,
  wallTraceAtPoint,
  wallQuantitiesFromRings,
  ringPerimeter,
} from "../src/lib/walltrace";

/** Synthetic building inset from sheet border: outer wall band (2px ink), inner room open. */
function syntheticBuildingMask(): { mask: Uint8Array; mw: number; mh: number; ws: number } {
  const mw = 60, mh = 50, ws = 1;
  const mask = new Uint8Array(mw * mh);
  const ink = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= mw || y >= mh) return;
    mask[y * mw + x] = 1;
  };
  const x0 = 10, y0 = 10, x1 = 49, y1 = 39;
  for (let x = x0; x <= x1; x++) { ink(x, y0); ink(x, y0 + 1); ink(x, y1); ink(x, y1 - 1); }
  for (let y = y0; y <= y1; y++) { ink(x0, y); ink(x0 + 1, y); ink(x1, y); ink(x1 - 1, y); }
  return { mask, mw, mh, ws };
}

describe("walltrace", () => {
  it("ringPerimeter sums closed ring edges", () => {
    const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
    assert.equal(ringPerimeter(sq), 40);
  });

  it("wallQuantitiesFromRings computes footprint, face, volume", () => {
    const outer = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const holes = [[[2, 2], [8, 2], [8, 8], [2, 8]]];
    const q = wallQuantitiesFromRings(outer, holes, 1, 10); // 1 ft/px, 10 ft height
    assert.equal(q.footprint_sf, 64); // 100 - 36
    assert.equal(q.perimeter_lf, 64); // outer 40 + hole 24
    assert.equal(q.wall_face_sf, 640);
    assert.equal(q.volume_cf, 640);
  });

  it("floodWallInk traces connected ink in synthetic building", () => {
    const { mask, mw, mh, ws } = syntheticBuildingMask();
    const mo = { mask, mw, mh, ws, softCount: 0 };
    const f = floodWallInk(mo, 11, 15, SENS_BALANCED); // on inset left wall ink
    assert.equal(f.status, "ok");
    if (f.status === "ok") {
      assert.ok(f.count > 100);
    }
    const traced = wallTraceAtPoint(mo, 11, 15, { upp: 1, heightFt: 10, sensitivity: SENS_BALANCED });
    assert.equal(traced.status, "ok");
    if (traced.status === "ok") {
      assert.ok(traced.outer.length >= 3);
      assert.ok(traced.holes.length >= 1);
      assert.ok(traced.quantities.footprint_sf > 0);
      assert.ok(traced.quantities.wall_face_sf > 0);
    }
  });

  it("floodWallInk rejects leak to sheet border", () => {
    const mw = 30, mh = 20, ws = 1;
    const mask = new Uint8Array(mw * mh);
    // horizontal line along top edge
    for (let x = 0; x < mw; x++) mask[x] = 1;
    const mo = { mask, mw, mh, ws, softCount: 0 };
    const f = floodWallInk(mo, 15, 0, SENS_STRICT);
    assert.equal(f.status, "leak");
  });

  it("buildWallMask filters thin segments", () => {
    const segs = [5, 5, 25, 5, 5, 25, 25, 25, 25, 5]; // square
    const meta = new Uint8Array([0x10, 0x10, 0x10, 0x10]); // devW=1 each
    const thin = buildWallMask(segs, 30, 30, MASK_MAX_DIM, meta, 3);
    const thick = buildWallMask(segs, 30, 30, MASK_MAX_DIM, meta, 1);
    let thinN = 0, thickN = 0;
    for (let i = 0; i < thin.mask.length; i++) { if (thin.mask[i]) thinN++; if (thick.mask[i]) thickN++; }
    assert.equal(thinN, 0);
    assert.ok(thickN > 0);
  });

  it("buildWallMaskFromSegs uses sensitivity minDevW", () => {
    const segs = [5, 5, 25, 5];
    const meta = new Uint8Array([0x20]); // devW=2
    const strict = buildWallMaskFromSegs(segs, 30, 30, meta, SENS_STRICT);
    const agg = buildWallMaskFromSegs(segs, 30, 30, meta, 1);
    let sN = 0, aN = 0;
    for (let i = 0; i < strict.mask.length; i++) {
      if (strict.mask[i]) sN++;
      if (agg.mask[i]) aN++;
    }
    assert.ok(sN >= 0);
    assert.ok(aN >= sN);
  });

  it("breakWallOpenings splits two masses connected by a thin neck", () => {
    const mw = 40, mh = 20, ws = 1;
    const mask = new Uint8Array(mw * mh);
    const ink = (x: number, y: number) => { if (x >= 0 && y >= 0 && x < mw && y < mh) mask[y * mw + x] = 1; };
    for (let y = 4; y < 16; y++) {
      ink(3, y); ink(4, y); ink(5, y);
      ink(33, y); ink(34, y); ink(35, y);
    }
    ink(5, 9); ink(6, 9); ink(7, 9); // 3px neck
    const mo = { mask, mw, mh, ws, softCount: 0 };
    const joined = floodWallInk(mo, 4, 10, SENS_BALANCED, 0);
    assert.equal(joined.status, "ok");
    const broken = breakWallOpenings(mo, 6);
    const left = floodWallInk(broken, 4, 10, SENS_BALANCED, 0);
    const right = floodWallInk(broken, 34, 10, SENS_BALANCED, 0);
    assert.equal(left.status, "ok");
    assert.equal(right.status, "ok");
    if (left.status === "ok" && right.status === "ok") {
      assert.ok(left.count < joined.count);
      assert.ok(right.count < joined.count);
    }
  });
});
