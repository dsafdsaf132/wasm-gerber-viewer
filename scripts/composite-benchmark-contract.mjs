export function evaluateCompositeBenchmark({
  selectionMs,
  toggleMs,
  encodePassCount,
  selectionDiagnostics,
  toggleDiagnostics,
}) {
  const membershipEncodeDelta =
    toggleDiagnostics.membershipEncodeCount -
    selectionDiagnostics.membershipEncodeCount;
  const membershipEncodePassDelta =
    toggleDiagnostics.membershipEncodePassCount -
    selectionDiagnostics.membershipEncodePassCount;
  const lookupRenderDelta =
    toggleDiagnostics.lookupRenderCount -
    selectionDiagnostics.lookupRenderCount;
  const renderScratchGrowthDelta =
    toggleDiagnostics.renderScratchGrowthCount -
    selectionDiagnostics.renderScratchGrowthCount;

  return {
    membershipEncodeCountBeforeToggle:
      selectionDiagnostics.membershipEncodeCount,
    membershipEncodeCountAfterToggle:
      toggleDiagnostics.membershipEncodeCount,
    membershipEncodeDelta,
    membershipEncodePassCountBeforeToggle:
      selectionDiagnostics.membershipEncodePassCount,
    membershipEncodePassCountAfterToggle:
      toggleDiagnostics.membershipEncodePassCount,
    membershipEncodePassDelta,
    lookupRenderCountBeforeToggle: selectionDiagnostics.lookupRenderCount,
    lookupRenderCountAfterToggle: toggleDiagnostics.lookupRenderCount,
    lookupRenderDelta,
    renderScratchGrowthCountBeforeToggle:
      selectionDiagnostics.renderScratchGrowthCount,
    renderScratchGrowthCountAfterToggle:
      toggleDiagnostics.renderScratchGrowthCount,
    renderScratchGrowthDelta,
    targets: {
      selectionUnder500Ms: selectionMs <= 500,
      toggleUnder100Ms: toggleMs <= 100,
      selectionEncodedMembershipOnce:
        selectionDiagnostics.membershipEncodeCount === 1,
      selectionUsedExpectedThreeEncodePasses:
        encodePassCount === 3 &&
        selectionDiagnostics.membershipEncodePassCount === 3,
      toggleDidNotReencodeMembership: membershipEncodeDelta === 0,
      toggleRanNoMembershipEncodePasses: membershipEncodePassDelta === 0,
      toggleRenderedOneLookup: lookupRenderDelta === 1,
      toggleDidNotGrowRenderScratch: renderScratchGrowthDelta === 0,
    },
  };
}

export function getCompositeBenchmarkFailures(targets, {
  enforceTiming = true,
} = {}) {
  const functionalTargetNames = [
    "selectionEncodedMembershipOnce",
    "selectionUsedExpectedThreeEncodePasses",
    "toggleDidNotReencodeMembership",
    "toggleRanNoMembershipEncodePasses",
    "toggleRenderedOneLookup",
    "toggleDidNotGrowRenderScratch",
  ];
  const timingTargetNames = [
    "selectionUnder500Ms",
    "toggleUnder100Ms",
  ];
  const checkedTargetNames = enforceTiming
    ? [...timingTargetNames, ...functionalTargetNames]
    : functionalTargetNames;
  return checkedTargetNames.filter((name) => targets[name] !== true);
}

export function isCompositeBenchmarkAcceptanceMode({
  allowSoftware,
  headless,
  channel,
}) {
  return allowSoftware !== true && headless !== true && channel === "chrome";
}
