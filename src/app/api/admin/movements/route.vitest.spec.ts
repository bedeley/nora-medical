import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetServerSession,
  mockInventoryMovementFindMany,
  mockInventoryMovementCount,
  mockInventoryMovementAggregate,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockInventoryMovementFindMany: vi.fn(),
  mockInventoryMovementCount: vi.fn(),
  mockInventoryMovementAggregate: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    inventoryMovement: {
      findMany: mockInventoryMovementFindMany,
      count: mockInventoryMovementCount,
      aggregate: mockInventoryMovementAggregate,
    },
  },
}));

import { GET } from "./route";

const adminSession = {
  user: { id: "admin-1", role: "ADMIN", email: "admin@example.com" },
};

function makeRequest(params: Record<string, string> = {}) {
  const url = new URL("http://localhost/api/admin/movements");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new Request(url.toString());
}

describe("GET /api/admin/movements", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetServerSession.mockResolvedValue(adminSession);
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetServerSession.mockResolvedValue(null);

    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("returns paginated rows, stats, and applies requested sorting", async () => {
    mockInventoryMovementFindMany.mockResolvedValue([
      {
        id: "mov-1",
        productId: "prod-1",
        delta: 5,
        reason: "PURCHASE",
        note: "Batch received",
        createdAt: new Date("2026-04-01T10:00:00.000Z"),
        product: { name: "Amoxicillin", sku: "AMX-10" },
        purchase: { supplier: "Med Supply", unitCost: 12.5 },
        lot: { lotCode: "LOT-1", expiryDate: new Date("2027-01-01T00:00:00.000Z") },
      },
    ]);
    mockInventoryMovementCount.mockResolvedValue(60);
    mockInventoryMovementAggregate
      .mockResolvedValueOnce({ _sum: { delta: 25 } })
      .mockResolvedValueOnce({ _sum: { delta: -10 } })
      .mockResolvedValueOnce({ _sum: { delta: 15 } });

    const res = await GET(makeRequest({
      page: "2",
      pageSize: "50",
      sortBy: "productName",
      sortDir: "asc",
      reason: "purchase",
    }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(expect.objectContaining({
      total: 60,
      page: 2,
      pageSize: 50,
      totalPages: 2,
      sortBy: "productName",
      sortDir: "asc",
      stats: { totalIn: 25, totalOut: 10, net: 15 },
    }));
    expect(body.items[0]).toEqual(expect.objectContaining({
      id: "mov-1",
      productName: "Amoxicillin",
      note: "Batch received",
      supplier: "Med Supply",
      unitCost: 12.5,
      lotCode: "LOT-1",
    }));

    expect(mockInventoryMovementFindMany).toHaveBeenCalledWith(expect.objectContaining({
      skip: 50,
      take: 50,
      orderBy: [
        { product: { name: "asc" } },
        { createdAt: "desc" },
        { id: "desc" },
      ],
      where: expect.objectContaining({
        reason: { contains: "purchase", mode: "insensitive" },
      }),
    }));
  });

  it("streams CSV export including the note column", async () => {
    mockInventoryMovementAggregate.mockResolvedValue({ _sum: { delta: 7 } });
    mockInventoryMovementFindMany
      .mockResolvedValueOnce([
        {
          id: "mov-2",
          productId: "prod-2",
          delta: -3,
          reason: "SALE",
          note: "Dispensed to ward",
          createdAt: new Date("2026-04-02T09:15:00.000Z"),
          product: { name: "Syringe", sku: "SYR-1" },
          purchase: { supplier: "Clinic Hub", unitCost: 1.25 },
          lot: { lotCode: "LOT-2", expiryDate: new Date("2026-12-31T00:00:00.000Z") },
        },
      ])
      .mockResolvedValueOnce([]);

    const res = await GET(makeRequest({ format: "csv", sortBy: "createdAt", sortDir: "desc" }));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    const csv = await res.text();
    expect(csv).toContain('"Date","Product","SKU","Delta","Reason","Note","Supplier","Unit Cost","Lot","Expiry"');
    expect(csv).toContain('"Dispensed to ward"');
    expect(csv).toContain('"Net","","","7"');
    expect(mockInventoryMovementCount).not.toHaveBeenCalled();
  });
});
