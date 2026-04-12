import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockRateLimit,
  mockPostPaymentEntry,
  mockRecordAuditLog,
  mockUserFindUnique,
  mockRecomputeOrderTotalsFromPayments,
  mockTransaction,
  mockTxUserFindUnique,
  mockTxOrderFindMany,
  mockTxPaymentFindMany,
  mockTxPaymentCreate,
  mockTxPaymentUpdate,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockAssertSameOrigin: vi.fn(),
  mockRateLimit: vi.fn(),
  mockPostPaymentEntry: vi.fn(),
  mockRecordAuditLog: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockRecomputeOrderTotalsFromPayments: vi.fn(),
  mockTransaction: vi.fn(),
  mockTxUserFindUnique: vi.fn(),
  mockTxOrderFindMany: vi.fn(),
  mockTxPaymentFindMany: vi.fn(),
  mockTxPaymentCreate: vi.fn(),
  mockTxPaymentUpdate: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/origin", () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mockRateLimit }));
vi.mock("@/lib/accounting-posting", () => ({ postPaymentEntry: mockPostPaymentEntry }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: mockRecordAuditLog }));
vi.mock("@/lib/payments", () => ({
  recomputeOrderTotalsFromPayments: mockRecomputeOrderTotalsFromPayments,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: mockUserFindUnique },
    $transaction: mockTransaction,
  },
}));

import { POST } from "./route";

const ADMIN_SESSION = {
  user: {
    id: "admin-1",
    role: "ADMIN",
    name: "Admin User",
    email: "admin@example.com",
  },
};

function makeRequest() {
  return new Request("http://localhost:3000/api/admin/customers/customer-1/credit/apply", {
    method: "POST",
    headers: {
      origin: "http://localhost:3000",
      "x-request-id": "req-credit-1",
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
  mockAssertSameOrigin.mockReturnValue(true);
  mockRateLimit.mockResolvedValue({ ok: true });
  mockRecomputeOrderTotalsFromPayments.mockResolvedValue({
    id: "order-1",
    amountPaid: 120,
    balance: 0,
    status: "PAID",
  });
  mockUserFindUnique.mockResolvedValue({
    id: "customer-1",
    name: "Alice Clinic",
    email: "alice@example.com",
    role: "CUSTOMER",
  });
  mockTxUserFindUnique.mockResolvedValue({
    id: "customer-1",
    name: "Alice Clinic",
    email: "alice@example.com",
    role: "CUSTOMER",
  });
  mockTxOrderFindMany
    .mockResolvedValueOnce([
      {
        id: "order-1",
        invoiceNumber: "INV-1001",
        total: 120,
        amountPaid: 20,
        createdAt: new Date("2026-04-01T10:00:00.000Z"),
      },
    ])
    .mockResolvedValueOnce([
      {
        total: 120,
        amountPaid: 120,
      },
    ]);
  mockTxPaymentFindMany.mockResolvedValue([
    {
      amount: 100,
      status: "NORMAL",
      refundDisposition: "CREDIT",
      note: "{\"reference\":\"ITEM_RETURN\"}",
    },
  ]);
  mockTxPaymentCreate.mockResolvedValue({ id: "payment-1" });
  mockTxPaymentUpdate.mockResolvedValue({ id: "payment-1" });
  mockTransaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
    callback({
      user: { findUnique: mockTxUserFindUnique },
      order: { findMany: mockTxOrderFindMany },
      payment: {
        findMany: mockTxPaymentFindMany,
        create: mockTxPaymentCreate,
        update: mockTxPaymentUpdate,
      },
    }),
  );
});

describe("POST /api/admin/customers/[id]/credit/apply", () => {
  it("audits the store-credit application and posting failures with rich metadata", async () => {
    mockPostPaymentEntry.mockRejectedValueOnce(new Error("Ledger unavailable"));

    const res = await POST(makeRequest(), {
      params: Promise.resolve({ id: "customer-1" }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      applied: 100,
      remainingBalance: 0,
      remainingCredit: 0,
    });
    expect(mockRecordAuditLog).toHaveBeenCalledTimes(2);
    expect(mockRecordAuditLog).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        action: "STORE_CREDIT_APPLY",
        entityType: "CUSTOMER",
        entityId: "customer-1",
        outcome: "PARTIAL",
        meta: expect.objectContaining({
          sourcePage: "admin/customers",
          sourceRoute: "/api/admin/customers/customer-1/credit/apply",
          targetCustomerRole: "CUSTOMER",
          isEmployeeCustomer: false,
          customerName: "Alice Clinic",
          customerEmail: "alice@example.com",
          appliedAmount: 100,
          creditBefore: 100,
          creditAfter: 0,
          balanceBefore: 100,
          balanceAfter: 0,
          createdPaymentIds: ["payment-1"],
          failedPaymentIds: ["payment-1"],
          allocations: [
            expect.objectContaining({
              orderId: "order-1",
              invoiceNumber: "INV-1001",
              applied: 100,
              newStatus: "PAID",
            }),
          ],
        }),
      }),
    );
    expect(mockRecordAuditLog).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        action: "ACCOUNTING_POST_FAILED",
        entityType: "PAYMENT",
        entityId: "payment-1",
        meta: expect.objectContaining({
          sourcePage: "admin/customers",
          reason: "store_credit_apply",
          error: "Ledger unavailable",
        }),
      }),
    );
  });

  it("requires admin approval before applying store credit on an employee-owned account", async () => {
    mockGetServerSession.mockResolvedValue({
      user: {
        id: "accountant-1",
        role: "ACCOUNTANT",
        name: "Accountant",
        email: "accountant@example.com",
      },
    });
    mockUserFindUnique.mockResolvedValue({
      id: "customer-1",
      name: "Employee Customer",
      email: "employee@example.com",
      role: "ADMIN",
    });

    const res = await POST(makeRequest(), {
      params: Promise.resolve({ id: "customer-1" }),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringMatching(/admin approval/i),
    });
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockRecordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "STORE_CREDIT_APPLY_DENIED",
        entityType: "USER",
        entityId: "customer-1",
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
