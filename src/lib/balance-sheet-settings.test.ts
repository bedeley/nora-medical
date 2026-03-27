import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_BALANCE_TOLERANCE,
  DEFAULT_DELTA_WARNING_THRESHOLD_PCT,
  MAX_BALANCE_TOLERANCE,
  MAX_DELTA_WARNING_THRESHOLD_PCT,
  parseDeltaWarningThresholdPct,
  isBalancedWithinTolerance,
  parseBalanceTolerance,
} from "@/lib/balance-sheet-settings";

test("parseBalanceTolerance falls back for invalid values", () => {
  assert.equal(parseBalanceTolerance(null), DEFAULT_BALANCE_TOLERANCE);
  assert.equal(parseBalanceTolerance("not-a-number"), DEFAULT_BALANCE_TOLERANCE);
  assert.equal(parseBalanceTolerance(-1), DEFAULT_BALANCE_TOLERANCE);
});

test("parseBalanceTolerance clamps high values", () => {
  assert.equal(parseBalanceTolerance(0.25), 0.25);
  assert.equal(parseBalanceTolerance(MAX_BALANCE_TOLERANCE + 1), MAX_BALANCE_TOLERANCE);
});

test("isBalancedWithinTolerance checks absolute difference", () => {
  assert.equal(isBalancedWithinTolerance(0.02, 0.05), true);
  assert.equal(isBalancedWithinTolerance(-0.02, 0.05), true);
  assert.equal(isBalancedWithinTolerance(0.08, 0.05), false);
});

test("parseDeltaWarningThresholdPct falls back for invalid values", () => {
  assert.equal(parseDeltaWarningThresholdPct(null), DEFAULT_DELTA_WARNING_THRESHOLD_PCT);
  assert.equal(parseDeltaWarningThresholdPct("bad"), DEFAULT_DELTA_WARNING_THRESHOLD_PCT);
  assert.equal(parseDeltaWarningThresholdPct(-5), DEFAULT_DELTA_WARNING_THRESHOLD_PCT);
});

test("parseDeltaWarningThresholdPct clamps high values", () => {
  assert.equal(parseDeltaWarningThresholdPct(12.5), 12.5);
  assert.equal(parseDeltaWarningThresholdPct(MAX_DELTA_WARNING_THRESHOLD_PCT + 1), MAX_DELTA_WARNING_THRESHOLD_PCT);
});
