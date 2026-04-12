import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockRateLimit,
  mockPurchaseFindUnique,
  mockPurchaseUpdate,
  mockRecordAuditLog,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockAssertSameOrigin: vi.fn(),
  mockRateLimit: vi.fn(),
  mockPurchaseFindUnique: vi.fn(),
  mockPurchaseUpdate: vi.fn(),
  mockRecordAuditLog: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/origin", () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mockRateLimit }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: mockRecordAuditLog }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    purchase: {
      findUnique: mockPurchaseFindUnique,
      update: mockPurchaseUpdate,
    },
  },
}));

import { POST } from "./route";

const ADMIN_SESSION = { user: { id: "u1", role: "ADMIN" } };

function makeRequest(id = "purchase-1") {
  return [
    new Request(`http://localhost:3000/api/admin/purchases/${id}/approve`, {
      method: "POST",
      headers: { origin: "http://localhost:3000" },
    }),
    { params: Promise.resolve({ id }) },
  ] as const;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
  mockAssertSameOrigin.mockReturnValue(true);
  mockRateLimit.mockResolvedValue({ ok: true });
});

describe("POST /api/admin/purchases/[id]/approve", () => {
  it("records enriched audit metadata on success", async () => {
    mockPurchaseFindUnique.mockResolvedValue({
      id: "purchase-1",
      status: "PENDING_APPROVAL",
      supplierId: "sup-1",
      supplier: "MedSupply Ltd",
      productId: "prod-1",
      orderedQuantity: 10,
      quantity: 10,
      unitCost: 5,
      expectedAt: new Date("2026-04-10T00:00:00.000Z"),
      product: { name: "Sterile Gloves", sku: "SG-001" },
    });
    mockPurchaseUpdate.mockResolvedValue({
      id: "purchase-1",
      status: "APPROVED",
      approvedAt: new Date("2026-04-08T12:00:00.000Z"),
    });

    const res = await POST(...makeRequest());

    expect(res.status).toBe(200);
    expect(mockRecordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "PURCHASE_APPROVE",
        entityId: "purchase-1",
        meta: expect.objectContaining({
          productId: "prod-1",
          productName: "Sterile Gloves",
          productSku: "SG-001",
          supplierId: "sup-1",
          quantity: 10,
          amount: 50,
          expectedAt: "2026-04-10T00:00:00.000Z",
          approvedById: "u1",
          source: "PURCHASE_APPROVE",
        }),
      }),
    );
  });
});
