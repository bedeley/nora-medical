import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockBalanceFindUnique,
  mockUserFindUnique,
  mockBalanceUpsert,
  mockRecordAuditLog,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockAssertSameOrigin: vi.fn(),
  mockBalanceFindUnique: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockBalanceUpsert: vi.fn(),
  mockRecordAuditLog: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/origin", () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: mockRecordAuditLog }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    balance: {
      findUnique: mockBalanceFindUnique,
      upsert: mockBalanceUpsert,
    },
    user: { findUnique: mockUserFindUnique },
  },
}));

import { PUT } from "./route";

function makeRequest() {
  return new Request("http://localhost:3000/api/admin/customers/admin-1/credit-limit", {
    method: "PUT",
    headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({ creditLimit: 500 }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAssertSameOrigin.mockReturnValue(true);
  mockBalanceFindUnique.mockResolvedValue({ creditLimit: 100 });
  mockUserFindUnique.mockResolvedValue({
    id: "admin-1",
    name: "Admin Customer",
    email: "admin@example.com",
    role: "ADMIN",
  });
  mockBalanceUpsert.mockResolvedValue({ userId: "admin-1", creditLimit: 500 });
});

describe("PUT /api/admin/customers/[id]/credit-limit", () => {
  it("blocks non-admin credit-limit changes", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { id: "accountant-1", role: "ACCOUNTANT" },
    });

    const res = await PUT(makeRequest(), {
      params: Promise.resolve({ id: "admin-1" }),
    });

    expect(res.status).toBe(401);
    expect(mockBalanceUpsert).not.toHaveBeenCalled();
  });

  it("allows an admin to approve a credit-limit change on their own employee account and audits it", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN", name: "Admin Customer", email: "admin@example.com" },
    });

    const res = await PUT(makeRequest(), {
      params: Promise.resolve({ id: "admin-1" }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      creditLimit: 500,
    });
    expect(mockRecordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "CUSTOMER_CREDIT_LIMIT_UPDATE",
        entityType: "USER",
        entityId: "admin-1",
        outcome: "SUCCESS",
        meta: expect.objectContaining({
          actorRole: "ADMIN",
          targetCustomerRole: "ADMIN",
          isEmployeeCustomer: true,
          isSelfServiceAction: true,
          previousLimit: 100,
          newLimit: 500,
        }),
      }),
    );
  });
});

