import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mock state ────────────────────────────────────────────────────
const {
  mockOrderFindUnique,
  mockPaymentFindMany,
  mockOrderItemFindMany,
  mockOrderUpdate,
  mockIsCreditLimitExceeded,
} = vi.hoisted(() => ({
  mockOrderFindUnique: vi.fn(),
  mockPaymentFindMany: vi.fn(),
  mockOrderItemFindMany: vi.fn(),
  mockOrderUpdate: vi.fn(),
  mockIsCreditLimitExceeded: vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────
vi.mock("@/lib/credit", () => ({ isCreditLimitExceeded: mockIsCreditLimitExceeded }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: vi.fn(),
  },
}));

// ── Import after mocks ────────────────────────────────────────────────────
import { recomputeOrderTotalsFromPayments } from "./payments";

// ── Helpers ───────────────────────────────────────────────────────────────

// The function takes a tx (transaction client), not prisma directly.
// We build a mock tx that has the methods needed.
function makeTx(overrides?: Partial<{
  orderFindUnique: ReturnType<typeof vi.fn>;
  paymentFindMany: ReturnType<typeof vi.fn>;
  orderItemFindMany: ReturnType<typeof vi.fn>;
  orderUpdate: ReturnType<typeof vi.fn>;
}>) {
  return {
    order: {
      findUnique: overrides?.orderFindUnique ?? mockOrderFindUnique,
      update: overrides?.orderUpdate ?? mockOrderUpdate,
    },
    payment: { findMany: overrides?.paymentFindMany ?? mockPaymentFindMany },
    orderItem: { findMany: overrides?.orderItemFindMany ?? mockOrderItemFindMany },
  };
}

const baseOrder = {
  id: "order-1",
  total: 100,
  subtotal: 100,
  taxRate: 0,
  taxAmount: 0,
  status: "UNPAID",
  amountPaid: 0,
  balance: 100,
  invoiceNumber: "INV-001",
  userId: "user-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockIsCreditLimitExceeded.mockResolvedValue({ exceeded: false, creditLimit: 0, outstanding: 0 });
  mockOrderUpdate.mockResolvedValue({ ...baseOrder, status: "PAID" });
});

// ── Null / short-circuit cases ─────────────────────────────────────────────

describe("recomputeOrderTotalsFromPayments – guards", () => {
  it("throws when order is not found", async () => {
    mockOrderFindUnique.mockResolvedValue(null);
    await expect(recomputeOrderTotalsFromPayments(makeTx() as never, "order-1")).rejects.toThrow("Order not found");
  });

  it("returns order unchanged when status is CANCELLED", async () => {
    const cancelled = { ...baseOrder, status: "CANCELLED" };
    mockOrderFindUnique.mockResolvedValue(cancelled);
    const result = await recomputeOrderTotalsFromPayments(makeTx() as never, "order-1");
    expect(result).toEqual(cancelled);
    expect(mockOrderUpdate).not.toHaveBeenCalled();
  });
});

// ── Status derivation ──────────────────────────────────────────────────────

describe("recomputeOrderTotalsFromPayments – status derivation", () => {
  beforeEach(() => {
    mockOrderFindUnique.mockResolvedValue(baseOrder);
    // One item: price 100, qty 1, no returns
    mockOrderItemFindMany.mockResolvedValue([{ price: 100, quantity: 1, returnedQuantity: 0 }]);
  });

  it("sets status PAID when sum of payments covers the total", async () => {
    mockPaymentFindMany.mockResolvedValue([{ amount: 100, status: "PAID", note: null }]);
    mockOrderUpdate.mockResolvedValue({ ...baseOrder, status: "PAID" });
    await recomputeOrderTotalsFromPayments(makeTx() as never, "order-1");
    const updateArg = mockOrderUpdate.mock.calls[0][0].data;
    expect(updateArg.status).toBe("PAID");
  });

  it("sets status PARTIALLY_PAID when partial amount is paid", async () => {
    mockPaymentFindMany.mockResolvedValue([{ amount: 50, status: "PAID", note: null }]);
    mockOrderUpdate.mockResolvedValue({ ...baseOrder, status: "PARTIALLY_PAID" });
    await recomputeOrderTotalsFromPayments(makeTx() as never, "order-1");
    const updateArg = mockOrderUpdate.mock.calls[0][0].data;
    expect(updateArg.status).toBe("PARTIALLY_PAID");
  });

  it("sets status UNPAID when no payments exist", async () => {
    mockPaymentFindMany.mockResolvedValue([]);
    mockOrderUpdate.mockResolvedValue({ ...baseOrder, status: "UNPAID" });
    await recomputeOrderTotalsFromPayments(makeTx() as never, "order-1");
    const updateArg = mockOrderUpdate.mock.calls[0][0].data;
    expect(updateArg.status).toBe("UNPAID");
  });

  it("excludes VOID payments from paid total", async () => {
    mockPaymentFindMany.mockResolvedValue([
      { amount: 100, status: "VOID", note: null },   // excluded
      { amount: 30, status: "PAID", note: null },    // included
    ]);
    await recomputeOrderTotalsFromPayments(makeTx() as never, "order-1");
    const updateArg = mockOrderUpdate.mock.calls[0][0].data;
    expect(updateArg.amountPaid).toBe(30);
    expect(updateArg.status).toBe("PARTIALLY_PAID");
  });

  it("subtracts REFUND payments from paid total", async () => {
    mockPaymentFindMany.mockResolvedValue([
      { amount: 100, status: "PAID", note: null },
      { amount: 30, status: "REFUND", note: null },  // -30
    ]);
    await recomputeOrderTotalsFromPayments(makeTx() as never, "order-1");
    const updateArg = mockOrderUpdate.mock.calls[0][0].data;
    expect(updateArg.amountPaid).toBe(70);
  });
});

// ── Subtotal / item calculation ────────────────────────────────────────────

describe("recomputeOrderTotalsFromPayments – subtotal from items", () => {
  beforeEach(() => {
    mockOrderFindUnique.mockResolvedValue(baseOrder);
    mockPaymentFindMany.mockResolvedValue([]);
  });

  it("computes subtotal from item prices and net quantities", async () => {
    mockOrderItemFindMany.mockResolvedValue([
      { price: 50, quantity: 4, returnedQuantity: 1 }, // net qty = 3, subtotal = 150
    ]);
    await recomputeOrderTotalsFromPayments(makeTx() as never, "order-1");
    const updateArg = mockOrderUpdate.mock.calls[0][0].data;
    expect(updateArg.subtotal).toBe(150);
  });

  it("caps amountPaid at total to prevent negative balance", async () => {
    // Over-payment scenario: paid 200 but total is only 100
    mockPaymentFindMany.mockResolvedValue([{ amount: 200, status: "PAID", note: null }]);
    mockOrderItemFindMany.mockResolvedValue([{ price: 100, quantity: 1, returnedQuantity: 0 }]);
    await recomputeOrderTotalsFromPayments(makeTx() as never, "order-1");
    const updateArg = mockOrderUpdate.mock.calls[0][0].data;
    expect(updateArg.amountPaid).toBe(100); // capped at total
    expect(updateArg.balance).toBe(0);
  });
});

// ── MoMo pending exclusion ─────────────────────────────────────────────────

describe("recomputeOrderTotalsFromPayments – MoMo pending exclusion", () => {
  beforeEach(() => {
    mockOrderFindUnique.mockResolvedValue(baseOrder);
    mockOrderItemFindMany.mockResolvedValue([{ price: 100, quantity: 1, returnedQuantity: 0 }]);
  });

  it("excludes unconfirmed MoMo payments (providerRef set but status not SUCCESS)", async () => {
    mockPaymentFindMany.mockResolvedValue([
      {
        amount: 100,
        status: "PAID",
        note: JSON.stringify({ method: "momo", providerRef: "MOMO-123", status: "PENDING" }),
      },
    ]);
    await recomputeOrderTotalsFromPayments(makeTx() as never, "order-1");
    const updateArg = mockOrderUpdate.mock.calls[0][0].data;
    expect(updateArg.amountPaid).toBe(0);
    expect(updateArg.status).toBe("UNPAID");
  });

  it("includes confirmed MoMo payments (status SUCCESS)", async () => {
    mockPaymentFindMany.mockResolvedValue([
      {
        amount: 100,
        status: "PAID",
        note: JSON.stringify({ method: "momo", providerRef: "MOMO-123", status: "SUCCESS" }),
      },
    ]);
    await recomputeOrderTotalsFromPayments(makeTx() as never, "order-1");
    const updateArg = mockOrderUpdate.mock.calls[0][0].data;
    expect(updateArg.amountPaid).toBe(100);
    expect(updateArg.status).toBe("PAID");
  });

  it("includes MoMo payments without a providerRef (not provider-linked)", async () => {
    mockPaymentFindMany.mockResolvedValue([
      {
        amount: 100,
        status: "PAID",
        note: JSON.stringify({ method: "momo", providerRef: "", status: "PENDING" }),
      },
    ]);
    await recomputeOrderTotalsFromPayments(makeTx() as never, "order-1");
    const updateArg = mockOrderUpdate.mock.calls[0][0].data;
    expect(updateArg.amountPaid).toBe(100); // no providerRef → not excluded
  });
});

// ── ON_HOLD_CREDIT status handling ─────────────────────────────────────────

describe("recomputeOrderTotalsFromPayments – ON_HOLD_CREDIT", () => {
  beforeEach(() => {
    mockOrderItemFindMany.mockResolvedValue([{ price: 100, quantity: 1, returnedQuantity: 0 }]);
    mockPaymentFindMany.mockResolvedValue([{ amount: 50, status: "PAID", note: null }]);
  });

  it("keeps ON_HOLD_CREDIT when balance > 0 and credit limit is exceeded", async () => {
    mockOrderFindUnique.mockResolvedValue({ ...baseOrder, status: "ON_HOLD_CREDIT" });
    mockIsCreditLimitExceeded.mockResolvedValue({ exceeded: true, creditLimit: 100, outstanding: 200 });
    await recomputeOrderTotalsFromPayments(makeTx() as never, "order-1");
    const updateArg = mockOrderUpdate.mock.calls[0][0].data;
    expect(updateArg.status).toBe("ON_HOLD_CREDIT");
  });

  it("promotes to PAID when balance reaches 0, even if was ON_HOLD_CREDIT", async () => {
    mockOrderFindUnique.mockResolvedValue({ ...baseOrder, status: "ON_HOLD_CREDIT" });
    mockPaymentFindMany.mockResolvedValue([{ amount: 100, status: "PAID", note: null }]);
    await recomputeOrderTotalsFromPayments(makeTx() as never, "order-1");
    const updateArg = mockOrderUpdate.mock.calls[0][0].data;
    expect(updateArg.status).toBe("PAID");
  });

  it("promotes to PARTIALLY_PAID when balance > 0 and credit limit not exceeded", async () => {
    mockOrderFindUnique.mockResolvedValue({ ...baseOrder, status: "ON_HOLD_CREDIT" });
    mockIsCreditLimitExceeded.mockResolvedValue({ exceeded: false, creditLimit: 500, outstanding: 50 });
    await recomputeOrderTotalsFromPayments(makeTx() as never, "order-1");
    const updateArg = mockOrderUpdate.mock.calls[0][0].data;
    expect(updateArg.status).toBe("PARTIALLY_PAID");
  });
});
