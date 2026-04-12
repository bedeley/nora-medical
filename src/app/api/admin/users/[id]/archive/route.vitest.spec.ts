import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockRateLimit,
  mockRecordAuditLog,
  mockUserFindUnique,
  mockUserUpdate,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockAssertSameOrigin: vi.fn(),
  mockRateLimit: vi.fn(),
  mockRecordAuditLog: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockUserUpdate: vi.fn(),
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
  },
}));

import { PATCH } from "./route";

function request(body: Record<string, unknown>) {
  return new Request("http://localhost/api/admin/users/cust-1/archive", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", origin: "http://localhost" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/admin/users/[id]/archive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetServerSession.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
    mockAssertSameOrigin.mockReturnValue(true);
    mockRateLimit.mockResolvedValue({ ok: true });
    mockUserFindUnique.mockResolvedValue({
      id: "cust-1",
      email: "alice@example.com",
      role: "CUSTOMER",
      archived: false,
    });
    mockUserUpdate.mockResolvedValue({
      id: "cust-1",
      email: "alice@example.com",
      archived: true,
    });
  });

  it("writes actor, target, reason, and source metadata when archiving", async () => {
    const res = await PATCH(
      request({
        archived: true,
        reason: "No longer active",
        sourcePage: "admin/customers",
      }),
      { params: { id: "cust-1" } },
    );

    expect(res.status).toBe(200);
    expect(mockUserUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cust-1" },
        data: { archived: true },
      }),
    );
    expect(mockRecordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "USER_ARCHIVE",
        entityType: "USER",
        entityId: "cust-1",
        meta: expect.objectContaining({
          actorId: "admin-1",
          actorRole: "ADMIN",
          targetUserId: "cust-1",
          targetUserRole: "CUSTOMER",
          reason: "No longer active",
          sourcePage: "admin/customers",
        }),
      }),
    );
  });
});
