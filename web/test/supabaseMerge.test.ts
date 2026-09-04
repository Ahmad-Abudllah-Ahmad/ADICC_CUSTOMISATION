import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeTakeoffPayload,
  computeLocalShapeDeletes,
} from "../src/lib/supabase/mergePayload.js";
import { enqueueProjectSave, waitForProjectSave } from "../src/lib/supabase/saveQueue.js";

test("mergeTakeoffPayload keeps remote-only shapes when local user never saw them", () => {
  const remote = {
    shapes: [{ id: "a", sheet_id: "s1.pdf", updated_at: "2026-01-01T00:00:00.000Z" }],
  };
  const local = {
    shapes: [{ id: "b", sheet_id: "s2.pdf", updated_at: "2026-01-02T00:00:00.000Z" }],
  };
  const merged = mergeTakeoffPayload(local, remote, new Set());
  assert.deepEqual(merged.shapes.map((s: { id: string }) => s.id).sort(), ["a", "b"]);
});

test("mergeTakeoffPayload honors explicit local shape deletes", () => {
  const remote = {
    shapes: [{ id: "gone", sheet_id: "s1.pdf", updated_at: "2026-01-01T00:00:00.000Z" }],
  };
  const local = { shapes: [] };
  const merged = mergeTakeoffPayload(local, remote, new Set(["gone"]));
  assert.equal(merged.shapes.length, 0);
});

test("mergeTakeoffPayload picks newer updated_at on the same shape id", () => {
  const remote = {
    shapes: [{ id: "x", label: "old", updated_at: "2026-01-01T00:00:00.000Z" }],
  };
  const local = {
    shapes: [{ id: "x", label: "new", updated_at: "2026-01-03T00:00:00.000Z" }],
  };
  const merged = mergeTakeoffPayload(local, remote, new Set());
  assert.equal(merged.shapes[0].label, "new");
});

test("computeLocalShapeDeletes detects ids removed since last save baseline", () => {
  const snap = new Map([
    ["p1", new Map([
      ["keep", {}],
      ["drop", {}],
    ])],
  ]);
  const deleted = computeLocalShapeDeletes(snap, "p1", [{ id: "keep" }]);
  assert.deepEqual([...deleted], ["drop"]);
});

test("enqueueProjectSave runs saves FIFO per project", async () => {
  const order: number[] = [];
  const p = enqueueProjectSave("proj", async () => {
    order.push(1);
    await new Promise((r) => setTimeout(r, 20));
  });
  const q = enqueueProjectSave("proj", async () => { order.push(2); });
  await Promise.all([p, q]);
  await waitForProjectSave("proj");
  assert.deepEqual(order, [1, 2]);
});
