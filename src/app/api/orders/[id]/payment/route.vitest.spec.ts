import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockRateLimit,
  mockNotifyPaymentEvent,
  mockRecomputeOrderTotalsFromPayments,
  mockPostPaymentEntry,
  mockRecordAuditLog,
  mockUserFindUnique,
  mockJournalEntryFindFirst,
  mockTransaction,
  mockTxOrderFindUnique,
  mockTxPaymentFindFirst,
  mockTxPaymentCreate,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockAssertSameOrigin: vi.fn(),
  mockRateLimit: vi.fn(),
  mockNotifyPaymentEvent: vi.fn(),
  mockRecomputeOrderTotalsFromPayments: vi.fn(),
  mockPostPaymentEntry: vi.fn(),
  mockRecordAuditLog: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockJournalEntryFindFirst: vi.fn(),
  mockTransaction: vi.fn(),
  mockTxOrderFindUnique: vi.fn(),
  mockTxPaymentFindFirst: vi.fn(),
  mockTxPaymentCreate: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/origin", () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mockRateLimit }));
vi.mock("@/lib/notifications", () => ({ notifyPaymentEvent: mockNotifyPaymentEvent }));
vi.mock("@/lib/payments", () => ({
  recomputeOrderTotalsFromPayments: mockRecomputeOrderTotalsFromPayments,
}));
vi.mock("@/lib/accounting-posting", () => ({ postPaymentEntry: mockPostPaymentEntry }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: mockRecordAuditLog }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mockTransaction,
    user: { findUnique: mockUserFindUnique },
    journalEntry: { findFirst: mockJournalEntryFindFirst },
  },
}));

import { PATCH } from "./route";

const ADMIN_SESSION = {
  user: { id: "admin-1", role: "ADMIN", email: "admin@example.com" },
};

const baseOrder = {
  id: "order-1",
  userId: "customer-1",
  status: "UNPAID",
  balance: 120,
  invoiceNumber: "INV-1001",
};

const recomputedOrder = {
  id: "order-1",
  userId: "customer-1",
  status: "PARTIALLY_PAID",
  balance: 20,
  invoiceNumber: "INV-1001",
};

function makeRequest(
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Request("http://localhost:3000/api/orders/order-1/payment", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      origin: "http://localhost:3000",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
  mockAssertSameOrigin.mockReturnValue(true);
  mockRateLimit.mockResolvedValue({ ok: true });
  mockUserFindUnique.mockResolvedValue({
    name: "Acme Clinic",
    email: "ops@acme.test",
    phone: "0550000000",
  });
  mockJournalEntryFindFirst.mockResolvedValue({ id: "je-1" });
  mockRecomputeOrderTotalsFromPayments.mockResolvedValue(recomputedOrder);
  mockPostPaymentEntry.mockResolvedValue({ id: "je-1" });

  mockTransaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
    callback({
      order: { findUnique: mockTxOrderFindUnique },
      payment: {
        findFirst: mockTxPaymentFindFirst,
        create: mockTxPaymentCreate,
      },
    }),
  );
});

describe("PATCH /api/orders/[id]/payment", () => {
  it("reuses an existing payment when the idempotency key matches", async () => {
    mockTxOrderFindUnique.mockResolvedValue(baseOrder);
    mockTxPaymentFindFirst.mockResolvedValue({ id: "payment-existing" });

    const res = await PATCH(
      makeRequest(
        { amount: 100, method: "cash" },
        { "idempotency-key": "idem-123" },
      ),
      { params: Promise.resolve({ id: "order-1" }) },
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      duplicate: true,
      message: "Payment already recorded.",
    });
    expect(mockTxPaymentCreate).not.toHaveBeenCalled();
    expect(mockNotifyPaymentEvent).not.toHaveBeenCalled();
    expect(mockPostPaymentEntry).not.toHaveBeenCalled();
    expect(mockRecordAuditLog).not.toHaveBeenCalled();
  });

  it("stores idempotency metadata on a newly created payment", async () => {
    mockTxOrderFindUnique.mockResolvedValue(baseOrder);
    mockTxPaymentFindFirst.mockResolvedValue(null);
    mockTxPaymentCreate.mockResolvedValue({ id: "payment-new" });

    const res = await PATCH(
      makeRequest(
        { amount: 100, method: "transfer", note: "BANK-REF-44" },
        { "idempotency-key": "idem-456", "x-request-id": "req-9" },
      ),
      { params: Promise.resolve({ id: "order-1" }) },
    );

    expect(res.status).toBe(200);
    expect(mockTxPaymentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          note: expect.stringContaining('"idempotencyKey":"idem-456"'),
        }),
      }),
    );
    expect(mockNotifyPaymentEvent).toHaveBeenCalledTimes(1);
    expect(mockPostPaymentEntry).toHaveBeenCalledWith({ paymentId: "payment-new" });
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      duplicate: false,
      message: "Payment recorded successfully.",
    });
  });
});
