import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────────
const {
  mockGetServerSession,
  mockPrismaOrderItemGroupBy,
  mockPrismaProductFindMany,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockPrismaOrderItemGroupBy: vi.fn(),
  mockPrismaProductFindMany: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    orderItem: { groupBy: mockPrismaOrderItemGroupBy },
    product: { findMany: mockPrismaProductFindMany },
  },
}));

import { GET } from "./route";

// ── Helpers ────────────────────────────────────────────────────────────────
const ADMIN_SESSION = { user: { id: "u1", role: "ADMIN" } };

function makeReq(params: Record<string, string> = {}): Request {
  const url = new URL("http://localhost/api/admin/top-products");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url.toString());
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
  mockPrismaOrderItemGroupBy.mockResolvedValue([]);
  mockPrismaProductFindMany.mockResolvedValue([]);
});

// ── Tests ──────────────────────────────────────────────────────────────────
describe("GET /api/admin/top-products", () => {

  // ── Auth guard ────────────────────────────────────────────────────────
  describe("auth guard", () => {
    it("returns 401 when no session", async () => {
      mockGetServerSession.mockResolvedValue(null);
      const res = await GET(makeReq());
      expect(res.status).toBe(401);
    });

    it("returns 401 for CUSTOMER role", async () => {
      mockGetServerSession.mockResolvedValue({ user: { role: "CUSTOMER" } });
      const res = await GET(makeReq());
      expect(res.status).toBe(401);
    });

    it("allows ADMIN role", async () => {
      const res = await GET(makeReq());
      expect(res.status).toBe(200);
    });

    it("allows STAFF role", async () => {
      mockGetServerSession.mockResolvedValue({ user: { role: "STAFF" } });
      const res = await GET(makeReq());
      expect(res.status).toBe(200);
    });

    it("allows ACCOUNTANT role", async () => {
      mockGetServerSession.mockResolvedValue({ user: { role: "ACCOUNTANT" } });
      const res = await GET(makeReq());
      expect(res.status).toBe(200);
    });
  });

  // ── Default mode (quantity) ───────────────────────────────────────────
  describe("mode=quantity (default)", () => {
    it("returns products sorted by totalSold descending", async () => {
      mockPrismaOrderItemGroupBy.mockResolvedValue([
        { productId: "prod-1", _sum: { quantity: 50 } },
        { productId: "prod-2", _sum: { quantity: 30 } },
      ]);
      mockPrismaProductFindMany.mockResolvedValue([
        { id: "prod-1", name: "Gloves", price: 5 },
        { id: "prod-2", name: "Syringes", price: 2 },
      ]);

      const res = await GET(makeReq());
      expect(res.status).toBe(200);
      const products = await res.json();
      expect(products).toHaveLength(2);
      expect(products[0].id).toBe("prod-1");
      expect(products[0].totalSold).toBe(50);
      expect(products[0].name).toBe("Gloves");
    });

    it("returns empty array when no order items", async () => {
      mockPrismaOrderItemGroupBy.mockResolvedValue([]);
      const res = await GET(makeReq());
      expect(await res.json()).toEqual([]);
    });

    it("uses 'Unknown' name when product not found", async () => {
      mockPrismaOrderItemGroupBy.mockResolvedValue([{ productId: "ghost", _sum: { quantity: 5 } }]);
      mockPrismaProductFindMany.mockResolvedValue([]);
      const res = await GET(makeReq());
      const products = await res.json();
      expect(products[0].name).toBe("Unknown");
    });
  });

  // ── mode=revenue ──────────────────────────────────────────────────────
  describe("mode=revenue", () => {
    it("sorts by revenue (qty × price) descending", async () => {
      mockPrismaOrderItemGroupBy.mockResolvedValue([
        { productId: "prod-1", _sum: { quantity: 10 } },
        { productId: "prod-2", _sum: { quantity: 5 } },
      ]);
      mockPrismaProductFindMany.mockResolvedValue([
        { id: "prod-1", name: "Cheap", price: 2 },
        { id: "prod-2", name: "Expensive", price: 10 },
      ]);

      const res = await GET(makeReq({ mode: "revenue" }));
      const products = await res.json();
      // prod-2 has higher revenue (50 > 20)
      expect(products[0].id).toBe("prod-2");
      expect(products[0].revenue).toBe(50);
    });
  });

  // ── Date filter ───────────────────────────────────────────────────────
  describe("date filter", () => {
    it("passes date filter to orderItem groupBy when start and end provided", async () => {
      mockPrismaOrderItemGroupBy.mockResolvedValue([]);
      await GET(makeReq({ start: "2024-01-01", end: "2024-01-31" }));
      const call = mockPrismaOrderItemGroupBy.mock.calls[0][0];
      // The where clause should include order with createdAt filter
      expect(call.where?.order?.createdAt?.gte).toBeDefined();
      expect(call.where?.order?.createdAt?.lte).toBeDefined();
    });

    it("passes no date filter when start and end are absent", async () => {
      mockPrismaOrderItemGroupBy.mockResolvedValue([]);
      await GET(makeReq());
      const call = mockPrismaOrderItemGroupBy.mock.calls[0][0];
      // createdAt should not be set on the order filter
      expect(call.where?.order?.createdAt).toBeUndefined();
    });

    it("always excludes cancelled orders", async () => {
      mockPrismaOrderItemGroupBy.mockResolvedValue([]);
      await GET(makeReq());
      const call = mockPrismaOrderItemGroupBy.mock.calls[0][0];
      expect(call.where?.order?.NOT?.status?.in).toContain("CANCELLED");
    });
  });

  // ── Revenue calculation ───────────────────────────────────────────────
  describe("revenue calculation", () => {
    it("computes revenue as totalSold × current product price", async () => {
      mockPrismaOrderItemGroupBy.mockResolvedValue([{ productId: "p1", _sum: { quantity: 4 } }]);
      mockPrismaProductFindMany.mockResolvedValue([{ id: "p1", name: "Bandage", price: 7.5 }]);
      const res = await GET(makeReq());
      const products = await res.json();
      expect(products[0].revenue).toBeCloseTo(30, 5);
    });
  });
});
