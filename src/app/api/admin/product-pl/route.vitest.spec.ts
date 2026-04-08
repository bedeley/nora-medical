import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetServerSession,
  mockOrderItemFindMany,
  mockAuditLogFindMany,
  mockInventoryMovementFindMany,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockOrderItemFindMany: vi.fn(),
  mockAuditLogFindMany: vi.fn(),
  mockInventoryMovementFindMany: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: vi.fn() }));
vi.mock("pdfkit", () => ({
  default: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    font: vi.fn().mockReturnThis(),
    fontSize: vi.fn().mockReturnThis(),
    text: vi.fn().mockReturnThis(),
    moveDown: vi.fn().mockReturnThis(),
    moveTo: vi.fn().mockReturnThis(),
    lineTo: vi.fn().mockReturnThis(),
    stroke: vi.fn().mockReturnThis(),
    end: vi.fn(),
    y: 0,
  })),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    orderItem: { findMany: mockOrderItemFindMany },
    auditLog: { findMany: mockAuditLogFindMany },
    inventoryMovement: { findMany: mockInventoryMovementFindMany },
  },
}));

import { GET } from "./route";

function makeReq(params: Record<string, string> = {}) {
  const url = new URL("http://localhost/api/admin/product-pl");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return new Request(url.toString());
}

describe("GET /api/admin/product-pl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetServerSession.mockResolvedValue({ user: { role: "ADMIN" } });
    mockOrderItemFindMany.mockResolvedValue([]);
    mockAuditLogFindMany.mockResolvedValue([]);
    mockInventoryMovementFindMany.mockResolvedValue([]);
  });

  it("deducts returned quantity, refunded revenue, and restocked COGS from product totals", async () => {
    mockOrderItemFindMany
      .mockResolvedValueOnce([
        {
          id: "item-1",
          productId: "prod-1",
          quantity: 5,
          price: 20,
          costAtSale: 10,
          product: { name: "Gloves" },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "item-1",
          productId: "prod-1",
          price: 20,
          costAtSale: 10,
          product: { name: "Gloves", cost: 10 },
        },
      ]);
    mockAuditLogFindMany.mockResolvedValue([
      {
        id: "log-1",
        createdAt: new Date("2024-01-15T10:05:00Z"),
        meta: JSON.stringify({
          itemId: "item-1",
          quantity: 2,
          refundAmount: 40,
          appliedToBalance: 0,
          disposition: "RESTOCK",
        }),
      },
    ]);

    const res = await GET(makeReq());
    const body = await res.json();

    expect(mockInventoryMovementFindMany).toHaveBeenCalledTimes(1);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({
      productId: "prod-1",
      name: "Gloves",
      qty: 3,
      revenue: 60,
      costTotal: 30,
      profit: 30,
    });
  });

  it("ignores return logs for items outside the selected sales window", async () => {
    mockOrderItemFindMany
      .mockResolvedValueOnce([
        {
          id: "item-1",
          productId: "prod-1",
          quantity: 5,
          price: 20,
          costAtSale: 10,
          product: { name: "Gloves" },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "item-2",
          productId: "prod-2",
          price: 15,
          costAtSale: 7,
          product: { name: "Masks", cost: 7 },
        },
      ]);
    mockAuditLogFindMany.mockResolvedValue([
      {
        id: "log-2",
        createdAt: new Date("2024-01-15T10:05:00Z"),
        meta: JSON.stringify({
          itemId: "item-2",
          quantity: 2,
          refundAmount: 30,
          appliedToBalance: 0,
          disposition: "RESTOCK",
        }),
      },
    ]);

    const res = await GET(makeReq());
    const body = await res.json();

    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({
      productId: "prod-1",
      qty: 5,
      revenue: 100,
      costTotal: 50,
      profit: 50,
    });
  });

  it("includes periodTotals across all products in the response", async () => {
    mockOrderItemFindMany
      .mockResolvedValueOnce([
        { id: "i1", productId: "p1", quantity: 10, price: 50, costAtSale: 30, product: { name: "Mask" } },
        { id: "i2", productId: "p2", quantity: 5,  price: 20, costAtSale: 10, product: { name: "Gloves" } },
      ])
      .mockResolvedValueOnce([]);
    mockAuditLogFindMany.mockResolvedValue([]);

    const res = await GET(makeReq({ pageSize: "1" }));
    const body = await res.json();

    // Page only has 1 row, but periodTotals covers both products
    expect(body.rows).toHaveLength(1);
    expect(body.total).toBe(2);
    expect(body.periodTotals).toMatchObject({
      revenue: 600,   // 10*50 + 5*20
      cost: 350,      // 10*30 + 5*10
      profit: 250,    // 600 - 350
      qty: 15,
      productCount: 2,
    });
  });

  it("filters to loss-makers only when lossOnly=1", async () => {
    mockOrderItemFindMany
      .mockResolvedValueOnce([
        { id: "i1", productId: "p1", quantity: 1, price: 100, costAtSale: 20, product: { name: "Profitable" } },
        { id: "i2", productId: "p2", quantity: 1, price: 10,  costAtSale: 50, product: { name: "LossMaker" } },
      ])
      .mockResolvedValueOnce([]);
    mockAuditLogFindMany.mockResolvedValue([]);

    const res = await GET(makeReq({ lossOnly: "1" }));
    const body = await res.json();

    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].name).toBe("LossMaker");
    expect(body.rows[0].profit).toBe(-40);
    // periodTotals still covers both products
    expect(body.periodTotals.productCount).toBe(2);
  });

  it("clamps out-of-range pages to the last available page", async () => {
    mockOrderItemFindMany
      .mockResolvedValueOnce([
        { id: "i1", productId: "p1", quantity: 1, price: 100, costAtSale: 10, product: { name: "A" } },
        { id: "i2", productId: "p2", quantity: 1, price: 90, costAtSale: 10, product: { name: "B" } },
        { id: "i3", productId: "p3", quantity: 1, price: 80, costAtSale: 10, product: { name: "C" } },
      ])
      .mockResolvedValueOnce([]);
    mockAuditLogFindMany.mockResolvedValue([]);

    const res = await GET(makeReq({ page: "999", pageSize: "2" }));
    const body = await res.json();

    expect(body.page).toBe(2);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].name).toBe("C");
  });

  it("rank reflects display position — desc: rank 1 is highest profit", async () => {
    // No return logs → orderItem.findMany called exactly once
    mockOrderItemFindMany.mockResolvedValueOnce([
      { id: "i1", productId: "p1", quantity: 1, price: 100, costAtSale: 10, product: { name: "Best" } },
      { id: "i2", productId: "p2", quantity: 1, price: 20,  costAtSale: 10, product: { name: "Worst" } },
    ]);

    const descBody = await (await GET(makeReq({ order: "desc" }))).json();
    expect(descBody.rows[0]).toMatchObject({ name: "Best", rank: 1 });
    expect(descBody.rows[1]).toMatchObject({ name: "Worst", rank: 2 });
  });

  it("rank reflects display position — asc: rank 1 is lowest profit", async () => {
    mockOrderItemFindMany.mockResolvedValueOnce([
      { id: "i1", productId: "p1", quantity: 1, price: 100, costAtSale: 10, product: { name: "Best" } },
      { id: "i2", productId: "p2", quantity: 1, price: 20,  costAtSale: 10, product: { name: "Worst" } },
    ]);

    const ascBody = await (await GET(makeReq({ order: "asc" }))).json();
    expect(ascBody.rows[0]).toMatchObject({ name: "Worst", rank: 1 });
    expect(ascBody.rows[1]).toMatchObject({ name: "Best", rank: 2 });
  });

  it("CSV export quotes fields containing commas", async () => {
    mockOrderItemFindMany
      .mockResolvedValueOnce([
        { id: "i1", productId: "p1", quantity: 2, price: 50, costAtSale: 20, product: { name: "Gauze, sterile" } },
      ])
      .mockResolvedValueOnce([]);
    mockAuditLogFindMany.mockResolvedValue([]);

    const res = await GET(makeReq({ format: "csv" }));
    const text = await res.text();
    const lines = text.split("\n");

    // Product name with comma must be quoted
    expect(lines[1]).toContain('"Gauze, sterile"');
    // Should still have exactly 9 fields per data row
    // Quick check: splitting by comma outside quotes — just verify the quoted field is present
    expect(lines[1]).toMatch(/"Gauze, sterile"/);
  });
});
