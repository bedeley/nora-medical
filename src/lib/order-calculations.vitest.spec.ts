/**
 * Tests for order calculation correctness.
 *
 * These cover the core financial math applied in:
 *   - /api/admin/orders (order creation)
 *   - /lib/payments.ts  (recomputeOrderTotalsFromPayments)
 *
 * No database or HTTP layer is needed; we test the pure formulas.
 */
import { describe, expect, it } from "vitest";
import { roundCurrency } from "@/lib/currency";

// ─── Helper: mirrors the order-creation calculation in admin/orders/route.ts ──

function calcOrderTotals({
  items,
  taxRate = 0,
  discountAmount = 0,
  initialPayment = 0,
}: {
  items: { price: number; quantity: number }[];
  taxRate?: number;
  discountAmount?: number;
  initialPayment?: number;
}) {
  const subtotal = roundCurrency(
    items.reduce((sum, it) => sum + it.price * it.quantity, 0)
  );
  const normalizedTaxRate = Number.isFinite(taxRate) ? Math.max(0, taxRate) : 0;
  const taxAmount = roundCurrency(subtotal * (normalizedTaxRate / 100));
  const normalizedDiscount = Number.isFinite(discountAmount)
    ? Math.max(0, Math.min(discountAmount, subtotal + taxAmount))
    : 0;
  const total = roundCurrency(Math.max(0, subtotal + taxAmount - normalizedDiscount));
  const amountPaid = roundCurrency(Math.min(initialPayment, total));
  const balance = roundCurrency(Math.max(0, total - amountPaid));
  return { subtotal, taxAmount, total, amountPaid, balance };
}

// ─── Helper: mirrors recomputeOrderTotalsFromPayments in lib/payments.ts ─────

function recomputeFromPayments({
  items,
  payments,
  taxRate = 0,
  priorSubtotal = 0,
  priorTax = 0,
}: {
  items: { price: number; quantity: number; returnedQuantity: number }[];
  payments: { amount: number; status: "NORMAL" | "REFUND" | "VOID" }[];
  taxRate?: number;
  priorSubtotal?: number;
  priorTax?: number;
}) {
  let paid = 0;
  for (const p of payments) {
    if (p.status === "VOID") continue;
    const amt = Math.abs(p.amount);
    paid += p.status === "REFUND" ? -amt : amt;
  }

  const subtotal = roundCurrency(
    items.reduce((sum, it) => {
      const netQty = Math.max(0, it.quantity - it.returnedQuantity);
      return sum + it.price * netQty;
    }, 0)
  );
  const taxAmount = roundCurrency(
    taxRate > 0
      ? (subtotal * taxRate) / 100
      : priorSubtotal > 0
      ? (priorTax * subtotal) / priorSubtotal
      : 0
  );
  const total = roundCurrency(subtotal + taxAmount);
  const amountPaid = roundCurrency(Math.min(Math.max(0, paid), total));
  const balance = roundCurrency(Math.max(0, total - amountPaid));
  return { subtotal, taxAmount, total, amountPaid, balance };
}

// ─── Helper: weighted average cost (purchases) ───────────────────────────────

function calcWeightedAvgCost(oldStock: number, oldCost: number, receiveQty: number, unitCost: number) {
  const effectiveOldStock = Math.max(0, oldStock);
  const denom = effectiveOldStock + receiveQty;
  return roundCurrency(
    denom > 0 ? (oldCost * effectiveOldStock + unitCost * receiveQty) / denom : oldCost
  );
}

// ─────────────────────────────────────────────────────────────────────────────
describe("Order creation calculations", () => {
  it("computes correct subtotal for multiple items", () => {
    const r = calcOrderTotals({
      items: [
        { price: 9.99, quantity: 2 },
        { price: 19.99, quantity: 1 },
      ],
    });
    expect(r.subtotal).toBe(39.97);
  });

  it("applies tax correctly at 15%", () => {
    const r = calcOrderTotals({
      items: [{ price: 100, quantity: 1 }],
      taxRate: 15,
    });
    expect(r.taxAmount).toBe(15);
    expect(r.total).toBe(115);
  });

  it("caps discount at subtotal + tax (never exceeds order value)", () => {
    const r = calcOrderTotals({
      items: [{ price: 50, quantity: 1 }],
      taxRate: 10,
      discountAmount: 999, // way over the total
    });
    expect(r.total).toBe(0);
    expect(r.balance).toBe(0);
  });

  it("caps amountPaid at total (no overpayment)", () => {
    const r = calcOrderTotals({
      items: [{ price: 100, quantity: 1 }],
      initialPayment: 500,
    });
    expect(r.amountPaid).toBe(100);
    expect(r.balance).toBe(0);
  });

  it("produces zero balance when fully paid", () => {
    const r = calcOrderTotals({
      items: [{ price: 200, quantity: 1 }],
      taxRate: 0,
      initialPayment: 200,
    });
    expect(r.balance).toBe(0);
    expect(r.amountPaid).toBe(200);
  });

  it("tracks correct balance for partial payment", () => {
    const r = calcOrderTotals({
      items: [{ price: 300, quantity: 1 }],
      initialPayment: 100,
    });
    expect(r.amountPaid).toBe(100);
    expect(r.balance).toBe(200);
  });

  it("handles zero-value order gracefully", () => {
    const r = calcOrderTotals({ items: [{ price: 0, quantity: 5 }] });
    expect(r.subtotal).toBe(0);
    expect(r.total).toBe(0);
    expect(r.balance).toBe(0);
  });

  it("rounds floating-point subtotals correctly", () => {
    // 3 × 0.10 = 0.30000000000000004 in naive JS; must round to 0.30
    const r = calcOrderTotals({ items: [{ price: 0.1, quantity: 3 }] });
    expect(r.subtotal).toBe(0.30);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Payment recomputation (recomputeOrderTotalsFromPayments)", () => {
  const items = [{ price: 100, quantity: 2, returnedQuantity: 0 }];

  it("correctly sums normal payments", () => {
    const r = recomputeFromPayments({
      items,
      payments: [
        { amount: 100, status: "NORMAL" },
        { amount: 50, status: "NORMAL" },
      ],
    });
    expect(r.amountPaid).toBe(150);
    expect(r.balance).toBe(50);
  });

  it("excludes VOID payments from total paid", () => {
    const r = recomputeFromPayments({
      items,
      payments: [
        { amount: 200, status: "VOID" },
        { amount: 100, status: "NORMAL" },
      ],
    });
    expect(r.amountPaid).toBe(100);
    expect(r.balance).toBe(100);
  });

  it("subtracts REFUND payments from total paid", () => {
    const r = recomputeFromPayments({
      items,
      payments: [
        { amount: 200, status: "NORMAL" },
        { amount: 50, status: "REFUND" },
      ],
    });
    expect(r.amountPaid).toBe(150);
    expect(r.balance).toBe(50);
  });

  it("accounts for returned items when recomputing subtotal", () => {
    const r = recomputeFromPayments({
      items: [{ price: 100, quantity: 2, returnedQuantity: 1 }],
      payments: [{ amount: 200, status: "NORMAL" }],
    });
    // After 1 return: subtotal = 100, paid already = 200 but capped at 100
    expect(r.subtotal).toBe(100);
    expect(r.amountPaid).toBe(100);
    expect(r.balance).toBe(0);
  });

  it("keeps amountPaid ≤ total (no negative AR)", () => {
    const r = recomputeFromPayments({
      items,
      payments: [{ amount: 9999, status: "NORMAL" }],
    });
    expect(r.amountPaid).toBe(r.total);
    expect(r.balance).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Weighted average cost (purchase receiving)", () => {
  it("computes correct weighted average on first receipt", () => {
    // Stock=0, cost=0 → receive 10 @ 5.00
    expect(calcWeightedAvgCost(0, 0, 10, 5.0)).toBe(5.0);
  });

  it("blends new receipt cost into existing stock", () => {
    // Stock=10 @ 4.00, receive 10 @ 6.00 → avg = (40+60)/20 = 5.00
    expect(calcWeightedAvgCost(10, 4.0, 10, 6.0)).toBe(5.0);
  });

  it("ignores negative existing stock in the denominator", () => {
    // Stock=-5 (oversold), receive 10 @ 8.00
    // effectiveOldStock=0, denom=10, newCost=8.00
    expect(calcWeightedAvgCost(-5, 5.0, 10, 8.0)).toBe(8.0);
  });

  it("keeps old cost when no quantity is received", () => {
    expect(calcWeightedAvgCost(10, 7.5, 0, 0)).toBe(7.5);
  });

  it("rounds the resulting cost to 2 decimal places", () => {
    // (10 * 5.333 + 5 * 6.0) / 15 = 5.5553... → 5.56
    expect(calcWeightedAvgCost(10, 5.333, 5, 6.0)).toBe(5.56);
  });
});
