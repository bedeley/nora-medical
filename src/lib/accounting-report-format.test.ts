import test from "node:test";
import assert from "node:assert/strict";
import { formatPercent, formatSignedCurrency, formatSignedPercent } from "@/lib/accounting-report-format";

test("formatSignedCurrency prefixes positive values", () => {
  assert.match(formatSignedCurrency(100), /^\+/);
  assert.doesNotMatch(formatSignedCurrency(-100), /^\+/);
});

test("formatPercent uses fixed digits", () => {
  assert.equal(formatPercent(12.3456), "12.35%");
  assert.equal(formatPercent(12.3456, 1), "12.3%");
});

test("formatSignedPercent handles sign and invalid numbers", () => {
  assert.equal(formatSignedPercent(2.345), "+2.35%");
  assert.equal(formatSignedPercent(-2.345), "-2.35%");
  assert.equal(formatSignedPercent(Number.NaN), "N/A");
});

