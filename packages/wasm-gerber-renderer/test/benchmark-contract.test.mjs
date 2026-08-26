import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateCompositeBenchmark,
  getCompositeBenchmarkFailures,
  isCompositeBenchmarkAcceptanceMode,
} from "../../../scripts/composite-benchmark-contract.mjs";

function evaluate({
  selectionMs = 100,
  toggleMs = 20,
  encodePassCount = 3,
  beforeEncode = 1,
  afterEncode = 1,
  beforeEncodePass = 3,
  afterEncodePass = 3,
  beforeLookup = 1,
  afterLookup = 2,
  beforeScratchGrowth = 1,
  afterScratchGrowth = 1,
} = {}) {
  return evaluateCompositeBenchmark({
    selectionMs,
    toggleMs,
    encodePassCount,
    selectionDiagnostics: {
      membershipEncodeCount: beforeEncode,
      membershipEncodePassCount: beforeEncodePass,
      lookupRenderCount: beforeLookup,
      renderScratchGrowthCount: beforeScratchGrowth,
    },
    toggleDiagnostics: {
      membershipEncodeCount: afterEncode,
      membershipEncodePassCount: afterEncodePass,
      lookupRenderCount: afterLookup,
      renderScratchGrowthCount: afterScratchGrowth,
    },
  });
}

test("4K benchmark contract verifies lookup-only toggle cache behavior", () => {
  const result = evaluate();
  assert.equal(result.membershipEncodeDelta, 0);
  assert.equal(result.membershipEncodePassDelta, 0);
  assert.equal(result.lookupRenderDelta, 1);
  assert.equal(result.renderScratchGrowthDelta, 0);
  assert.deepEqual(getCompositeBenchmarkFailures(result.targets), []);

  const skippedSelectionEncode = evaluate({
    encodePassCount: 0,
    beforeEncode: 0,
    afterEncode: 0,
    beforeEncodePass: 0,
    afterEncodePass: 0,
  });
  assert.deepEqual(
    getCompositeBenchmarkFailures(skippedSelectionEncode.targets, {
      enforceTiming: false,
    }),
    [
      "selectionEncodedMembershipOnce",
      "selectionUsedExpectedThreeEncodePasses",
    ],
  );

  const reencoded = evaluate({ afterEncode: 2 });
  assert.deepEqual(
    getCompositeBenchmarkFailures(reencoded.targets, { enforceTiming: false }),
    ["toggleDidNotReencodeMembership"],
  );
  const reranEncodePasses = evaluate({ afterEncodePass: 6 });
  assert.deepEqual(
    getCompositeBenchmarkFailures(reranEncodePasses.targets, {
      enforceTiming: false,
    }),
    ["toggleRanNoMembershipEncodePasses"],
  );
  const missingLookup = evaluate({ afterLookup: 1 });
  assert.deepEqual(
    getCompositeBenchmarkFailures(missingLookup.targets, {
      enforceTiming: false,
    }),
    ["toggleRenderedOneLookup"],
  );
  const grewScratch = evaluate({ afterScratchGrowth: 2 });
  assert.deepEqual(
    getCompositeBenchmarkFailures(grewScratch.targets, {
      enforceTiming: false,
    }),
    ["toggleDidNotGrowRenderScratch"],
  );
});

test("software smoke reports timing misses without using them as an exit gate", () => {
  const slow = evaluate({ selectionMs: 800, toggleMs: 200 });
  assert.equal(slow.targets.selectionUnder500Ms, false);
  assert.equal(slow.targets.toggleUnder100Ms, false);
  assert.deepEqual(
    getCompositeBenchmarkFailures(slow.targets, { enforceTiming: false }),
    [],
  );
  assert.deepEqual(getCompositeBenchmarkFailures(slow.targets), [
    "selectionUnder500Ms",
    "toggleUnder100Ms",
  ]);

  assert.equal(
    isCompositeBenchmarkAcceptanceMode({
      allowSoftware: false,
      headless: false,
      channel: "chrome",
    }),
    true,
  );
  for (const smokeOptions of [
    { allowSoftware: true, headless: false, channel: "chrome" },
    { allowSoftware: false, headless: true, channel: "chrome" },
    { allowSoftware: false, headless: false, channel: "chromium" },
  ]) {
    assert.equal(isCompositeBenchmarkAcceptanceMode(smokeOptions), false);
  }
});
