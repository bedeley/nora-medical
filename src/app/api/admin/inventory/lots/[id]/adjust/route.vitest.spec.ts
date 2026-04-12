import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockInventoryLotFindUnique,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockAssertSameOrigin: vi.fn(),
  mockInventoryLotFindUnique: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/origin", () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/inventory-lots", () => ({ applyLotAdjustment: vi.fn() }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    inventoryLot: {
      findUnique: mockInventoryLotFindUnique,
    },
    $transaction: vi.fn(),
  },
}));

import { POST } from "./route";

const adminSession = {
  user: { id: "admin-1", role: "ADMIN", email: "admin@example.com" },
};

function makeRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/admin/inventory/lots/lot-1/adjust", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/admin/inventory/lots/[id]/adjust", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertSameOrigin.mockReturnValue(true);
    mockGetServerSession.mockResolvedValue(adminSession);
    mockInventoryLotFindUnique.mockResolvedValue(null);
  });

  it("returns 400 when quantityRemaining is not a whole number", async () => {
    const res = await POST(makeRequest({ quantityRemaining: 10.5, reason: "Damaged" }), {
      params: Promise.resolve({ id: "lot-1" }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Quantity must be a whole number" });
    expect(mockInventoryLotFindUnique).not.toHaveBeenCalled();
  });
});
