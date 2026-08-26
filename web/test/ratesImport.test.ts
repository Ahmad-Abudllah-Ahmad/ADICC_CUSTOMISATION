import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mapImportRow, parseCsvRates } from "../src/lib/ratesImport.js";

describe("ratesImport", () => {
  it("mapImportRow uses code and rates", () => {
    const row = mapImportRow({
      code: "CPT-1",
      name: "Carpet tile",
      unit: "m²",
      rate_material: "85",
      labour: "25",
    });
    assert.ok(row);
    assert.equal(row.code, "CPT-1");
    assert.equal(row.rate_material, 85);
    assert.equal(row.rate_labour, 25);
  });

  it("parseCsvRates reads header aliases", () => {
    const csv = [
      "Code,Description,Unit,Rate,Labour",
      "FL-01,Porcelain tile,m²,120,40",
    ].join("\n");
    const rows = parseCsvRates(csv, "test.csv");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].code, "FL-01");
    assert.equal(rows[0].name, "Porcelain tile");
    assert.equal(rows[0].rate_material, 120);
    assert.equal(rows[0].rate_labour, 40);
  });
});
