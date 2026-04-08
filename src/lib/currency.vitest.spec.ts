import { describe, expect, it } from "vitest";
import { roundCurrency } from "@/lib/currency";

describe("roundCurrency", () => {
  it("rounds to exactly 2 decimal places", () => {
    expect(roundCurrency(1.005)).toBe(1.01);
    expect(roundCurrency(1.004)).toBe(1.00);
    expect(roundCurrency(2.555)).toBe(2.56);
  });

  it("handles exact integers", () => {
    expect(roundCurrency(100)).toBe(100);
    expect(roundCurrency(0)).toBe(0);
  });

  it("handles negative values", () => {
    expect(roundCurrency(-1.005)).toBe(-1.01);
    expect(roundCurrency(-2.554)).toBe(-2.55);
  });

  it("prevents floating-point drift in common tax scenario", () => {
    // 1000 * 15% = 150.00 exactly — but naive float can drift
    expect(roundCurrency(1000 * 0.15)).toBe(150);
  });

  it("prevents floating-point drift across a multi-line subtotal", () => {
    // Simulates three items: 9.99 + 19.99 + 4.99 = 34.97
    const subtotal = 9.99 + 19.99 + 4.99;
    expect(roundCurrency(subtotal)).toBe(34.97);
  });

  it("is safe for weighted average cost calculation", () => {
    // oldStock=10 @ 5.333, newQty=5 @ 6.00 → (10*5.333 + 5*6.00)/15 = 5.555...
    const oldCost = 5.333;
    const newCost = (10 * oldCost + 5 * 6.0) / 15;
    expect(roundCurrency(newCost)).toBe(5.56);
  });
});
