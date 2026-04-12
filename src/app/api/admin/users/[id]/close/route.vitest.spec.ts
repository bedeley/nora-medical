import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockRateLimit,
  mockRecordAuditLog,
  mockUserFindUnique,
  mockOrderCount,
  mockPaymentCount,
  mockCartFindUnique,
  mockCartFindMany,
  mockCartItemDeleteMany,
  mockCartDeleteMany,
  mockSavedCartItemCount,
  mockBalanceFindUnique,
  mockBalanceDeleteMany,
  mockUserOtpDeleteMany,
  mockUserUpdate,
  mockTransaction,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockAssertSameOrigin: vi.fn(),
  mockRateLimit: vi.fn(),
  mockRecordAuditLog: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockOrderCount: vi.fn(),
  mockPaymentCount: vi.fn(),
  mockCartFindUnique: vi.fn(),
  mockCartFindMany: vi.fn(),
  mockCartItemDeleteMany: vi.fn(),
  mockCartDeleteMany: vi.fn(),
  mockSavedCartItemCount: vi.fn(),
  mockBalanceFindUnique: vi.fn(),
  mockBalanceDeleteMany: vi.fn(),
  mockUserOtpDeleteMany: vi.fn(),
  mockUserUpdate: vi.fn(),
  mockTransaction: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/origin", () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mockRateLimit }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: mockRecordAuditLog }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: mockUserFindUnique,
      update: mockUserUpdate,
    },
    order: { count: mockOrderCount },
    payment: { count: mockPaymentCount },
    cart: {
      findUnique: mockCartFindUnique,
      findMany: mockCartFindMany,
      deleteMany: mockCartDeleteMany,
    },
    cartItem: { deleteMany: mockCartItemDeleteMany },
    savedCartItem: { count: mockSavedCartItemCount },
    balance: {
      findUnique: mockBalanceFindUnique,
      deleteMany: mockBalanceDeleteMany,
    },
    userOtp: { deleteMany: mockUserOtpDeleteMany },
    $transaction: mockTransaction,
  },
}));

import { POST } from "./route";

function request(body: Record<string, unknown> = { reason: "Duplicate account", sourcePage: "admin/customers" }) {
  return new Request("http://localhost/api/admin/users/cust-1/close", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "http://localhost" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/admin/users/[id]/close", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetServerSession.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
    mockAssertSameOrigin.mockReturnValue(true);
    mockRateLimit.mockResolvedValue({ ok: true });
    mockUserFindUnique.mockResolvedValue({
      id: "cust-1",
      email: "alice@example.com",
      name: "Alice Clinic",
      role: "CUSTOMER",
      archived: false,
    });
    mockOrderCount.mockResolvedValue(0);
    mockPaymentCount.mockResolvedValue(0);
    mockCartFindUnique.mockResolvedValue(null);
    mockSavedCartItemCount.mockResolvedValue(0);
    mockBalanceFindUnique.mockResolvedValue(null);
    mockCartFindMany.mockResolvedValue([]);
    mockTransaction.mockImplementation(async (fn) =>
      fn({
        cart: { findMany: mockCartFindMany, deleteMany: mockCartDeleteMany },
        cartItem: { deleteMany: mockCartItemDeleteMany },
        userOtp: { deleteMany: mockUserOtpDeleteMany },
        balance: { deleteMany: mockBalanceDeleteMany },
        user: { update: mockUserUpdate },
      }),
    );
  });

  it("allows only ADMIN to close accounts", async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: "acct-1", role: "ACCOUNTANT" } });

    const res = await POST(request(), { params: { id: "cust-1" } });

    expect(res.status).toBe(403);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("blocks accounts with customer history and writes a denied audit event", async () => {
    mockOrderCount.mockResolvedValue(2);
    mockPaymentCount.mockResolvedValue(1);
    mockBalanceFindUnique.mockResolvedValue({
      totalDue: 100,
      totalPaid: 50,
      balance: 50,
      creditLimit: 200,
    });

    const res = await POST(request(), { params: { id: "cust-1" } });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.blockers).toEqual(expect.arrayContaining(["orders", "payments", "balance"]));
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockRecordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "USER_CLOSE_DENIED",
        outcome: "FAILED",
        meta: expect.objectContaining({
          actorRole: "ADMIN",
          targetUserId: "cust-1",
          targetUserRole: "CUSTOMER",
          sourcePage: "admin/customers",
          blockers: expect.arrayContaining(["orders", "payments", "balance"]),
        }),
      }),
    );
  });

  it("soft closes an unused customer account and writes audit metadata", async () => {
    const res = await POST(request({ reason: "Duplicate account", sourcePage: "admin/customers" }), {
      params: { id: "cust-1" },
    });

    expect(res.status).toBe(204);
    expect(mockUserUpdate).toHaveBeenCalledWith({
      where: { id: "cust-1" },
      data: { deletedAt: expect.any(Date), archived: true },
    });
    expect(mockRecordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "USER_CLOSE",
        entityType: "USER",
        entityId: "cust-1",
        meta: expect.objectContaining({
          actorRole: "ADMIN",
          targetUserRole: "CUSTOMER",
          reason: "Duplicate account",
          sourcePage: "admin/customers",
        }),
      }),
    );
  });
});
