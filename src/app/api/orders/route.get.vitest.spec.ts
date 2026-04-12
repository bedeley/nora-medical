import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetServerSession,
  mockOrderFindMany,
  mockOrderCount,
  mockOrderAggregate,
  mockPaymentFindMany,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockOrderFindMany: vi.fn(),
  mockOrderCount: vi.fn(),
  mockOrderAggregate: vi.fn(),
  mockPaymentFindMany: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    order: {
      findMany: mockOrderFindMany,
      count: mockOrderCount,
      aggregate: mockOrderAggregate,
    },
    payment: {
      findMany: mockPaymentFindMany,
    },
  },
}));

import { GET } from "./route";

const ADMIN_SESSION = {
  user: { id: "admin-1", role: "ADMIN", email: "admin@example.com" },
};

function makeOrder(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    userId: "customer-1",
    customerType: "REGISTERED",
    walkInName: null,
    walkInPhone: null,
    status: "UNPAID",
    deliveryStatus: "NOT_DELIVERED",
    deliveredAt: null,
    subtotal: 120,
    taxAmount: 18,
    total: 138,
    amountPaid: 20,
    balance: 118,
    createdAt: new Date("2026-04-01T10:00:00.000Z"),
    updatedAt: new Date("2026-04-01T12:00:00.000Z"),
    invoiceNumber: "INV-1001",
    adminNote: null,
    user: { id: "customer-1", name: "Acme Clinic", email: "ops@acme.test", phone: "0550000000" },
    items: [],
    ...overrides,
  };
}

describe("GET /api/orders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockOrderCount.mockResolvedValue(1);
    mockOrderAggregate.mockResolvedValue({
      _sum: { total: 138, amountPaid: 20, balance: 118 },
    });
    mockPaymentFindMany.mockResolvedValue([]);
  });

  it("returns 401 when no session is present", async () => {
    mockGetServerSession.mockResolvedValue(null);

    const res = await GET(new Request("http://localhost:3000/api/orders"));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: "Unauthorized" });
  });

  it("ignores pagination offset when exact ids are supplied", async () => {
    mockOrderFindMany.mockResolvedValueOnce([
      makeOrder("order-1"),
      makeOrder("order-2", { invoiceNumber: "INV-1002" }),
    ]);

    const res = await GET(
      new Request("http://localhost:3000/api/orders?all=1&ids=order-1,order-2&page=3&pageSize=1"),
    );

    expect(res.status).toBe(200);
    expect(mockOrderFindMany).toHaveBeenCalledTimes(1);
    expect(mockOrderFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 0,
        take: 2,
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            { id: { in: ["order-1", "order-2"] } },
          ]),
        }),
      }),
    );

    await expect(res.json()).resolves.toMatchObject({
      total: 1,
      items: expect.arrayContaining([
        expect.objectContaining({ id: "order-1" }),
        expect.objectContaining({ id: "order-2" }),
      ]),
    });
  });

  it("matches payment methods using parsed and legacy note formats", async () => {
    mockOrderFindMany
      .mockResolvedValueOnce([{ id: "order-transfer" }, { id: "order-cash" }])
      .mockResolvedValueOnce([makeOrder("order-transfer", { invoiceNumber: "INV-2001" })]);
    mockPaymentFindMany
      .mockResolvedValueOnce([
        { orderId: "order-transfer", note: "Bank Transfer received by admin" },
        { orderId: "order-cash", note: JSON.stringify({ method: "cash", note: "cash desk" }) },
      ])
      .mockResolvedValueOnce([]);

    const res = await GET(
      new Request("http://localhost:3000/api/orders?all=1&paymentMethod=transfer"),
    );

    expect(res.status).toBe(200);
    expect(mockOrderFindMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ["order-transfer"] },
        }),
      }),
    );

    await expect(res.json()).resolves.toMatchObject({
      items: [expect.objectContaining({ id: "order-transfer" })],
    });
  });
});
