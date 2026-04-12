import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockRateLimit,
  mockPaymentFindMany,
  mockUserFindUnique,
  mockPaymentCreate,
  mockRecordAuditLog,
  mockNotifyPaymentEvent,
  mockPostStoreCreditPayoutEntry,
  mockIsFeatureEnabled,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockAssertSameOrigin: vi.fn(),
  mockRateLimit: vi.fn(),
  mockPaymentFindMany: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockPaymentCreate: vi.fn(),
  mockRecordAuditLog: vi.fn(),
  mockNotifyPaymentEvent: vi.fn(),
  mockPostStoreCreditPayoutEntry: vi.fn(),
  mockIsFeatureEnabled: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/origin", () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mockRateLimit }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: mockRecordAuditLog }));
vi.mock("@/lib/notifications", () => ({ notifyPaymentEvent: mockNotifyPaymentEvent }));
vi.mock("@/lib/accounting-posting", () => ({ postStoreCreditPayoutEntry: mockPostStoreCreditPayoutEntry }));
vi.mock("@/lib/features", () => ({ isFeatureEnabled: mockIsFeatureEnabled }));
vi.mock("@/lib/momo", () => ({ initiateMomoPayout: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    payment: {
      findMany: mockPaymentFindMany,
      create: mockPaymentCreate,
    },
    user: { findUnique: mockUserFindUnique },
  },
}));

import { POST } from "./route";

function makeRequest() {
  return new Request("http://localhost:3000/api/admin/customers/employee-1/refund-credit", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify({
      amount: 10,
      method: "cash",
      note: "Refund employee credit",
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAssertSameOrigin.mockReturnValue(true);
  mockRateLimit.mockResolvedValue({ ok: true });
  mockIsFeatureEnabled.mockResolvedValue(false);
  mockPaymentFindMany.mockResolvedValue([
    {
      amount: 25,
      status: "NORMAL",
      refundDisposition: "CREDIT",
      note: "{}",
    },
  ]);
  mockUserFindUnique.mockResolvedValue({
    id: "employee-1",
    name: "Employee Customer",
    email: "employee@example.com",
    role: "ADMIN",
  });
});

describe("POST /api/admin/customers/[id]/refund-credit", () => {
  it("requires admin approval before refunding store credit on an employee-owned account", async () => {
    mockGetServerSession.mockResolvedValue({
      user: { id: "accountant-1", role: "ACCOUNTANT", name: "Accountant", email: "accountant@example.com" },
    });

    const res = await POST(makeRequest(), {
      params: Promise.resolve({ id: "employee-1" }),
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringMatching(/admin approval/i),
    });
    expect(mockPaymentCreate).not.toHaveBeenCalled();
    expect(mockRecordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "STORE_CREDIT_REFUND_DENIED",
        entityType: "USER",
        entityId: "employee-1",
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

