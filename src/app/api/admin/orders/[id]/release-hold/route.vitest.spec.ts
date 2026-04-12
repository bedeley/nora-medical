import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockRateLimit,
  mockIsCreditLimitExceeded,
  mockRecordAuditLog,
  mockTransaction,
  mockTxOrderFindUnique,
  mockTxOrderUpdate,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockAssertSameOrigin: vi.fn(),
  mockRateLimit: vi.fn(),
  mockIsCreditLimitExceeded: vi.fn(),
  mockRecordAuditLog: vi.fn(),
  mockTransaction: vi.fn(),
  mockTxOrderFindUnique: vi.fn(),
  mockTxOrderUpdate: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/origin", () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mockRateLimit }));
vi.mock("@/lib/credit", () => ({
  isCreditLimitExceeded: mockIsCreditLimitExceeded,
}));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: mockRecordAuditLog }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
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
  return new Request("http://localhost:3000/api/admin/orders/order-1/release-hold", {
    method: "POST",
    headers: {
      origin: "http://localhost:3000",
      "Content-Type": "application/json",
      "x-request-id": "req-release-1",
    },
    body: JSON.stringify({ force: true, note: "Collections cleared" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
  mockAssertSameOrigin.mockReturnValue(true);
  mockRateLimit.mockResolvedValue({ ok: true });
  mockIsCreditLimitExceeded.mockResolvedValue({
    exceeded: false,
    creditLimit: 500,
    outstanding: 120,
  });
  mockTxOrderFindUnique.mockResolvedValue({
    id: "order-1",
    userId: "customer-1",
    invoiceNumber: "INV-1001",
    status: "ON_HOLD_CREDIT",
    total: 200,
    amountPaid: 80,
    balance: 120,
    user: {
      name: "Alice Clinic",
      email: "alice@example.com",
    },
  });
  mockTxOrderUpdate.mockResolvedValue({
    id: "order-1",
    status: "PARTIALLY_PAID",
  });
  mockTransaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
    callback({
      order: {
        findUnique: mockTxOrderFindUnique,
        update: mockTxOrderUpdate,
      },
    }),
  );
});

describe("POST /api/admin/orders/[id]/release-hold", () => {
  it("audits released credit holds with order and customer context", async () => {
    const res = await POST(makeRequest(), {
      params: Promise.resolve({ id: "order-1" }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      status: "PARTIALLY_PAID",
    });
    expect(mockRecordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ORDER_RELEASE_CREDIT_HOLD",
        entityType: "ORDER",
        entityId: "order-1",
        meta: expect.objectContaining({
          sourcePage: "/admin/orders/[id]",
          sourceRoute: "/api/admin/orders/order-1/release-hold",
          previousStatus: "ON_HOLD_CREDIT",
          newStatus: "PARTIALLY_PAID",
          invoiceNumber: "INV-1001",
          customerId: "customer-1",
          customerName: "Alice Clinic",
          customerEmail: "alice@example.com",
          forced: true,
          note: "Collections cleared",
          creditLimit: 500,
          outstanding: 120,
        }),
      }),
    );
  });
});
