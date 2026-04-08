import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mock state ────────────────────────────────────────────────────
const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockPrismaTransaction,
  mockPostPaymentEntry,
  mockRecomputeOrderTotalsFromPayments,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockAssertSameOrigin: vi.fn(),
  mockPrismaTransaction: vi.fn(),
  mockPostPaymentEntry: vi.fn(),
  mockRecomputeOrderTotalsFromPayments: vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────
vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/origin", () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/accounting-posting", () => ({ postPaymentEntry: mockPostPaymentEntry }));
vi.mock("@/lib/payments", () => ({
  recomputeOrderTotalsFromPayments: mockRecomputeOrderTotalsFromPayments,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mockPrismaTransaction,
  },
}));

// ── Import after mocks ────────────────────────────────────────────────────
import { POST } from "./route";

// ── Helpers ───────────────────────────────────────────────────────────────
const CUSTOMER_SESSION = {
  user: { id: "customer-1", role: "CUSTOMER", email: "cust@example.com" },
};
const ADMIN_SESSION = {
  user: { id: "u1", role: "ADMIN", email: "admin@example.com" },
};

function makeRequest(): Request {
  return new Request("http://localhost:3000/api/account/credit/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({}),
  });
}

// Transaction result when credit is available and balance exists
const txResultWithCredit = {
  applied: 50,
  remainingBalance: 50,
  remainingCredit: 0,
  createdPaymentIds: ["pay-new-1"],
};

// Transaction result when balance is already zero
const txResultNoBalance = {
  applied: 0,
  remainingBalance: 0,
  remainingCredit: 25,
  createdPaymentIds: [],
};

// Transaction result when no credit available
const txResultNoCredit = {
  applied: 0,
  remainingBalance: 100,
  remainingCredit: 0,
  createdPaymentIds: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAssertSameOrigin.mockReturnValue(true);
  mockPostPaymentEntry.mockResolvedValue(undefined);
});

// ── CSRF guard ─────────────────────────────────────────────────────────────

describe("POST /api/account/credit/apply – CSRF guard", () => {
  it("returns 403 when assertSameOrigin returns false", async () => {
    mockAssertSameOrigin.mockReturnValue(false);
    mockGetServerSession.mockResolvedValue(CUSTOMER_SESSION);
    const res = await POST(makeRequest());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Bad origin");
  });
});

// ── Auth guard ─────────────────────────────────────────────────────────────

describe("POST /api/account/credit/apply – auth guard", () => {
  it("returns 401 when no session", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
  });
});

// ── Business logic – no credit / no balance ────────────────────────────────

describe("POST /api/account/credit/apply – no-op cases", () => {
  beforeEach(() => {
    mockGetServerSession.mockResolvedValue(CUSTOMER_SESSION);
  });

  it("returns applied=0 when customer has no outstanding balance", async () => {
    mockPrismaTransaction.mockResolvedValue(txResultNoBalance);
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toBe(0);
    expect(body.remainingBalance).toBe(0);
    expect(body.remainingCredit).toBe(25);
  });

  it("returns applied=0 when customer has no store credit", async () => {
    mockPrismaTransaction.mockResolvedValue(txResultNoCredit);
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toBe(0);
    expect(body.remainingBalance).toBe(100);
    expect(body.remainingCredit).toBe(0);
  });

  it("does not call postPaymentEntry when no payments were created", async () => {
    mockPrismaTransaction.mockResolvedValue(txResultNoBalance);
    await POST(makeRequest());
    expect(mockPostPaymentEntry).not.toHaveBeenCalled();
  });
});

// ── Business logic – credit applied ───────────────────────────────────────

describe("POST /api/account/credit/apply – credit applied", () => {
  beforeEach(() => {
    mockGetServerSession.mockResolvedValue(CUSTOMER_SESSION);
  });

  it("returns applied amount and remaining balances on success", async () => {
    mockPrismaTransaction.mockResolvedValue(txResultWithCredit);
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toBe(50);
    expect(body.remainingBalance).toBe(50);
    expect(body.remainingCredit).toBe(0);
  });

  it("calls postPaymentEntry for each created payment", async () => {
    mockPrismaTransaction.mockResolvedValue({
      ...txResultWithCredit,
      createdPaymentIds: ["pay-new-1", "pay-new-2"],
    });
    await POST(makeRequest());
    expect(mockPostPaymentEntry).toHaveBeenCalledTimes(2);
    expect(mockPostPaymentEntry).toHaveBeenCalledWith({ paymentId: "pay-new-1" });
    expect(mockPostPaymentEntry).toHaveBeenCalledWith({ paymentId: "pay-new-2" });
  });

  it("works for ADMIN role as well as CUSTOMER", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockPrismaTransaction.mockResolvedValue(txResultWithCredit);
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
  });
});

// ── Error handling ─────────────────────────────────────────────────────────

describe("POST /api/account/credit/apply – error handling", () => {
  it("returns 500 when transaction throws", async () => {
    mockGetServerSession.mockResolvedValue(CUSTOMER_SESSION);
    mockPrismaTransaction.mockRejectedValue(new Error("DB connection failed"));
    const res = await POST(makeRequest());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/failed to apply/i);
  });
});
