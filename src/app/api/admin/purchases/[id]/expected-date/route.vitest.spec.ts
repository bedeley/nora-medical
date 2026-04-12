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

function makeRequest(expectedAt: string | null, id = "purchase-1") {
  return [
    new Request(`http://localhost:3000/api/admin/purchases/${id}/expected-date`, {
      method: "POST",
      headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ expectedAt }),
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

describe("POST /api/admin/purchases/[id]/expected-date", () => {
  it("records enriched audit metadata on success", async () => {
    mockPurchaseFindUnique.mockResolvedValue({
      id: "purchase-1",
      status: "ORDERED",
      expectedAt: new Date("2026-04-10T00:00:00.000Z"),
      productId: "prod-1",
      quantity: 10,
      orderedQuantity: 10,
      receivedQuantity: 2,
      supplier: "MedSupply Ltd",
      supplierId: "sup-1",
      product: { name: "Sterile Gloves", sku: "SG-001" },
    });
    mockPurchaseUpdate.mockResolvedValue({
      id: "purchase-1",
      expectedAt: new Date("2026-04-15T00:00:00.000Z"),
    });

    const res = await POST(...makeRequest("2026-04-15"));

    expect(res.status).toBe(200);
    expect(mockRecordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "PURCHASE_EXPECTED_DATE_UPDATE",
        entityId: "purchase-1",
        meta: expect.objectContaining({
          purchaseId: "purchase-1",
          productId: "prod-1",
          productName: "Sterile Gloves",
          productSku: "SG-001",
          supplierId: "sup-1",
          previousExpectedAt: "2026-04-10T00:00:00.000Z",
          expectedAt: "2026-04-15T00:00:00.000Z",
          orderedQuantity: 10,
          receivedQuantity: 2,
          remainingQuantity: 8,
          updatedById: "u1",
          source: "PURCHASE_EXPECTED_DATE_UPDATE",
        }),
      }),
    );
  });
});
