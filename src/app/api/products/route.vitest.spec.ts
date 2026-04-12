import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetServerSession,
  mockProductFindMany,
  mockProductCount,
  mockInventoryLotFindMany,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockProductFindMany: vi.fn(),
  mockProductCount: vi.fn(),
  mockInventoryLotFindMany: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    product: {
      findMany: mockProductFindMany,
      count: mockProductCount,
    },
    inventoryLot: {
      findMany: mockInventoryLotFindMany,
    },
  },
}));
vi.mock("@/lib/origin", () => ({ assertSameOrigin: vi.fn(() => true) }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn() }));
vi.mock("@/lib/sku", () => ({
  formatSku: vi.fn(),
  normalizeSkuPrefix: vi.fn(),
  parseSkuNumber: vi.fn(),
}));
vi.mock("@/lib/accounting-posting", () => ({
  postPurchaseEntry: vi.fn(),
  postSupplierPaymentEntry: vi.fn(),
}));
vi.mock("@/lib/inventory-lots", () => ({ ensureInventoryLot: vi.fn() }));
vi.mock("@/lib/margin-guard", () => ({ getMarginGuardError: vi.fn(() => null) }));

import { GET } from "./route";

describe("GET /api/products", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetServerSession.mockResolvedValue({ user: { role: "ADMIN" } });
    mockInventoryLotFindMany.mockResolvedValue([]);
  });

  it("returns filtered aggregate stats when includeStats=1", async () => {
    mockProductFindMany
      .mockResolvedValueOnce([
        {
          id: "prod-1",
          sku: "MED-001",
          name: "Gloves",
          description: "Sterile gloves",
          imageUrl: "/gloves.png",
          category: "ppe",
          brand: "Nora",
          supplier: "MedSupply",
          supplierId: "sup-1",
          requiresLotTracking: false,
          requiresExpiryDate: false,
          inventoryPlan: { approvalThresholdQty: 10 },
          price: 20,
          cost: 10,
          minMarginPct: 15,
          stock: 0,
          archived: false,
          _count: { orderItems: 3 },
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-02T00:00:00.000Z"),
        },
      ])
      .mockResolvedValueOnce([{ supplier: "MedSupply" }, { supplier: "CareHub" }, { supplier: null }])
      .mockResolvedValueOnce([
        { price: 20, cost: 10, minMarginPct: 15 },
        { price: 10, cost: 12, minMarginPct: null },
        { price: 25, cost: 20, minMarginPct: 30 },
      ]);
    mockProductCount
      .mockResolvedValueOnce(6)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(1);

    const response = await GET(
      new Request("http://localhost:3000/api/products?page=1&pageSize=10&includeArchived=1&includeStats=1"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      total: 6,
      stats: {
        filteredTotal: 6,
        outOfStockCount: 2,
        lowStockCount: 3,
        archivedCount: 1,
        supplierCount: 2,
        marginRiskCount: 2,
      },
      items: [
        expect.objectContaining({
          id: "prod-1",
          name: "Gloves",
          stock: 0,
          cost: 10,
          orderCount: 3,
        }),
      ],
    });
    expect(mockProductCount).toHaveBeenCalledTimes(4);
    expect(mockProductFindMany).toHaveBeenCalledTimes(3);
  });
});
