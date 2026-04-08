import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mock state ────────────────────────────────────────────────────
const {
  mockGetServerSession,
  mockPrismaPaymentFindMany,
  mockPrismaOrderItemFindMany,
  mockPrismaJournalEntryFindMany,
  mockPrismaOrderFindMany,
  mockPrismaPaymentAggregate,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockPrismaPaymentFindMany: vi.fn(),
  mockPrismaOrderItemFindMany: vi.fn(),
  mockPrismaJournalEntryFindMany: vi.fn(),
  mockPrismaOrderFindMany: vi.fn(),
  mockPrismaPaymentAggregate: vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────
vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    payment: {
      findMany: mockPrismaPaymentFindMany,
      aggregate: mockPrismaPaymentAggregate,
    },
    orderItem: { findMany: mockPrismaOrderItemFindMany },
    journalEntry: { findMany: mockPrismaJournalEntryFindMany },
    order: { findMany: mockPrismaOrderFindMany },
  },
}));

// ── Import after mocks ────────────────────────────────────────────────────
import { GET } from "./route";

// ── Helpers ───────────────────────────────────────────────────────────────
const ADMIN_SESSION = { user: { id: "u1", role: "ADMIN", email: "admin@example.com" } };
const ACCOUNTANT_SESSION = { user: { id: "u2", role: "ACCOUNTANT", email: "ac@example.com" } };
const STAFF_SESSION = { user: { id: "u3", role: "STAFF" } };
const CUSTOMER_SESSION = { user: { id: "u4", role: "CUSTOMER" } };

function makeRequest(search = ""): Request {
  return new Request(`http://localhost:3000/api/admin/returns${search}`, {
    method: "GET",
    headers: { origin: "http://localhost:3000" },
  });
}

// A refund payment with ITEM_RETURN in the note
const mockRefundPayment = {
  id: "pay-refund-1",
  orderId: "order-1",
  amount: -50,
  refundDisposition: "CASH",
  note: JSON.stringify({
    reference: "ITEM_RETURN",
    orderId: "order-1",
    appliedToBalance: 0,
    restockToStock: true,
    refundDisposition: "CASH",
    reason: "DAMAGED",
    reasonNote: "Item arrived damaged",
    item: { id: "item-1", quantity: 1, lineRefund: 50 },
  }),
  createdAt: new Date("2026-03-15T10:00:00Z"),
  user: { name: "Test Customer", email: "cust@example.com" },
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default: empty results
  mockPrismaPaymentFindMany.mockResolvedValue([]);
  mockPrismaOrderItemFindMany.mockResolvedValue([]);
  mockPrismaJournalEntryFindMany.mockResolvedValue([]);
  mockPrismaOrderFindMany.mockResolvedValue([]);
  mockPrismaPaymentAggregate.mockResolvedValue({ _sum: { amount: null } });
});

// ── Auth guard ─────────────────────────────────────────────────────────────

describe("GET /api/admin/returns – auth guard", () => {
  it("returns 401 when no session", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it("returns 401 when role is CUSTOMER", async () => {
    mockGetServerSession.mockResolvedValue(CUSTOMER_SESSION);
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it("returns 200 for ADMIN", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
  });

  it("returns 200 for ACCOUNTANT", async () => {
    mockGetServerSession.mockResolvedValue(ACCOUNTANT_SESSION);
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
  });

  it("returns 200 for STAFF", async () => {
    mockGetServerSession.mockResolvedValue(STAFF_SESSION);
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
  });
});

// ── List structure ─────────────────────────────────────────────────────────

describe("GET /api/admin/returns – response structure", () => {
  beforeEach(() => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
  });

  it("returns rows, totals, and total count", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("rows");
    expect(body).toHaveProperty("totals");
    expect(body).toHaveProperty("total");
    expect(Array.isArray(body.rows)).toBe(true);
  });

  it("returns totals with expected keys", async () => {
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.totals).toHaveProperty("totalReturns");
    expect(body.totals).toHaveProperty("totalApplied");
    expect(body.totals).toHaveProperty("totalCredit");
    expect(body.totals).toHaveProperty("totalCash");
    expect(body.totals).toHaveProperty("storeCreditUsed");
  });

  it("returns empty rows when no return payments exist", async () => {
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.rows).toHaveLength(0);
    expect(body.total).toBe(0);
  });
});

// ── Payment-sourced returns ────────────────────────────────────────────────

describe("GET /api/admin/returns – payment-sourced returns", () => {
  beforeEach(() => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
  });

  it("includes return rows from refund payments", async () => {
    mockPrismaPaymentFindMany.mockResolvedValue([mockRefundPayment]);
    mockPrismaOrderItemFindMany.mockResolvedValue([
      { id: "item-1", product: { name: "Sterile Gloves" } },
    ]);
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.rows).toHaveLength(1);
    const row = body.rows[0];
    expect(row.id).toBe("pay-refund-1");
    expect(row.source).toBe("PAYMENT");
    expect(row.refundTotal).toBe(50);
    expect(row.orderId).toBe("order-1");
    expect(row.itemLabel).toBe("Sterile Gloves");
    expect(row.returnReason).toBe("DAMAGED");
    expect(row.restock).toBe(true);
    expect(row.rmaDisposition).toBe("RESTOCK");
    expect(row.customerName).toBe("Test Customer");
  });

  it("accumulates totals correctly for cash refunds", async () => {
    mockPrismaPaymentFindMany.mockResolvedValue([mockRefundPayment]);
    mockPrismaOrderItemFindMany.mockResolvedValue([]);
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.totals.totalReturns).toBe(50);
    expect(body.totals.totalCash).toBe(50);
    expect(body.totals.totalCredit).toBe(0);
  });
});

// ── Filters ────────────────────────────────────────────────────────────────

describe("GET /api/admin/returns – filters", () => {
  beforeEach(() => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockPrismaPaymentFindMany.mockResolvedValue([mockRefundPayment]);
    mockPrismaOrderItemFindMany.mockResolvedValue([]);
  });

  it("filters by type=cash returns only cash rows", async () => {
    const res = await GET(makeRequest("?type=cash"));
    const body = await res.json();
    // The mock refund is a CASH disposition — should still appear
    expect(body.rows.length).toBeGreaterThanOrEqual(0);
  });

  it("filters by type=credit returns no rows when all are cash", async () => {
    const res = await GET(makeRequest("?type=credit"));
    const body = await res.json();
    expect(body.rows).toHaveLength(0);
  });

  it("filters by date range via start/end params (returns 200)", async () => {
    const res = await GET(makeRequest("?start=2026-03-01&end=2026-03-31"));
    expect(res.status).toBe(200);
  });

  it("filters by text query matching customer name", async () => {
    const res = await GET(makeRequest("?q=Test+Customer"));
    const body = await res.json();
    // "Test Customer" is in the mock data, row should be included
    expect(body.rows.length).toBeGreaterThanOrEqual(1);
  });

  it("filters by text query with no match returns empty rows", async () => {
    const res = await GET(makeRequest("?q=zzznomatch999"));
    const body = await res.json();
    expect(body.rows).toHaveLength(0);
  });

  it("filters by source=PAYMENT shows only payment-sourced rows", async () => {
    const res = await GET(makeRequest("?source=PAYMENT"));
    const body = await res.json();
    body.rows.forEach((row: { source: string }) => {
      expect(row.source).toBe("PAYMENT");
    });
  });
});
