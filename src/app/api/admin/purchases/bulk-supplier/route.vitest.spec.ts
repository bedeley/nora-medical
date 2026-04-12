import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockRateLimit,
  mockPurchaseFindMany,
  mockPurchaseUpdateMany,
  mockSupplierFindUnique,
  mockRecordAuditLog,
  mockHasPermission,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockAssertSameOrigin: vi.fn(),
  mockRateLimit: vi.fn(),
  mockPurchaseFindMany: vi.fn(),
  mockPurchaseUpdateMany: vi.fn(),
  mockSupplierFindUnique: vi.fn(),
  mockRecordAuditLog: vi.fn(),
  mockHasPermission: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/origin", () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mockRateLimit }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: mockRecordAuditLog }));
vi.mock("@/lib/permissions", () => ({ hasPermission: mockHasPermission }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    purchase: {
      findMany: mockPurchaseFindMany,
      updateMany: mockPurchaseUpdateMany,
    },
    supplier: {
      findUnique: mockSupplierFindUnique,
    },
  },
}));

import { POST } from "./route";

const ADMIN_SESSION = { user: { id: "u1", role: "ADMIN" } };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
  mockAssertSameOrigin.mockReturnValue(true);
  mockRateLimit.mockResolvedValue({ ok: true });
  mockHasPermission.mockReturnValue(true);
});

describe("POST /api/admin/purchases/bulk-supplier", () => {
  it("records enriched audit metadata on success", async () => {
    mockPurchaseFindMany.mockResolvedValue([
      {
        id: "purchase-1",
        productId: "prod-1",
        quantity: 10,
        orderedQuantity: 10,
        receivedQuantity: 0,
        status: "ORDERED",
        supplierId: null,
        supplier: null,
        product: { name: "Sterile Gloves", sku: "SG-001" },
      },
      {
        id: "purchase-2",
        productId: "prod-2",
        quantity: 3,
        orderedQuantity: 3,
        receivedQuantity: 1,
        status: "PARTIALLY_RECEIVED",
        supplierId: "existing-sup",
        supplier: "Existing Supplier",
        product: { name: "Syringes", sku: "SY-002" },
      },
    ]);
    mockSupplierFindUnique.mockResolvedValue({ id: "sup-1", name: "MedSupply Ltd" });
    mockPurchaseUpdateMany.mockResolvedValue({ count: 1 });

    const req = new Request("http://localhost:3000/api/admin/purchases/bulk-supplier", {
      method: "POST",
      headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ purchaseIds: ["purchase-1", "purchase-2"], supplierId: "sup-1" }),
    });

    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockRecordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "PURCHASE_BULK_SUPPLIER_ASSIGN",
        entityId: "BULK",
        meta: expect.objectContaining({
          supplierId: "sup-1",
          supplierName: "MedSupply Ltd",
          requestedCount: 2,
          matchedCount: 2,
          eligibleCount: 1,
          updatedCount: 1,
          updatedPurchaseIds: ["purchase-1"],
          skippedPurchaseIds: ["purchase-2"],
          purchasesPreview: [
            expect.objectContaining({
              id: "purchase-1",
              productId: "prod-1",
              productName: "Sterile Gloves",
              productSku: "SG-001",
              previousSupplierId: null,
            }),
          ],
          source: "PURCHASE_BULK_SUPPLIER_ASSIGN",
        }),
      }),
    );
  });
});
