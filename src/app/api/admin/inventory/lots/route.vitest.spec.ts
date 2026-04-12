import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetServerSession,
  mockAppSettingFindMany,
  mockInventoryLotFindMany,
  mockInventoryLotCount,
  mockInventoryLotAggregate,
  mockInventoryLotGroupBy,
  mockProductFindMany,
  mockInventoryMovementCount,
  mockInventoryMovementFindMany,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockAppSettingFindMany: vi.fn(),
  mockInventoryLotFindMany: vi.fn(),
  mockInventoryLotCount: vi.fn(),
  mockInventoryLotAggregate: vi.fn(),
  mockInventoryLotGroupBy: vi.fn(),
  mockProductFindMany: vi.fn(),
  mockInventoryMovementCount: vi.fn(),
  mockInventoryMovementFindMany: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    appSetting: {
      findMany: mockAppSettingFindMany,
    },
    inventoryLot: {
      findMany: mockInventoryLotFindMany,
      count: mockInventoryLotCount,
      aggregate: mockInventoryLotAggregate,
      groupBy: mockInventoryLotGroupBy,
    },
    product: {
      findMany: mockProductFindMany,
    },
    inventoryMovement: {
      count: mockInventoryMovementCount,
      findMany: mockInventoryMovementFindMany,
    },
  },
}));

import { GET } from "./route";

const adminSession = {
  user: { id: "admin-1", role: "ADMIN", email: "admin@example.com" },
};

function makeRequest(params: Record<string, string> = {}) {
  const url = new URL("http://localhost/api/admin/inventory/lots");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new Request(url.toString());
}

describe("GET /api/admin/inventory/lots", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetServerSession.mockResolvedValue(adminSession);
    mockAppSettingFindMany.mockResolvedValue([]);
    mockInventoryLotCount.mockResolvedValue(0);
    mockInventoryLotAggregate.mockResolvedValue({ _sum: { quantityRemaining: 0 } });
    mockInventoryLotFindMany.mockResolvedValue([
      {
        id: "lot-1",
        productId: "prod-1",
        supplierId: "sup-1",
        lotCode: "LOT-1",
        expiryDate: new Date("2027-01-01T00:00:00.000Z"),
        receivedAt: new Date("2026-04-01T00:00:00.000Z"),
        quantityReceived: 100,
        quantityRemaining: 50,
        notes: "Primary batch",
        product: { name: "Amoxicillin", sku: "AMX-10" },
        supplier: { id: "sup-1", name: "Med Supply" },
      },
    ]);
    mockProductFindMany.mockResolvedValue([]);
    mockInventoryLotGroupBy.mockResolvedValue([]);
    mockInventoryMovementCount.mockResolvedValue(0);
    mockInventoryMovementFindMany.mockResolvedValue([]);
  });

  it("returns paginated rows and applies requested sorting at the database layer", async () => {
    mockInventoryLotCount
      .mockResolvedValueOnce(60)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(7);
    mockInventoryLotAggregate.mockResolvedValue({ _sum: { quantityRemaining: 400 } });

    const res = await GET(
      makeRequest({
        page: "2",
        pageSize: "50",
        sortBy: "productName",
        sortDir: "desc",
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(
      expect.objectContaining({
        totalItems: 60,
        page: 2,
        pageSize: 50,
        sortBy: "productName",
        sortDir: "desc",
      }),
    );
    expect(body.items[0]).toEqual(
      expect.objectContaining({
        id: "lot-1",
        productName: "Amoxicillin",
        supplierName: "Med Supply",
      }),
    );

    expect(mockInventoryLotFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 50,
        take: 50,
        orderBy: [{ product: { name: "desc" } }, { lotCode: "asc" }, { id: "asc" }],
      }),
    );
  });
});
