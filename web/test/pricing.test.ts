import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyMarkup, lineCost, normalizeRateKey, pricedGrandTotals, qtyToDisplayUnit, resolveRate } from "../src/lib/pricing.js";
import { money } from "../src/lib/num.js";

describe("pricing.js", () => {
  it("normalizeRateKey strips punctuation", () => {
    assert.equal(normalizeRateKey("FL-01 / Carpet"), "FL 01 CARPET");
  });

  it("lineCost multiplies qty by rates with waste", () => {
    const c = lineCost({
      qty: 100,
      rate: { rate_material: 10, rate_labour: 5, rate_equipment: 0, rate_sub: 0, waste_pct: 10 },
    });
    assert.equal(c.qty, 110);
    assert.equal(c.material_ext, 1100);
    assert.equal(c.labour_ext, 550);
    assert.equal(c.line_total, 1650);
  });

  it("missing rate yields zero extensions", () => {
    const c = lineCost({ qty: 50, rate: null });
    assert.equal(c.line_total, 0);
  });

  it("applyMarkup adds overhead and markup", () => {
    const g = applyMarkup(1000, { overhead_pct: 10, markup_pct: 5 });
    assert.equal(g.subtotal, 1000);
    assert.equal(g.grand_total, 1155);
  });

  it("resolveRate matches finish tag", () => {
    const catalog = [
      { id: "1", code: "FL-01", name: "Carpet tile", unit: "m²", rate_material: 45, rate_labour: 12, rate_equipment: 0, rate_sub: 0 },
    ];
    const hit = resolveRate(catalog, { finishTag: "FL-01", unit: "m²" });
    assert.equal(hit?.code, "FL-01");
  });

  it("qtyToDisplayUnit converts SF to m² in metric mode", () => {
    const q = qtyToDisplayUnit(100, "SF", "metric");
    assert.ok(q > 9 && q < 10);
  });

  it("pricedGrandTotals rolls up condition rows", () => {
    const rows = [{ material_ext: 100, labour_ext: 50, equipment_ext: 0, sub_ext: 0, line_total: 150 }];
    const g = pricedGrandTotals(rows, { markup_pct: 0, overhead_pct: 0 });
    assert.equal(g.material_cost, 100);
    assert.equal(g.grand_total, 150);
  });

  it("money formats AED", () => {
    assert.match(money(1234.5, "AED"), /1,234/);
  });
});
