import { test } from "node:test";
import assert from "node:assert/strict";
import { partitionRows } from "../public/practice-overview.mjs";

test("总览连续分列按实际行高平衡，保留顺序与非空列", () => {
  assert.deepEqual(partitionRows([10, 10, 30, 10, 10], 2), {
    ends: [2, 5],
    height: 50,
  });
  assert.deepEqual(partitionRows([10, 10, 30, 10, 10], 3), {
    ends: [2, 3, 5],
    height: 30,
  });
  assert.deepEqual(partitionRows([10, 20], 4), { ends: [1, 2], height: 20 });
  assert.deepEqual(partitionRows([], 2), { ends: [], height: 0 });
});
