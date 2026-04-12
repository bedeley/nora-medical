import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetServerSession,
  mockPrismaSupplierPaymentFindUnique,
  mockPrismaPurchaseFindMany,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockPrismaSupplierPaymentFindUnique: vi.fn(),
  mockPrismaPurchaseFindMany: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/origin", () => ({ assertSameOrigin: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn() }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ notifyBackInStock: vi.fn() }));
vi.mock("@/lib/accounting-posting", () => ({
  postPurchaseEntry: vi.fn(),
  postSupplierPaymentEntry: vi.fn(),
}));
vi.mock("@/lib/inventory-lots", () => ({
  ensureInventoryLot: vi.fn(),
  normalizeLotCode: vi.fn((code: string) => code),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    supplierPayment: { findUnique: mockPrismaSupplierPaymentFindUnique },
    purchase: { findMany: mockPrismaPurchaseFindMany },
  },
}));

import { GET } from "./route";

const ADMIN_SESSION = { user: { id: "u1", role: "ADMIN" } };

function makeRequest(search = "") {
  return new Request(`http://localhost:3000/api/admin/purchases${search}`, {
    method: "GET",
    headers: { origin: "http://localhost:3000" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
});

describe("GET /api/admin/purchases pagination meta", () => {
  it("returns paginated scoped rows with summary metadata", async () => {
    mockPrismaPurchaseFindMany.mockResolvedValue([
      {
        id: "purchase-1",
        productId: "prod-1",
        quantity: 10,
        orderedQuantity: 10,
        receivedQuantity: 0,
        unitCost: 5,
        status: "PENDING_APPROVAL",
        expectedAt: null,
        supplierId: "sup-1",
        supplier: "MedSupply Ltd",
        reason: "Restock",
        note: "",
        createdAt: new Date("2026-04-01T10:00:00Z"),
        product: { name: "Sterile Gloves", sku: "SG-001", requiresLotTracking: false, requiresExpiryDate: false },
      },
      {
        id: "purchase-2",
        productId: "prod-2",
        quantity: 8,
        orderedQuantity: 8,
        receivedQuantity: 0,
        unitCost: 10,
        status: "ORDERED",
        expectedAt: new Date(),
        supplierId: "sup-1",
        supplier: "MedSupply Ltd",
        reason: "Restock",
        note: "",
        createdAt: new Date("2026-04-02T10:00:00Z"),
        product: { name: "Thermometer", sku: "TH-001", requiresLotTracking: false, requiresExpiryDate: false },
      },
    ]);

    const res = await GET(makeRequest("?quickView=due_today&page=1&pageSize=1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.meta.baseTotal).toBe(2);
    expect(body.meta.quickCounts.pendingApproval).toBe(1);
    expect(body.meta.quickCounts.awaitingReceive).toBe(1);
    expect(body.meta.statusCounts).toEqual([{ status: "ORDERED", count: 1 }]);
  });

  it("keeps paymentId scoping in CSV export and aligns the totals row", async () => {
    mockPrismaSupplierPaymentFindUnique.mockResolvedValue({ purchaseId: "purchase-1" });
    mockPrismaPurchaseFindMany.mockResolvedValue([
      {
        id: "purchase-1",
        productId: "prod-1",
        quantity: 10,
        orderedQuantity: 10,
        receivedQuantity: 4,
        unitCost: 5,
        status: "ORDERED",
        expectedAt: null,
        supplierId: "sup-1",
        supplier: "MedSupply Ltd",
        reason: "Restock",
        note: "Urgent",
        createdAt: new Date("2026-04-01T10:00:00Z"),
        product: { name: "Sterile Gloves", sku: "SG-001", requiresLotTracking: false, requiresExpiryDate: false },
      },
    ]);

    const res = await GET(makeRequest("?paymentId=pay-1&format=csv"));
    const csv = await res.text();
    expect(res.status).toBe(200);
    expect(mockPrismaSupplierPaymentFindUnique).toHaveBeenCalledWith({
      where: { id: "pay-1" },
      select: { purchaseId: true },
    });
    expect(csv).toContain("Sterile Gloves");
    expect(csv).toContain('Totals,,,10,,,,50.00,,,');
  });
});
