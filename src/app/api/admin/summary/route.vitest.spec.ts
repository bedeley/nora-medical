import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────────
const {
  mockGetServerSession,
  mockPrismaOrderFindMany,
  mockPrismaExpenseFindMany,
  mockPrismaJournalLineFindMany,
  mockPrismaPaymentFindMany,
  mockPrismaAuditLogFindMany,
  mockPrismaOrderItemFindMany,
  mockPrismaInventoryMovementFindMany,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockPrismaOrderFindMany: vi.fn(),
  mockPrismaExpenseFindMany: vi.fn(),
  mockPrismaJournalLineFindMany: vi.fn(),
  mockPrismaPaymentFindMany: vi.fn(),
  mockPrismaAuditLogFindMany: vi.fn(),
  mockPrismaOrderItemFindMany: vi.fn(),
  mockPrismaInventoryMovementFindMany: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: vi.fn() }));
vi.mock("pdf-lib", () => ({
  PDFDocument: { create: vi.fn().mockResolvedValue({ addPage: vi.fn(), save: vi.fn().mockResolvedValue(new Uint8Array()) }) },
  StandardFonts: { Helvetica: "Helvetica" },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    order: { findMany: mockPrismaOrderFindMany },
    expense: { findMany: mockPrismaExpenseFindMany },
    journalLine: { findMany: mockPrismaJournalLineFindMany },
    payment: { findMany: mockPrismaPaymentFindMany },
    auditLog: { findMany: mockPrismaAuditLogFindMany },
    orderItem: { findMany: mockPrismaOrderItemFindMany },
    inventoryMovement: { findMany: mockPrismaInventoryMovementFindMany },
  },
}));

import { GET } from "./route";

// ── Shared helpers ─────────────────────────────────────────────────────────
const ADMIN_SESSION = { user: { id: "u1", role: "ADMIN", email: "admin@test.com" } };
const ACCOUNTANT_SESSION = { user: { id: "u2", role: "ACCOUNTANT", email: "acc@test.com" } };

function makeReq(params: Record<string, string> = {}): Request {
  const url = new URL("http://localhost/api/admin/summary");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url.toString());
}

/** Minimal order fixture */
function makeOrder(overrides: Partial<{
  id: string; createdAt: Date; total: number; subtotal: number; taxAmount: number;
  amountPaid: number; deliveryStatus: string;
  items: { quantity: number; price: number; costAtSale: number | null; product: { cost: number } }[];
}> = {}) {
  return {
    id: "order-1",
    createdAt: new Date("2024-01-15T10:00:00Z"),
    total: 100,
    subtotal: 89.29,
    taxAmount: 10.71,
    amountPaid: 100,
    balance: 0,
    deliveryStatus: "DELIVERED",
    items: [{ quantity: 1, price: 89.29, costAtSale: 60, product: { cost: 60 } }],
    ...overrides,
  };
}

/** Minimal payment fixture */
function makePayment(overrides: Partial<{
  amount: number; status: string; createdAt: Date; note: string;
  refundDisposition: string | null; orderId: string | null;
}> = {}) {
  return {
    amount: 100,
    status: "PAID",
    createdAt: new Date("2024-01-15T12:00:00Z"),
    note: "",
    refundDisposition: null,
    orderId: "order-1",
    ...overrides,
  };
}

/** Set up minimal DB mocks that return empty datasets by default */
function setupEmptyDb() {
  mockPrismaOrderFindMany.mockResolvedValue([]);
  mockPrismaExpenseFindMany.mockResolvedValue([]);
  mockPrismaJournalLineFindMany.mockResolvedValue([]);
  mockPrismaPaymentFindMany.mockResolvedValue([]);
  mockPrismaAuditLogFindMany.mockResolvedValue([]);
  mockPrismaOrderItemFindMany.mockResolvedValue([]);
  mockPrismaInventoryMovementFindMany.mockResolvedValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
  setupEmptyDb();
});

// ── Tests ──────────────────────────────────────────────────────────────────
describe("GET /api/admin/summary", () => {

  // ── Auth guard ──────────────────────────────────────────────────────────
  describe("auth guard", () => {
    it("returns 401 when no session", async () => {
      mockGetServerSession.mockResolvedValue(null);
      const res = await GET(makeReq());
      expect(res.status).toBe(401);
    });

    it("returns 401 for non-admin, non-accountant role", async () => {
      mockGetServerSession.mockResolvedValue({ user: { role: "STAFF" } });
      const res = await GET(makeReq());
      expect(res.status).toBe(401);
    });

    it("allows ADMIN role", async () => {
      mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
      const res = await GET(makeReq());
      expect(res.status).toBe(200);
    });

    it("allows ACCOUNTANT role", async () => {
      mockGetServerSession.mockResolvedValue(ACCOUNTANT_SESSION);
      const res = await GET(makeReq());
      expect(res.status).toBe(200);
    });
  });

  // ── Zero state ──────────────────────────────────────────────────────────
  describe("empty data", () => {
    it("returns zero summary when no orders, payments, or expenses", async () => {
      const res = await GET(makeReq());
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.summary.totalRevenue).toBe(0);
      expect(body.summary.totalCOGS).toBe(0);
      expect(body.summary.totalExpense).toBe(0);
      expect(body.summary.profit).toBe(0);
      expect(body.summary.orderCount).toBe(0);
      expect(body.trend).toEqual([]);
    });
  });

  // ── Revenue & COGS ──────────────────────────────────────────────────────
  describe("revenue and COGS calculation", () => {
    it("uses order.subtotal as pre-tax revenue", async () => {
      mockPrismaOrderFindMany.mockResolvedValue([makeOrder({ subtotal: 89.29, total: 100 })]);
      const res = await GET(makeReq());
      const { summary } = await res.json();
      expect(summary.totalRevenue).toBeCloseTo(89.29, 2);
    });

    it("falls back to item price × qty when subtotal is missing", async () => {
      mockPrismaOrderFindMany.mockResolvedValue([
        makeOrder({
          subtotal: 0,
          total: 100,
          items: [{ quantity: 2, price: 44.645, costAtSale: null, product: { cost: 30 } }],
        }),
      ]);
      const res = await GET(makeReq());
      const { summary } = await res.json();
      expect(summary.totalRevenue).toBeCloseTo(89.29, 1);
    });

    it("calculates COGS from item costAtSale × qty", async () => {
      mockPrismaOrderFindMany.mockResolvedValue([
        makeOrder({ items: [{ quantity: 3, price: 10, costAtSale: 6, product: { cost: 5 } }] }),
      ]);
      const res = await GET(makeReq());
      const { summary } = await res.json();
      expect(summary.totalCOGS).toBeCloseTo(18, 5);
    });

    it("falls back to product.cost when costAtSale is null", async () => {
      mockPrismaOrderFindMany.mockResolvedValue([
        makeOrder({ items: [{ quantity: 2, price: 10, costAtSale: null, product: { cost: 7 } }] }),
      ]);
      const res = await GET(makeReq());
      const { summary } = await res.json();
      expect(summary.totalCOGS).toBeCloseTo(14, 5);
    });

    it("computes totalBilled = sum of order.total", async () => {
      mockPrismaOrderFindMany.mockResolvedValue([
        makeOrder({ total: 100 }),
        makeOrder({ id: "order-2", total: 50 }),
      ]);
      const res = await GET(makeReq());
      const { summary } = await res.json();
      expect(summary.totalBilled).toBeCloseTo(150, 5);
    });
  });

  // ── Expenses ────────────────────────────────────────────────────────────
  describe("expense accumulation", () => {
    it("adds expense.amount to totalExpense", async () => {
      mockPrismaExpenseFindMany.mockResolvedValue([
        { amount: 30, createdAt: new Date("2024-01-15"), category: "Supplies" },
        { amount: 20, createdAt: new Date("2024-01-15"), category: "Fuel" },
      ]);
      const res = await GET(makeReq());
      const { summary } = await res.json();
      expect(summary.totalExpense).toBeCloseTo(50, 5);
    });

    it("builds expenseBreakdown sorted by amount descending", async () => {
      mockPrismaExpenseFindMany.mockResolvedValue([
        { amount: 10, createdAt: new Date("2024-01-15"), category: "Fuel" },
        { amount: 40, createdAt: new Date("2024-01-15"), category: "Payroll" },
      ]);
      const res = await GET(makeReq());
      const { summary } = await res.json();
      expect(summary.expenseBreakdown[0].category).toBe("Payroll");
      expect(summary.expenseBreakdown[0].amount).toBeCloseTo(40, 5);
    });
  });

  // ── Cash flow ───────────────────────────────────────────────────────────
  describe("cash in / out from payments", () => {
    it("adds positive payment amount to totalCashIn", async () => {
      mockPrismaPaymentFindMany.mockResolvedValue([makePayment({ amount: 100, status: "PAID" })]);
      const res = await GET(makeReq());
      const { summary } = await res.json();
      expect(summary.totalCashIn).toBeCloseTo(100, 5);
      expect(summary.totalCashOut).toBe(0);
    });

    it("excludes VOID payments from cash in", async () => {
      mockPrismaPaymentFindMany.mockResolvedValue([makePayment({ amount: 100, status: "VOID" })]);
      const res = await GET(makeReq());
      const { summary } = await res.json();
      expect(summary.totalCashIn).toBe(0);
    });

    it("excludes AUTO_APPLY payments from cash in", async () => {
      mockPrismaPaymentFindMany.mockResolvedValue([
        makePayment({ amount: 50, status: "PAID", note: JSON.stringify({ reference: "AUTO_APPLY" }) }),
      ]);
      const res = await GET(makeReq());
      const { summary } = await res.json();
      expect(summary.totalCashIn).toBe(0);
    });

    it("excludes pending MoMo payments from cash in", async () => {
      mockPrismaPaymentFindMany.mockResolvedValue([
        makePayment({ amount: 75, status: "PAID", note: JSON.stringify({ method: "momo", status: "PENDING" }) }),
      ]);
      const res = await GET(makeReq());
      const { summary } = await res.json();
      expect(summary.totalCashIn).toBe(0);
    });

    it("adds REFUND amount to totalCashOut", async () => {
      mockPrismaPaymentFindMany.mockResolvedValue([
        makePayment({ amount: -40, status: "REFUND", note: JSON.stringify({ reference: "SALES_REFUND" }) }),
      ]);
      const res = await GET(makeReq());
      const { summary } = await res.json();
      expect(summary.totalCashOut).toBeCloseTo(40, 5);
    });
  });

  // ── Profit & margin ─────────────────────────────────────────────────────
  describe("profit and margin", () => {
    it("profit = netRevenue - COGS - expenses", async () => {
      mockPrismaOrderFindMany.mockResolvedValue([
        makeOrder({ subtotal: 100, total: 115, taxAmount: 15, items: [{ quantity: 1, price: 100, costAtSale: 40, product: { cost: 40 } }] }),
      ]);
      mockPrismaExpenseFindMany.mockResolvedValue([
        { amount: 20, createdAt: new Date("2024-01-15"), category: "Admin" },
      ]);
      const res = await GET(makeReq());
      const { summary } = await res.json();
      // netRevenue = 100 (no refunds), COGS = 40, expenses = 20 → profit = 40
      expect(summary.profit).toBeCloseTo(40, 2);
    });

    it("margin = profit / netRevenue * 100", async () => {
      mockPrismaOrderFindMany.mockResolvedValue([
        makeOrder({ subtotal: 100, total: 115, taxAmount: 15, items: [{ quantity: 1, price: 100, costAtSale: 40, product: { cost: 40 } }] }),
      ]);
      mockPrismaExpenseFindMany.mockResolvedValue([
        { amount: 20, createdAt: new Date("2024-01-15"), category: "Admin" },
      ]);
      const res = await GET(makeReq());
      const { summary } = await res.json();
      // profit = 40, netRevenue = 100 → margin = 40%
      expect(summary.margin).toBeCloseTo(40, 1);
    });
  });

  // ── Order count & AOV ───────────────────────────────────────────────────
  describe("order count and AOV", () => {
    it("counts orders correctly", async () => {
      mockPrismaOrderFindMany.mockResolvedValue([
        makeOrder({ id: "o1" }),
        makeOrder({ id: "o2" }),
        makeOrder({ id: "o3" }),
      ]);
      const res = await GET(makeReq());
      const { summary } = await res.json();
      expect(summary.orderCount).toBe(3);
    });

    it("computes AOV = totalRevenue / orderCount", async () => {
      mockPrismaOrderFindMany.mockResolvedValue([
        makeOrder({ id: "o1", subtotal: 100, total: 115, taxAmount: 15 }),
        makeOrder({ id: "o2", subtotal: 50, total: 57.5, taxAmount: 7.5 }),
      ]);
      const res = await GET(makeReq());
      const { summary } = await res.json();
      expect(summary.averageOrderValue).toBeCloseTo(75, 1);
    });
  });

  // ── Delivery status ─────────────────────────────────────────────────────
  describe("delivery status counts", () => {
    it("counts deliveredCount, pendingCount, etc.", async () => {
      mockPrismaOrderFindMany.mockResolvedValue([
        makeOrder({ id: "o1", deliveryStatus: "DELIVERED" }),
        makeOrder({ id: "o2", deliveryStatus: "DELIVERED" }),
        makeOrder({ id: "o3", deliveryStatus: "NOT_DELIVERED" }),
        makeOrder({ id: "o4", deliveryStatus: "PARTIALLY_DELIVERED" }),
        makeOrder({ id: "o5", deliveryStatus: "RETURNED" }),
      ]);
      const res = await GET(makeReq());
      const { summary } = await res.json();
      expect(summary.deliveredCount).toBe(2);
      expect(summary.pendingCount).toBe(1);
      expect(summary.partiallyDeliveredCount).toBe(1);
      expect(summary.returnedCount).toBe(1);
    });
  });

  // ── Trend groupBy ────────────────────────────────────────────────────────
  describe("trend groupBy period labels", () => {
    it("groups by day with yyyy-MM-dd format", async () => {
      mockPrismaOrderFindMany.mockResolvedValue([makeOrder({ createdAt: new Date("2024-03-05T08:00:00Z") })]);
      const res = await GET(makeReq({ groupBy: "day" }));
      const { trend } = await res.json();
      expect(trend.length).toBeGreaterThan(0);
      expect(trend[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(trend[0].date).toBe("2024-03-05");
    });

    it("groups by month with yyyy-MM format", async () => {
      mockPrismaOrderFindMany.mockResolvedValue([makeOrder({ createdAt: new Date("2024-03-15T08:00:00Z") })]);
      const res = await GET(makeReq({ groupBy: "month" }));
      const { trend } = await res.json();
      expect(trend[0].date).toBe("2024-03");
    });

    it("groups by year with yyyy format", async () => {
      mockPrismaOrderFindMany.mockResolvedValue([makeOrder({ createdAt: new Date("2024-06-15T08:00:00Z") })]);
      const res = await GET(makeReq({ groupBy: "year" }));
      const { trend } = await res.json();
      expect(trend[0].date).toBe("2024");
    });

    it("groups by week with YYYY-Www format (not yyyy-ww)", async () => {
      // 2024-01-08 is a Monday (ISO week 2 of 2024)
      mockPrismaOrderFindMany.mockResolvedValue([makeOrder({ createdAt: new Date("2024-01-10T08:00:00Z") })]);
      const res = await GET(makeReq({ groupBy: "week" }));
      const { trend } = await res.json();
      // Must be "2024-W02" style, not "2024-02" (which would look like a month)
      expect(trend[0].date).toMatch(/^\d{4}-W\d{2}$/);
      expect(trend[0].date).toBe("2024-W02");
    });
  });

  // ── Return-refund cashOut fix ─────────────────────────────────────────────
  describe("return-refund cashOut (double-count fix)", () => {
    it("return refund adds to totalCashOut exactly once", async () => {
      mockPrismaOrderFindMany.mockResolvedValue([makeOrder()]);
      mockPrismaPaymentFindMany.mockResolvedValue([
        makePayment({
          amount: -80,
          status: "REFUND",
          note: JSON.stringify({ reference: "ITEM_RETURN" }),
          refundDisposition: "CASH",
          orderId: "order-1",
        }),
      ]);
      const res = await GET(makeReq());
      const { summary } = await res.json();
      expect(summary.totalCashOut).toBeCloseTo(80, 5);
    });

    it("return refund cashOut in trend equals summary totalCashOut (not doubled)", async () => {
      mockPrismaOrderFindMany.mockResolvedValue([makeOrder({ createdAt: new Date("2024-03-05T10:00:00Z") })]);
      mockPrismaPaymentFindMany.mockResolvedValue([
        makePayment({
          amount: -80,
          status: "REFUND",
          createdAt: new Date("2024-03-05T10:00:00Z"),
          note: JSON.stringify({ reference: "ITEM_RETURN" }),
          refundDisposition: "CASH",
          orderId: "order-1",
        }),
      ]);
      const res = await GET(makeReq({ groupBy: "day" }));
      const body = await res.json();
      const periodRow = body.trend.find((r: { date: string }) => r.date === "2024-03-05");
      expect(periodRow).toBeDefined();
      // trend cashOut should match summary totalCashOut — not 2×
      expect(periodRow.cashOut).toBeCloseTo(body.summary.totalCashOut, 5);
      expect(periodRow.cashOut).toBeCloseTo(80, 5);
    });

    it("store credit return does NOT add to totalCashOut", async () => {
      mockPrismaOrderFindMany.mockResolvedValue([makeOrder()]);
      mockPrismaPaymentFindMany.mockResolvedValue([
        makePayment({
          amount: -50,
          status: "REFUND",
          note: JSON.stringify({ reference: "ITEM_RETURN" }),
          refundDisposition: "CREDIT",
          orderId: "order-1",
        }),
      ]);
      const res = await GET(makeReq());
      const { summary } = await res.json();
      // Store-credit returns should NOT flow through to cashOut summary
      expect(summary.totalCashOut).toBe(0);
    });
  });

  describe("return log processing", () => {
    it("batches restock movement lookups for multiple return logs", async () => {
      mockPrismaOrderFindMany.mockResolvedValue([
        makeOrder({
          items: [
            { quantity: 1, price: 100, costAtSale: 30, product: { cost: 30 } },
            { quantity: 2, price: 50, costAtSale: 10, product: { cost: 10 } },
          ],
        }),
      ]);
      mockPrismaAuditLogFindMany.mockResolvedValue([
        {
          id: "log-1",
          entityId: "order-1",
          createdAt: new Date("2024-01-15T10:05:00Z"),
          meta: JSON.stringify({
            itemId: "item-1",
            quantity: 1,
            refundAmount: 100,
            appliedToBalance: 0,
            disposition: "RESTOCK",
          }),
        },
        {
          id: "log-2",
          entityId: "order-1",
          createdAt: new Date("2024-01-15T10:10:00Z"),
          meta: JSON.stringify({
            itemId: "item-2",
            quantity: 1,
            refundAmount: 50,
            appliedToBalance: 0,
            disposition: "RESTOCK",
          }),
        },
      ]);
      mockPrismaOrderItemFindMany.mockResolvedValue([
        { id: "item-1", productId: "prod-1", costAtSale: 30, product: { cost: 30 } },
        { id: "item-2", productId: "prod-2", costAtSale: 10, product: { cost: 10 } },
      ]);
      mockPrismaInventoryMovementFindMany.mockResolvedValue([
        { productId: "prod-1", delta: 1, createdAt: new Date("2024-01-15T10:06:00Z") },
        { productId: "prod-2", delta: 1, createdAt: new Date("2024-01-15T10:09:00Z") },
      ]);

      const res = await GET(makeReq());
      const { summary } = await res.json();

      expect(mockPrismaInventoryMovementFindMany).toHaveBeenCalledTimes(1);
      expect(summary.totalRefunds).toBeCloseTo(150, 5);
      expect(summary.totalCOGS).toBeCloseTo(10, 5);
    });
  });

  // ── Period reconciliation ─────────────────────────────────────────────────
  describe("period sales reconciliation", () => {
    it("totalBilled = totalCollectedOnPeriodSales + totalOutstandingOnPeriodSales", async () => {
      mockPrismaOrderFindMany.mockResolvedValue([
        makeOrder({ total: 100, amountPaid: 60 }),
        makeOrder({ id: "o2", total: 50, amountPaid: 50 }),
      ]);
      const res = await GET(makeReq());
      const { summary } = await res.json();
      expect(summary.totalBilled).toBeCloseTo(
        summary.totalCollectedOnPeriodSales + summary.totalOutstandingOnPeriodSales,
        5,
      );
    });
  });

  // ── CSV format ────────────────────────────────────────────────────────────
  describe("CSV format", () => {
    it("returns CSV content-type when format=csv", async () => {
      const res = await GET(makeReq({ format: "csv" }));
      expect(res.headers.get("content-type")).toContain("text/csv");
    });

    it("CSV response body contains expected column headers", async () => {
      const res = await GET(makeReq({ format: "csv" }));
      const text = await res.text();
      expect(text).toContain("Revenue");
      expect(text).toContain("COGS");
      expect(text).toContain("Expenses");
      expect(text).toContain("Net Profit");
      expect(text).toContain("Cash In");
      expect(text).toContain("Outstanding");
    });

    it("omits the tautological reconciliation delta line", async () => {
      const res = await GET(makeReq({ format: "csv" }));
      const text = await res.text();
      expect(text).not.toContain("Reconciliation Delta");
    });
  });
});
