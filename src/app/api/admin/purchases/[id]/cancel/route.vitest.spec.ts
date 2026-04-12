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
const STAFF_SESSION = { user: { id: "u2", role: "STAFF" } };

function makeRequest(id = "purchase-1") {
  return [
    new Request(`http://localhost:3000/api/admin/purchases/${id}/cancel`, {
      method: "POST",
      headers: { origin: "http://localhost:3000" },
    }),
    { params: Promise.resolve({ id }) },
  ] as const;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAssertSameOrigin.mockReturnValue(true);
  mockRateLimit.mockResolvedValue({ ok: true });
});

describe("POST /api/admin/purchases/[id]/cancel", () => {
  it("returns 401 when the user cannot manage purchases", async () => {
    mockGetServerSession.mockResolvedValue(STAFF_SESSION);
    const res = await POST(...makeRequest());
    expect(res.status).toBe(401);
  });

  it("returns 400 when the purchase already has received quantity", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockPurchaseFindUnique.mockResolvedValue({
      id: "purchase-1",
      status: "ORDERED",
      quantity: 10,
      orderedQuantity: 10,
      receivedQuantity: 2,
      supplier: "MedSupply Ltd",
      supplierId: "sup-1",
      productId: "prod-1",
      unitCost: 5,
    });
    const res = await POST(...makeRequest());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/returned instead of cancelled/i);
  });

  it("returns 200 and updates the status to CANCELLED for cancellable purchases", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockPurchaseFindUnique.mockResolvedValue({
      id: "purchase-1",
      status: "APPROVED",
      quantity: 10,
      orderedQuantity: 10,
      receivedQuantity: 0,
      supplier: "MedSupply Ltd",
      supplierId: "sup-1",
      productId: "prod-1",
      unitCost: 5,
      expectedAt: new Date("2026-04-01T00:00:00.000Z"),
      product: { name: "Sterile Gloves", sku: "SG-001" },
    });
    mockPurchaseUpdate.mockResolvedValue({ id: "purchase-1", status: "CANCELLED" });
    const res = await POST(...makeRequest());
    expect(res.status).toBe(200);
    expect(mockPurchaseUpdate).toHaveBeenCalledWith({
      where: { id: "purchase-1" },
      data: { status: "CANCELLED" },
      select: { id: true, status: true },
    });
    expect(mockRecordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "PURCHASE_CANCEL",
        entityId: "purchase-1",
        meta: expect.objectContaining({
          productId: "prod-1",
          productName: "Sterile Gloves",
          productSku: "SG-001",
          supplierId: "sup-1",
          source: "PURCHASE_CANCEL",
        }),
      }),
    );
    expect((await res.json()).status).toBe("CANCELLED");
  });
});
