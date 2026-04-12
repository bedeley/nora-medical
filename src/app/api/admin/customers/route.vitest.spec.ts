import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetServerSession,
  mockUserFindMany,
  mockUserCount,
  mockOrderGroupBy,
  mockPaymentGroupBy,
  mockPaymentFindMany,
  mockCartFindMany,
  mockBalanceFindMany,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockUserFindMany: vi.fn(),
  mockUserCount: vi.fn(),
  mockOrderGroupBy: vi.fn(),
  mockPaymentGroupBy: vi.fn(),
  mockPaymentFindMany: vi.fn(),
  mockCartFindMany: vi.fn(),
  mockBalanceFindMany: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findMany: mockUserFindMany,
      count: mockUserCount,
    },
    order: {
      groupBy: mockOrderGroupBy,
    },
    payment: {
      groupBy: mockPaymentGroupBy,
      findMany: mockPaymentFindMany,
    },
    cart: {
      findMany: mockCartFindMany,
    },
    balance: {
      findMany: mockBalanceFindMany,
    },
  },
}));

import { GET } from "./route";

describe("GET /api/admin/customers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetServerSession.mockResolvedValue({ user: { role: "ADMIN" } });
    mockUserCount.mockResolvedValue(0);
    mockOrderGroupBy.mockResolvedValue([]);
    mockPaymentGroupBy.mockResolvedValue([]);
    mockPaymentFindMany.mockResolvedValue([]);
    mockCartFindMany.mockResolvedValue([]);
    mockBalanceFindMany.mockResolvedValue([]);
  });

  it("supports paginated customer search for registered users", async () => {
    mockUserFindMany.mockResolvedValue([
      {
        id: "cust-1",
        email: "kwesi@example.com",
        name: "Kwesi Mensah",
        phone: "0244000001",
        role: "CUSTOMER",
        archived: false,
        phoneVerifiedAt: null,
        lastLoginAt: null,
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
      },
      {
        id: "cust-2",
        email: null,
        name: "Kwame Owusu",
        phone: "0244000002",
        role: "CUSTOMER",
        archived: false,
        phoneVerifiedAt: null,
        lastLoginAt: null,
        createdAt: new Date("2026-04-02T00:00:00.000Z"),
      },
    ]);
    mockUserCount.mockResolvedValue(5);

    const response = await GET(
      new Request("http://localhost:3000/api/admin/customers?q=kw&page=1&pageSize=2&roles=CUSTOMER"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      total: 5,
      page: 1,
      pageSize: 2,
      rows: [
        expect.objectContaining({
          user: expect.objectContaining({ id: "cust-1", role: "CUSTOMER" }),
        }),
        expect.objectContaining({
          user: expect.objectContaining({ id: "cust-2", role: "CUSTOMER" }),
        }),
      ],
    });
    expect(mockUserFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 0,
        take: 2,
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            { OR: [{ role: "CUSTOMER" }] },
          ]),
        }),
      }),
    );
  });

  it("supports customer ledger scope without hiding non-customer accounts that have activity", async () => {
    mockUserFindMany.mockResolvedValue([
      {
        id: "cust-1",
        email: "customer@example.com",
        name: "Customer Account",
        phone: null,
        role: "CUSTOMER",
        archived: false,
        phoneVerifiedAt: null,
        lastLoginAt: null,
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
      },
      {
        id: "admin-with-order",
        email: "admin@example.com",
        name: "Admin With Ledger",
        phone: null,
        role: "ADMIN",
        archived: false,
        phoneVerifiedAt: null,
        lastLoginAt: null,
        createdAt: new Date("2026-04-02T00:00:00.000Z"),
      },
    ]);
    mockUserCount.mockResolvedValue(2);
    mockOrderGroupBy.mockResolvedValue([
      {
        userId: "admin-with-order",
        _sum: { total: 100, amountPaid: 25 },
      },
    ]);

    const response = await GET(
      new Request("http://localhost:3000/api/admin/customers?scope=customer-ledger&page=1&pageSize=25"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      total: 2,
      rows: [
        expect.objectContaining({
          user: expect.objectContaining({ id: "cust-1", role: "CUSTOMER" }),
        }),
        expect.objectContaining({
          user: expect.objectContaining({ id: "admin-with-order", role: "ADMIN" }),
          ordersTotal: 100,
          paidTotal: 25,
        }),
      ],
    });
    expect(mockUserFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            {
              OR: expect.arrayContaining([
                { role: "CUSTOMER" },
                { orders: { some: {} } },
                { payments: { some: {} } },
                { cart: { isNot: null } },
                { balance: { isNot: null } },
              ]),
            },
          ]),
        }),
      }),
    );
  });

  it("hydrates explicit customer ids and scopes ledger queries to those ids", async () => {
    mockUserFindMany.mockResolvedValue([
      {
        id: "cust-9",
        email: null,
        name: "Phone Only Customer",
        phone: "0244111111",
        role: "CUSTOMER",
        archived: false,
        phoneVerifiedAt: null,
        lastLoginAt: null,
        createdAt: new Date("2026-04-03T00:00:00.000Z"),
      },
    ]);
    mockUserCount.mockResolvedValue(1);

    const response = await GET(
      new Request("http://localhost:3000/api/admin/customers?ids=cust-9&roles=CUSTOMER"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      total: 1,
      rows: [
        expect.objectContaining({
          user: expect.objectContaining({ id: "cust-9", phone: "0244111111" }),
        }),
      ],
    });
    expect(mockPaymentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: { in: ["cust-9"] } },
      }),
    );
    expect(mockBalanceFindMany).toHaveBeenCalledWith({
      where: { userId: { in: ["cust-9"] } },
      select: { userId: true, creditLimit: true },
    });
  });

  it("supports archived large-list QA data and edge contact searches", async () => {
    mockUserFindMany.mockResolvedValue([
      {
        id: "qa-edge-archived",
        email: "qa+edge.o'connor@example-health.com",
        name: "O'Connor & Sons Medical Procurement Account With Extra Long Name",
        phone: "0244999000",
        role: "CUSTOMER",
        archived: true,
        phoneVerifiedAt: null,
        lastLoginAt: null,
        createdAt: new Date("2026-04-04T00:00:00.000Z"),
      },
    ]);
    mockUserCount.mockResolvedValue(60);
    mockOrderGroupBy
      .mockResolvedValueOnce([
        {
          userId: "qa-edge-archived",
          _sum: { total: 1225.75, amountPaid: 225.25 },
        },
      ])
      .mockResolvedValueOnce([
        {
          userId: "qa-edge-archived",
          deliveryStatus: "PARTIALLY_DELIVERED",
          _count: { _all: 1 },
        },
      ])
      .mockResolvedValueOnce([
        {
          userId: "qa-edge-archived",
          _max: { createdAt: new Date("2026-04-05T00:00:00.000Z") },
        },
      ]);
    mockPaymentGroupBy
      .mockResolvedValueOnce([
        {
          userId: "qa-edge-archived",
          _sum: { amount: 225.25 },
        },
      ])
      .mockResolvedValueOnce([]);
    mockCartFindMany.mockResolvedValue([
      {
        id: "cart-edge",
        userId: "qa-edge-archived",
        updatedAt: new Date("2026-04-04T12:00:00.000Z"),
        items: [
          {
            id: "cart-edge-1",
            productId: "prod-1",
            quantity: 3,
            product: { id: "prod-1", name: "Sterile Gloves XL", price: 61.4167 },
          },
        ],
      },
    ]);
    mockBalanceFindMany.mockResolvedValue([
      {
        userId: "qa-edge-archived",
        creditLimit: 500,
      },
    ]);

    const response = await GET(
      new Request(
        "http://localhost:3000/api/admin/customers?scope=customer-ledger&page=1&pageSize=75&includeArchived=1&q=qa%2Bedge",
      ),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      total: 60,
      page: 1,
      pageSize: 50,
      rows: [
        expect.objectContaining({
          user: expect.objectContaining({
            id: "qa-edge-archived",
            archived: true,
            email: "qa+edge.o'connor@example-health.com",
          }),
          ordersTotal: 1225.75,
          paidTotal: 225.25,
          creditLimit: 500,
          cart: expect.objectContaining({
            totalItems: 3,
            total: expect.any(Number),
          }),
        }),
      ],
    });
    expect(mockUserFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 50,
        where: expect.objectContaining({
          archived: undefined,
          AND: expect.arrayContaining([
            expect.objectContaining({
              OR: expect.arrayContaining([
                expect.objectContaining({ role: "CUSTOMER" }),
                expect.objectContaining({ cart: { isNot: null } }),
              ]),
            }),
          ]),
        }),
      }),
    );
  });
});
