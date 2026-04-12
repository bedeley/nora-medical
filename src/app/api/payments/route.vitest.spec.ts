import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mock state ────────────────────────────────────────────────────
const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockRateLimit,
  mockPrismaUserFindUnique,
  mockPrismaOrderFindUnique,
  mockPrismaTransaction,
  mockRecordAuditLog,
  mockNotifyPaymentEvent,
  mockPostPaymentEntry,
  mockRecomputeOrderTotalsFromPayments,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockAssertSameOrigin: vi.fn(),
  mockRateLimit: vi.fn(),
  mockPrismaUserFindUnique: vi.fn(),
  mockPrismaOrderFindUnique: vi.fn(),
  mockPrismaTransaction: vi.fn(),
  mockRecordAuditLog: vi.fn(),
  mockNotifyPaymentEvent: vi.fn(),
  mockPostPaymentEntry: vi.fn(),
  mockRecomputeOrderTotalsFromPayments: vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────
vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/origin", () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mockRateLimit }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: mockRecordAuditLog }));
vi.mock("@/lib/notifications", () => ({ notifyPaymentEvent: mockNotifyPaymentEvent }));
vi.mock("@/lib/accounting-posting", () => ({ postPaymentEntry: mockPostPaymentEntry }));
vi.mock("@/lib/payments", () => ({ recomputeOrderTotalsFromPayments: mockRecomputeOrderTotalsFromPayments }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: mockPrismaUserFindUnique },
    order: { findUnique: mockPrismaOrderFindUnique },
    $transaction: mockPrismaTransaction,
  },
}));

// ── Import after mocks ────────────────────────────────────────────────────
import { POST } from "./route";

// ── Helpers ───────────────────────────────────────────────────────────────
const ADMIN_SESSION = { user: { id: "u1", role: "ADMIN", name: "Admin", email: "admin@example.com" } };
const ACCOUNTANT_SESSION = { user: { id: "u4", role: "ACCOUNTANT", name: "AC", email: "ac@example.com" } };
const STAFF_SESSION = { user: { id: "u2", role: "STAFF" } };
const CUSTOMER_SESSION = { user: { id: "u3", role: "CUSTOMER" } };

function makeRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/payments", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify(body),
  });
}

const validPayment = {
  userId: "customer-1",
  orderId: "order-1",
  amount: 100,
  method: "cash",
};

const mockCustomer = {
  id: "customer-1",
  role: "CUSTOMER",
  name: "Test Customer",
  email: "test@example.com",
  phone: null,
};

const mockOrder = {
  id: "order-1",
  userId: "customer-1",
  total: 100,
  amountPaid: 0,
  status: "UNPAID",
};

// Transaction result shape
const mockPaymentResult = {
  payment: { id: "pay-1", orderId: "order-1" },
  payments: [{ id: "pay-1", orderId: "order-1" }],
  applied: [{ orderId: "order-1", applied: 100, newAmountPaid: 100, newBalance: 0, newStatus: "PAID" }],
  credit: null,
  batchId: "batch-1",
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Auth guard ────────────────────────────────────────────────────────────

describe("POST /api/payments – auth guard", () => {
  it("returns 403 when no session", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await POST(makeRequest(validPayment));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Forbidden");
  });

  it("returns 403 when role is STAFF", async () => {
    mockGetServerSession.mockResolvedValue(STAFF_SESSION);
    const res = await POST(makeRequest(validPayment));
    expect(res.status).toBe(403);
  });

  it("returns 403 when role is CUSTOMER", async () => {
    mockGetServerSession.mockResolvedValue(CUSTOMER_SESSION);
    const res = await POST(makeRequest(validPayment));
    expect(res.status).toBe(403);
  });

  it("passes auth for ADMIN role", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockAssertSameOrigin.mockReturnValue(true);
    mockRateLimit.mockResolvedValue({ ok: true });
    mockPrismaUserFindUnique.mockResolvedValue(mockCustomer);
    mockPrismaOrderFindUnique.mockResolvedValue(mockOrder);
    mockPrismaTransaction.mockResolvedValue(mockPaymentResult);
    const res = await POST(makeRequest(validPayment));
    expect(res.status).not.toBe(403);
  });

  it("passes auth for ACCOUNTANT role", async () => {
    mockGetServerSession.mockResolvedValue(ACCOUNTANT_SESSION);
    mockAssertSameOrigin.mockReturnValue(true);
    mockRateLimit.mockResolvedValue({ ok: true });
    mockPrismaUserFindUnique.mockResolvedValue(mockCustomer);
    mockPrismaOrderFindUnique.mockResolvedValue(mockOrder);
    mockPrismaTransaction.mockResolvedValue(mockPaymentResult);
    const res = await POST(makeRequest(validPayment));
    expect(res.status).not.toBe(403);
  });
});

// ── CSRF / rate-limit ─────────────────────────────────────────────────────

describe("POST /api/payments – CSRF & rate limit", () => {
  it("returns 403 when assertSameOrigin returns false", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockAssertSameOrigin.mockReturnValue(false);
    const res = await POST(makeRequest(validPayment));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Bad origin");
  });

  it("returns 429 when rate limit exceeded", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockAssertSameOrigin.mockReturnValue(true);
    mockRateLimit.mockResolvedValue({ ok: false });
    const res = await POST(makeRequest(validPayment));
    expect(res.status).toBe(429);
  });
});

// ── Schema validation ─────────────────────────────────────────────────────

describe("POST /api/payments – schema validation", () => {
  beforeEach(() => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockAssertSameOrigin.mockReturnValue(true);
    mockRateLimit.mockResolvedValue({ ok: true });
  });

  it("returns 400 when userId is missing", async () => {
    const res = await POST(makeRequest({ amount: 100, method: "cash" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid payment payload");
  });

  it("returns 400 when amount is zero (schema refine)", async () => {
    const res = await POST(makeRequest({ userId: "u1", amount: 0, method: "cash" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid payment payload");
  });

  it("returns 400 when refund status has no refundDisposition", async () => {
    const res = await POST(makeRequest({ userId: "u1", amount: -50, status: "refund" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid payment payload");
  });

  it("returns 400 when refund/void has no note (too short)", async () => {
    const res = await POST(makeRequest({
      userId: "u1",
      amount: -50,
      status: "refund",
      refundDisposition: "cash",
      note: "ab",  // less than 5 chars
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid payment payload");
  });
});

// ── Business logic guards ─────────────────────────────────────────────────

describe("POST /api/payments – business logic guards", () => {
  beforeEach(() => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockAssertSameOrigin.mockReturnValue(true);
    mockRateLimit.mockResolvedValue({ ok: true });
  });

  it("returns 400 when status value is not a recognized enum", async () => {
    // paymentSchema only accepts normal/refund/void — an uppercase invalid value
    // passes schema (enum is case-insensitive in route code), but bad value returns 400
    mockPrismaUserFindUnique.mockResolvedValue(mockCustomer);
    const res = await POST(makeRequest({ userId: "customer-1", amount: 100, status: "invalid_status" }));
    // Schema will reject unknown status enum value
    expect(res.status).toBe(400);
  });

  it("returns 404 when user does not exist", async () => {
    mockPrismaUserFindUnique.mockResolvedValue(null);
    const res = await POST(makeRequest(validPayment));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/user not found/i);
  });

  it("returns 404 when order does not exist", async () => {
    mockPrismaUserFindUnique.mockResolvedValue(mockCustomer);
    mockPrismaOrderFindUnique.mockResolvedValue(null);
    const res = await POST(makeRequest(validPayment));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/order not found/i);
  });

  it("returns 400 when order does not belong to user", async () => {
    mockPrismaUserFindUnique.mockResolvedValue(mockCustomer);
    mockPrismaOrderFindUnique.mockResolvedValue({ ...mockOrder, userId: "different-user" });
    const res = await POST(makeRequest(validPayment));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/does not belong/i);
  });

  it("returns 400 when amount is 0 (post-schema guard)", async () => {
    mockPrismaUserFindUnique.mockResolvedValue(mockCustomer);
    mockPrismaOrderFindUnique.mockResolvedValue(mockOrder);
    const res = await POST(makeRequest({ ...validPayment, amount: 0 }));
    // Schema rejects amount=0 before hitting this guard
    expect(res.status).toBe(400);
  });

  it("returns 400 when positive amount is <= 0", async () => {
    mockPrismaUserFindUnique.mockResolvedValue(mockCustomer);
    mockPrismaOrderFindUnique.mockResolvedValue(mockOrder);
    const res = await POST(makeRequest({ ...validPayment, amount: -10 }));
    // Negative amount without refund status triggers the "Amount must be greater than zero" guard
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/greater than zero/i);
  });

  it("returns 400 when refund given without an orderId", async () => {
    mockPrismaUserFindUnique.mockResolvedValue(mockCustomer);
    // No orderId in payload
    const res = await POST(makeRequest({
      userId: "customer-1",
      amount: 50,
      status: "refund",
      refundDisposition: "cash",
      note: "Customer returned item",
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/select an order/i);
  });

  it("returns 200 on successful payment", async () => {
    mockPrismaUserFindUnique.mockResolvedValue(mockCustomer);
    mockPrismaOrderFindUnique.mockResolvedValue(mockOrder);
    mockPrismaTransaction.mockResolvedValue(mockPaymentResult);
    const res = await POST(makeRequest(validPayment));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.payment?.id).toBe("pay-1");
    expect(body.applied?.[0]?.newStatus).toBe("PAID");
  });

  it("issues store credit without applying it to open orders", async () => {
    const txOrderFindMany = vi
      .fn()
      .mockResolvedValueOnce([{ total: 100, amountPaid: 0 }])
      .mockResolvedValueOnce([{ total: 100, amountPaid: 0 }]);
    const txPaymentCreate = vi.fn().mockResolvedValue({ id: "credit-pay-1", orderId: null });
    const tx = {
      order: {
        findMany: txOrderFindMany,
        findUnique: vi.fn(),
      },
      payment: {
        create: txPaymentCreate,
        update: vi.fn(),
      },
    };
    mockPrismaUserFindUnique.mockResolvedValue(mockCustomer);
    mockPrismaTransaction.mockImplementation(async (callback: (arg: unknown) => Promise<unknown>) =>
      callback(tx),
    );

    const res = await POST(makeRequest({
      userId: "customer-1",
      amount: 25,
      method: "adjustment",
      status: "normal",
      refundDisposition: "credit",
      location: "admin/customers:actions-adjustment",
      note: "Billing correction",
    }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      payment: { id: "credit-pay-1", orderId: null },
      applied: [],
    });
    expect(txPaymentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orderId: null,
          amount: 25,
          status: "NORMAL",
          refundDisposition: "CREDIT",
        }),
      }),
    );
    expect(mockRecomputeOrderTotalsFromPayments).not.toHaveBeenCalled();
    expect(mockNotifyPaymentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "store_credit_issued",
        userId: "customer-1",
        amount: 25,
      }),
    );
    expect(mockRecordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "STORE_CREDIT_ISSUE",
        entityType: "PAYMENT",
        meta: expect.objectContaining({
          customerId: "customer-1",
          storeCreditIssued: 25,
          appliedCount: 0,
        }),
      }),
    );
  });

  it("requires admin approval before issuing store credit on an employee-owned account", async () => {
    mockGetServerSession.mockResolvedValue(ACCOUNTANT_SESSION);
    mockAssertSameOrigin.mockReturnValue(true);
    mockRateLimit.mockResolvedValue({ ok: true });
    mockPrismaUserFindUnique.mockResolvedValue({
      ...mockCustomer,
      id: "admin-customer-1",
      role: "ADMIN",
    });

    const res = await POST(makeRequest({
      userId: "admin-customer-1",
      amount: 25,
      method: "adjustment",
      status: "normal",
      refundDisposition: "credit",
      location: "admin/customers:actions-adjustment",
      note: "Billing correction",
    }));

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringMatching(/admin approval/i),
    });
    expect(mockPrismaTransaction).not.toHaveBeenCalled();
    expect(mockRecordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "STORE_CREDIT_ISSUE_DENIED",
        entityType: "USER",
        entityId: "admin-customer-1",
        outcome: "FAILED",
        meta: expect.objectContaining({
          actorRole: "ACCOUNTANT",
          targetCustomerRole: "ADMIN",
          isEmployeeCustomer: true,
          reason: "ADMIN_APPROVAL_REQUIRED_FOR_EMPLOYEE_CUSTOMER",
        }),
      }),
    );
  });
});
