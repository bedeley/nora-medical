import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mock state ────────────────────────────────────────────────────
const {
  mockBalanceFindUnique,
  mockOrderFindMany,
} = vi.hoisted(() => ({
  mockBalanceFindUnique: vi.fn(),
  mockOrderFindMany: vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: vi.fn() },
}));

// ── Import after mocks ────────────────────────────────────────────────────
import { isCreditLimitExceeded, getCreditLimitForUser, computeOutstandingBalance } from "./credit";

// ── Helpers ───────────────────────────────────────────────────────────────

// The three functions take a tx (transaction client). Build a minimal mock tx.
function makeTx() {
  return {
    balance: { findUnique: mockBalanceFindUnique },
    order: { findMany: mockOrderFindMany },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── getCreditLimitForUser ──────────────────────────────────────────────────

describe("getCreditLimitForUser", () => {
  it("returns 0 when userId is null", async () => {
    const result = await getCreditLimitForUser(makeTx() as never, null);
    expect(result).toBe(0);
    expect(mockBalanceFindUnique).not.toHaveBeenCalled();
  });

  it("returns 0 when userId is undefined", async () => {
    const result = await getCreditLimitForUser(makeTx() as never, undefined);
    expect(result).toBe(0);
  });

  it("returns 0 when no balance row exists for the user", async () => {
    mockBalanceFindUnique.mockResolvedValue(null);
    const result = await getCreditLimitForUser(makeTx() as never, "user-1");
    expect(result).toBe(0);
  });

  it("returns 0 when balance row has null creditLimit", async () => {
    mockBalanceFindUnique.mockResolvedValue({ creditLimit: null });
    const result = await getCreditLimitForUser(makeTx() as never, "user-1");
    expect(result).toBe(0);
  });

  it("returns the creditLimit as a number", async () => {
    mockBalanceFindUnique.mockResolvedValue({ creditLimit: 1500 });
    const result = await getCreditLimitForUser(makeTx() as never, "user-1");
    expect(result).toBe(1500);
  });
});

// ── computeOutstandingBalance ──────────────────────────────────────────────

describe("computeOutstandingBalance", () => {
  it("returns 0 when userId is null", async () => {
    const result = await computeOutstandingBalance(makeTx() as never, null);
    expect(result).toBe(0);
    expect(mockOrderFindMany).not.toHaveBeenCalled();
  });

  it("returns 0 when user has no orders", async () => {
    mockOrderFindMany.mockResolvedValue([]);
    const result = await computeOutstandingBalance(makeTx() as never, "user-1");
    expect(result).toBe(0);
  });

  it("sums outstanding balances across all non-cancelled orders", async () => {
    mockOrderFindMany.mockResolvedValue([
      { total: 200, amountPaid: 50 },  // outstanding: 150
      { total: 100, amountPaid: 100 }, // outstanding: 0
      { total: 300, amountPaid: 80 },  // outstanding: 220
    ]);
    const result = await computeOutstandingBalance(makeTx() as never, "user-1");
    expect(result).toBe(370); // 150 + 0 + 220
  });

  it("treats overpayment as 0 outstanding (Math.max guard)", async () => {
    mockOrderFindMany.mockResolvedValue([
      { total: 100, amountPaid: 150 }, // overpaid → 0 outstanding
    ]);
    const result = await computeOutstandingBalance(makeTx() as never, "user-1");
    expect(result).toBe(0);
  });
});

// ── isCreditLimitExceeded ──────────────────────────────────────────────────

describe("isCreditLimitExceeded", () => {
  it("returns exceeded:false when userId is null", async () => {
    const result = await isCreditLimitExceeded(makeTx() as never, null);
    expect(result.exceeded).toBe(false);
    expect(result.outstanding).toBe(0);
  });

  it("returns exceeded:false when creditLimit is 0 (no credit facility)", async () => {
    mockBalanceFindUnique.mockResolvedValue({ creditLimit: 0 });
    const result = await isCreditLimitExceeded(makeTx() as never, "user-1");
    expect(result.exceeded).toBe(false);
    expect(result.creditLimit).toBe(0);
    expect(mockOrderFindMany).not.toHaveBeenCalled(); // short-circuits
  });

  it("returns exceeded:false when outstanding is below the credit limit", async () => {
    mockBalanceFindUnique.mockResolvedValue({ creditLimit: 500 });
    mockOrderFindMany.mockResolvedValue([
      { total: 200, amountPaid: 0 }, // outstanding: 200
    ]);
    const result = await isCreditLimitExceeded(makeTx() as never, "user-1");
    expect(result.exceeded).toBe(false);
    expect(result.creditLimit).toBe(500);
    expect(result.outstanding).toBe(200);
  });

  it("returns exceeded:false when outstanding exactly equals the credit limit", async () => {
    mockBalanceFindUnique.mockResolvedValue({ creditLimit: 200 });
    mockOrderFindMany.mockResolvedValue([
      { total: 200, amountPaid: 0 },
    ]);
    // outstanding (200) is NOT > creditLimit + EPSILON (200.01)
    const result = await isCreditLimitExceeded(makeTx() as never, "user-1");
    expect(result.exceeded).toBe(false);
  });

  it("returns exceeded:true when outstanding exceeds the credit limit by more than epsilon", async () => {
    mockBalanceFindUnique.mockResolvedValue({ creditLimit: 200 });
    mockOrderFindMany.mockResolvedValue([
      { total: 300, amountPaid: 0 }, // outstanding: 300, limit: 200
    ]);
    const result = await isCreditLimitExceeded(makeTx() as never, "user-1");
    expect(result.exceeded).toBe(true);
    expect(result.outstanding).toBe(300);
    expect(result.creditLimit).toBe(200);
  });

  it("respects epsilon: outstanding at limit + 0.005 does NOT exceed (within epsilon)", async () => {
    mockBalanceFindUnique.mockResolvedValue({ creditLimit: 200 });
    mockOrderFindMany.mockResolvedValue([
      { total: 200.005, amountPaid: 0 }, // outstanding ≈ 200.005, limit + epsilon = 200.01
    ]);
    const result = await isCreditLimitExceeded(makeTx() as never, "user-1");
    // 200.005 <= 200.01 (limit + epsilon), so NOT exceeded
    expect(result.exceeded).toBe(false);
  });
});
