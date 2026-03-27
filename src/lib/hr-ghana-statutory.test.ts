import test from "node:test";
import assert from "node:assert/strict";
import {
  computeProgressiveTax,
  getDefaultGhanaStatutoryConfig,
  normalizeGhanaStatutoryConfig,
} from "@/lib/hr-ghana-statutory-core";

test("default Ghana statutory config has valid SSNIT and PAYE bands", () => {
  const config = getDefaultGhanaStatutoryConfig();
  assert.equal(config.ssnitEmployeeRate, 5.5);
  assert.ok(config.payeBands.length >= 2);
  assert.equal(config.payeBands.at(-1)?.limit, null);
});

test("computeProgressiveTax applies progressive bands correctly", () => {
  const tax = computeProgressiveTax(600, [
    { limit: 490, rate: 0 },
    { limit: 110, rate: 5 },
    { limit: null, rate: 10 },
  ]);
  assert.equal(tax, 5.5);
});

test("normalizeGhanaStatutoryConfig falls back on invalid inputs", () => {
  const config = normalizeGhanaStatutoryConfig({
    ssnitEmployeeRate: "bad",
    payeBands: "bad",
  });
  assert.equal(config.ssnitEmployeeRate, 5.5);
  assert.ok(config.payeBands.length > 0);
});
