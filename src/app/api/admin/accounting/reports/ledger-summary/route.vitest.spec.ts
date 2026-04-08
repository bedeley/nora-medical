import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────────────────────
const {
  mockGetServerSession,
  mockPrismaAppSettingFindUnique,
  mockPrismaJournalLineFindMany,
  mockPrismaOrderFindMany,
  mockPrismaPaymentFindMany,
  mockPrismaExpenseFindMany,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockPrismaAppSettingFindUnique: vi.fn(),
  mockPrismaJournalLineFindMany: vi.fn(),
  mockPrismaOrderFindMany: vi.fn(),
  mockPrismaPaymentFindMany: vi.fn(),
  mockPrismaExpenseFindMany: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    appSetting: { findUnique: mockPrismaAppSettingFindUnique },
    journalLine: { findMany: mockPrismaJournalLineFindMany },
    order: { findMany: mockPrismaOrderFindMany },
    payment: { findMany: mockPrismaPaymentFindMany },
    expense: { findMany: mockPrismaExpenseFindMany },
  },
}));

import { GET } from "./route";

// ── Helpers ────────────────────────────────────────────────────────────────
const ADMIN_SESSION = { user: { id: "u1", role: "ADMIN" } };
const ACCOUNTANT_SESSION = { user: { id: "u2", role: "ACCOUNTANT" } };

function makeReq(params: Record<string, string> = {}): Request {
  const url = new URL("http://localhost/api/admin/accounting/reports/ledger-summary");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url.toString());
}

/** Minimal journal line fixture */
function makeLine(overrides: {
  debit?: number; credit?: number;
  accountCode: string; accountType: string; accountName?: string;
  sourceType: "ORDER" | "PAYMENT" | "EXPENSE";
  entryDate?: Date; entryId?: string; sourceId?: string | null;
}) {
  return {
    debit: overrides.debit ?? 0,
    credit: overrides.credit ?? 0,
    account: {
      code: overrides.accountCode,
      type: overrides.accountType,
      name: overrides.accountName ?? "Account",
    },
    entry: {
      id: overrides.entryId ?? "entry-1",
      entryDate: overrides.entryDate ?? new Date("2024-01-15T10:00:00Z"),
      sourceType: overrides.sourceType,
      sourceId: overrides.sourceId ?? "source-1",
    },
  };
}

function setupEmptyDb() {
  mockPrismaAppSettingFindUnique.mockResolvedValue(null); // use default account codes
  mockPrismaJournalLineFindMany.mockResolvedValue([]);
  mockPrismaOrderFindMany.mockResolvedValue([]);
  mockPrismaPaymentFindMany.mockResolvedValue([]);
  mockPrismaExpenseFindMany.mockResolvedValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
  setupEmptyDb();
});

// ── Tests ──────────────────────────────────────────────────────────────────
describe("GET /api/admin/accounting/reports/ledger-summary", () => {

  // ── Auth guard ────────────────────────────────────────────────────────
  describe("auth guard", () => {
    it("returns 401 when no session", async () => {
      mockGetServerSession.mockResolvedValue(null);
      const res = await GET(makeReq());
      expect(res.status).toBe(401);
    });

    it("returns 401 for non-admin non-accountant role", async () => {
      mockGetServerSession.mockResolvedValue({ user: { role: "STAFF" } });
      const res = await GET(makeReq());
      expect(res.status).toBe(401);
    });

    it("allows ADMIN role", async () => {
      const res = await GET(makeReq());
      expect(res.status).toBe(200);
    });

    it("allows ACCOUNTANT role", async () => {
      mockGetServerSession.mockResolvedValue(ACCOUNTANT_SESSION);
      const res = await GET(makeReq());
      expect(res.status).toBe(200);
    });
  });

  // ── Empty state ────────────────────────────────────────────────────────
  describe("empty data", () => {
    it("returns zero summary when no journal lines", async () => {
      const res = await GET(makeReq());
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.summary.totalRevenue).toBe(0);
      expect(body.summary.totalDiscounts).toBe(0);
      expect(body.summary.totalRefunds).toBe(0);
      expect(body.summary.netRevenue).toBe(0);
      expect(body.summary.totalCOGS).toBe(0);
      expect(body.summary.totalExpense).toBe(0);
      expect(body.summary.profit).toBe(0);
      expect(body.summary.margin).toBe(0);
      expect(body.trend).toEqual([]);
    });
  });

  // ── Revenue from GL ───────────────────────────────────────────────────
  describe("revenue from INCOME account", () => {
    it("accumulates credit on INCOME accounts as revenue", async () => {
      mockPrismaJournalLineFindMany.mockResolvedValue([
        makeLine({ credit: 100, accountCode: "4000", accountType: "INCOME", sourceType: "ORDER" }),
      ]);
      const res = await GET(makeReq());
      const { summary } = await res.json();
      expect(summary.totalRevenue).toBeCloseTo(100, 5);
    });

    it("ignores INCOME credit from non-ORDER/PAYMENT entries", async () => {
      mockPrismaJournalLineFindMany.mockResolvedValue([
        makeLine({ credit: 50, accountCode: "4000", accountType: "INCOME", sourceType: "EXPENSE" }),
      ]);
      const res = await GET(makeReq());
      const { summary } = await res.json();
      expect(summary.totalRevenue).toBe(0);
    });

    it("nets revenue: debit on INCOME (reversal) reduces total", async () => {
      mockPrismaJournalLineFindMany.mockResolvedValue([
        makeLine({ credit: 100, accountCode: "4000", accountType: "INCOME", sourceType: "ORDER" }),
        makeLine({ debit: 20, accountCode: "4000", accountType: "INCOME", sourceType: "PAYMENT", entryId: "entry-2" }),
      ]);
      const res = await GET(makeReq());
      const { summary } = await res.json();
      expect(summary.totalRevenue).toBeCloseTo(100, 5);
      expect(summary.totalRefunds).toBeCloseTo(20, 5);
      expect(summary.netRevenue).toBeCloseTo(80, 5);
    });

    it("tracks discounts, refunds, tax, and net revenue separately", async () => {
      mockPrismaJournalLineFindMany.mockResolvedValue([
        makeLine({ credit: 120, accountCode: "4000", accountType: "INCOME", sourceType: "ORDER", sourceId: "order-1" }),
        makeLine({ debit: 20, accountCode: "4010", accountType: "INCOME", sourceType: "ORDER", sourceId: "order-1" }),
        makeLine({ credit: 12.5, accountCode: "2100", accountType: "LIABILITY", sourceType: "ORDER", sourceId: "order-1" }),
        makeLine({ debit: 30, accountCode: "4000", accountType: "INCOME", sourceType: "ORDER", entryId: "entry-return", sourceId: "order-1" }),
      ]);

      const res = await GET(makeReq());
      const { summary, trend } = await res.json();

      expect(summary.totalRevenue).toBeCloseTo(120, 5);
      expect(summary.totalDiscounts).toBeCloseTo(20, 5);
      expect(summary.discountedOrders).toBe(1);
      expect(summary.totalRefunds).toBeCloseTo(30, 5);
      expect(summary.netRevenue).toBeCloseTo(70, 5);
      expect(summary.totalTaxCollected).toBeCloseTo(12.5, 5);
      expect(summary.orderCount).toBe(1);
      expect(summary.averageOrderValue).toBeCloseTo(100, 5);
      expect(trend[0].refunds).toBeCloseTo(30, 5);
      expect(trend[0].netRevenue).toBeCloseTo(70, 5);
    });
  });

  // ── COGS from GL ──────────────────────────────────────────────────────
  describe("COGS from EXPENSE account (code 5000)", () => {
    it("accumulates debit on COGS account from ORDER entries", async () => {
      mockPrismaJournalLineFindMany.mockResolvedValue([
        makeLine({ debit: 60, accountCode: "5000", accountType: "EXPENSE", sourceType: "ORDER" }),
      ]);
      const res = await GET(makeReq());
      const { summary } = await res.json();
      expect(summary.totalCOGS).toBeCloseTo(60, 5);
    });

    it("does not include COGS from EXPENSE sourceType", async () => {
      mockPrismaJournalLineFindMany.mockResolvedValue([
        makeLine({ debit: 60, accountCode: "5000", accountType: "EXPENSE", sourceType: "EXPENSE" }),
      ]);
      const res = await GET(makeReq());
      const { summary } = await res.json();
      expect(summary.totalCOGS).toBe(0);
    });
  });

  // ── Operating expenses from GL ────────────────────────────────────────
  describe("operating expenses from EXPENSE journal lines", () => {
    it("accumulates debit on expense accounts from EXPENSE entries", async () => {
      mockPrismaJournalLineFindMany.mockResolvedValue([
        makeLine({ debit: 30, accountCode: "6000", accountType: "EXPENSE", accountName: "Operating Expense", sourceType: "EXPENSE" }),
      ]);
      const res = await GET(makeReq());
      const { summary } = await res.json();
      expect(summary.totalExpense).toBeCloseTo(30, 5);
    });

    it("builds expenseBreakdown keyed by account name", async () => {
      mockPrismaJournalLineFindMany.mockResolvedValue([
        makeLine({ debit: 25, accountCode: "6100", accountType: "EXPENSE", accountName: "Payroll Expense", sourceType: "EXPENSE" }),
        makeLine({ debit: 10, accountCode: "6000", accountType: "EXPENSE", accountName: "Admin Expense", sourceType: "EXPENSE" }),
      ]);
      const res = await GET(makeReq());
      const { summary } = await res.json();
      expect(summary.expenseBreakdown.length).toBe(2);
      // sorted descending
      expect(summary.expenseBreakdown[0].amount).toBeCloseTo(25, 5);
    });
  });

  // ── Cash in / out from GL ─────────────────────────────────────────────
  describe("cash in / out from CASH and BANK accounts", () => {
    it("debit on CASH account from PAYMENT entry = cash in", async () => {
      mockPrismaJournalLineFindMany.mockResolvedValue([
        makeLine({ debit: 90, accountCode: "1000", accountType: "ASSET", sourceType: "PAYMENT" }),
      ]);
      const res = await GET(makeReq());
      const { summary } = await res.json();
      expect(summary.totalCashIn).toBeCloseTo(90, 5);
      expect(summary.totalCashOut).toBe(0);
    });

    it("credit on BANK account from PAYMENT entry = cash out", async () => {
      mockPrismaJournalLineFindMany.mockResolvedValue([
        makeLine({ credit: 30, accountCode: "1010", accountType: "ASSET", sourceType: "PAYMENT" }),
      ]);
      const res = await GET(makeReq());
      const { summary } = await res.json();
      expect(summary.totalCashOut).toBeCloseTo(30, 5);
      expect(summary.totalCashIn).toBe(0);
    });

    it("non-PAYMENT entries on CASH account are not counted as cash flow", async () => {
      mockPrismaJournalLineFindMany.mockResolvedValue([
        makeLine({ debit: 100, accountCode: "1000", accountType: "ASSET", sourceType: "ORDER" }),
      ]);
      const res = await GET(makeReq());
      const { summary } = await res.json();
      expect(summary.totalCashIn).toBe(0);
    });
  });

  // ── Profit & margin ───────────────────────────────────────────────────
  describe("profit and margin calculation", () => {
    it("profit = netRevenue - COGS - expense, margin = profit / netRevenue * 100", async () => {
      mockPrismaJournalLineFindMany.mockResolvedValue([
        makeLine({ credit: 100, accountCode: "4000", accountType: "INCOME", sourceType: "ORDER" }),
        makeLine({ debit: 10, accountCode: "4010", accountType: "INCOME", sourceType: "ORDER" }),
        makeLine({ debit: 40, accountCode: "5000", accountType: "EXPENSE", accountName: "COGS", sourceType: "ORDER" }),
        makeLine({ debit: 20, accountCode: "6000", accountType: "EXPENSE", accountName: "OpEx", sourceType: "EXPENSE" }),
      ]);
      const res = await GET(makeReq());
      const { summary } = await res.json();
      expect(summary.netRevenue).toBeCloseTo(90, 5);
      expect(summary.profit).toBeCloseTo(30, 2);
      expect(summary.margin).toBeCloseTo(33.3, 1);
    });
  });

  // ── Trend groupBy ─────────────────────────────────────────────────────
  describe("trend groupBy period labels", () => {
    it("groups by day with yyyy-MM-dd", async () => {
      mockPrismaJournalLineFindMany.mockResolvedValue([
        makeLine({ credit: 50, accountCode: "4000", accountType: "INCOME", sourceType: "ORDER", entryDate: new Date("2024-03-05T08:00:00Z") }),
      ]);
      const res = await GET(makeReq({ groupBy: "day" }));
      const { trend } = await res.json();
      expect(trend[0].period).toBe("2024-03-05");
    });

    it("groups by month with yyyy-MM", async () => {
      mockPrismaJournalLineFindMany.mockResolvedValue([
        makeLine({ credit: 50, accountCode: "4000", accountType: "INCOME", sourceType: "ORDER", entryDate: new Date("2024-03-15T08:00:00Z") }),
      ]);
      const res = await GET(makeReq({ groupBy: "month" }));
      const { trend } = await res.json();
      expect(trend[0].period).toBe("2024-03");
    });

    it("groups by week with YYYY-Www format (not yyyy-ww)", async () => {
      // 2024-01-10 falls in ISO week 2 of 2024
      mockPrismaJournalLineFindMany.mockResolvedValue([
        makeLine({ credit: 50, accountCode: "4000", accountType: "INCOME", sourceType: "ORDER", entryDate: new Date("2024-01-10T08:00:00Z") }),
      ]);
      const res = await GET(makeReq({ groupBy: "week" }));
      const { trend } = await res.json();
      expect(trend[0].period).toMatch(/^\d{4}-W\d{2}$/);
      expect(trend[0].period).toBe("2024-W02");
    });
  });

  // ── Response shape ─────────────────────────────────────────────────────
  describe("response shape", () => {
    it("summary contains all expected keys", async () => {
      const res = await GET(makeReq());
      const body = await res.json();
      expect(body).toHaveProperty("summary");
      expect(body).toHaveProperty("trend");
      expect(body.summary).toHaveProperty("totalRevenue");
      expect(body.summary).toHaveProperty("totalDiscounts");
      expect(body.summary).toHaveProperty("discountedOrders");
      expect(body.summary).toHaveProperty("totalRefunds");
      expect(body.summary).toHaveProperty("netRevenue");
      expect(body.summary).toHaveProperty("totalCOGS");
      expect(body.summary).toHaveProperty("totalExpense");
      expect(body.summary).toHaveProperty("totalTaxCollected");
      expect(body.summary).toHaveProperty("profit");
      expect(body.summary).toHaveProperty("margin");
      expect(body.summary).toHaveProperty("totalCashIn");
      expect(body.summary).toHaveProperty("totalCashOut");
      expect(body.summary).toHaveProperty("expenseBreakdown");
    });
  });
});
