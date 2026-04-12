import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetServerSession,
  mockRecordAuditLog,
  mockAssertSameOrigin,
  mockRateLimit,
  mockPostExpenseEntry,
  mockExpenseFindMany,
  mockExpenseFindUnique,
  mockExpenseCreate,
  mockExpenseAggregate,
  mockExpenseGroupBy,
  mockLedgerAccountFindUnique,
  mockJournalEntryFindMany,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockRecordAuditLog: vi.fn(),
  mockAssertSameOrigin: vi.fn(() => true),
  mockRateLimit: vi.fn(() => ({ ok: true })),
  mockPostExpenseEntry: vi.fn(() => Promise.resolve({ id: "je-1" })),
  mockExpenseFindMany: vi.fn(),
  mockExpenseFindUnique: vi.fn(),
  mockExpenseCreate: vi.fn(),
  mockExpenseAggregate: vi.fn(),
  mockExpenseGroupBy: vi.fn(),
  mockLedgerAccountFindUnique: vi.fn(),
  mockJournalEntryFindMany: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: mockRecordAuditLog }));
vi.mock("@/lib/origin", () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mockRateLimit }));
vi.mock("@/lib/accounting-posting", () => ({ postExpenseEntry: mockPostExpenseEntry }));
vi.mock("@/lib/currency", () => ({ formatCurrency: (v: number) => `GHS ${Number(v).toFixed(2)}` }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    ledgerAccount: { findUnique: mockLedgerAccountFindUnique },
    expense: {
      findMany: mockExpenseFindMany,
      findUnique: mockExpenseFindUnique,
      create: mockExpenseCreate,
      aggregate: mockExpenseAggregate,
      groupBy: mockExpenseGroupBy,
    },
    journalEntry: { findMany: mockJournalEntryFindMany },
  },
}));

import { GET, POST } from "./route";

// ── Fixtures ────────────────────────────────────────────────────────────────

const adminSession = { user: { id: "u1", role: "ADMIN", email: "admin@test.com" } };
const accountantSession = { user: { id: "u2", role: "ACCOUNTANT", email: "acc@test.com" } };

const rentExpense = {
  id: "e1",
  category: "6200 Rent Expense",
  amount: 500,
  vendor: "Landlord Ltd",
  reason: "Monthly rent",
  note: "Settlement: accrued (unpaid)",
  isReversal: false,
  reversalOfId: null,
  createdAt: new Date("2024-01-15T10:00:00Z"),
  deletedAt: null,
  payrollRunId: null,
};

const utilitiesExpense = {
  id: "e2",
  category: "6300 Utilities Expense",
  amount: 200,
  vendor: "ECG",
  reason: null,
  note: null,
  isReversal: false,
  reversalOfId: null,
  createdAt: new Date("2024-01-10T08:00:00Z"),
  deletedAt: null,
  payrollRunId: null,
};

function makeGetReq(params: Record<string, string> = {}) {
  const url = new URL("http://localhost/api/admin/expenses");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url.toString());
}

function makePostReq(body: unknown) {
  return new Request("http://localhost/api/admin/expenses", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "http://localhost" },
    body: JSON.stringify(body),
  });
}

// ── GET tests ────────────────────────────────────────────────────────────────

describe("GET /api/admin/expenses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetServerSession.mockResolvedValue(adminSession);
    mockExpenseFindMany.mockResolvedValue([]);
    mockExpenseFindUnique.mockResolvedValue(null);
    mockExpenseGroupBy.mockResolvedValue([]);
    mockJournalEntryFindMany.mockResolvedValue([]);
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await GET(makeGetReq());
    expect(res.status).toBe(401);
  });

  it("returns 401 when role is not ADMIN or ACCOUNTANT", async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: "u3", role: "STAFF" } });
    const res = await GET(makeGetReq());
    expect(res.status).toBe(401);
  });

  it("allows ACCOUNTANT role", async () => {
    mockGetServerSession.mockResolvedValue(accountantSession);
    const res = await GET(makeGetReq());
    expect(res.status).toBe(200);
  });

  it("returns items array and totalAmount", async () => {
    mockExpenseFindMany.mockResolvedValue([rentExpense, utilitiesExpense]);
    const res = await GET(makeGetReq());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.items).toHaveLength(2);
    expect(data.totalAmount).toBe(700);
  });

  it("returns empty items and zero total when no expenses", async () => {
    const res = await GET(makeGetReq());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.items).toHaveLength(0);
    expect(data.totalAmount).toBe(0);
  });

  it("includes full end day (23:59:59.999) when end date provided", async () => {
    await GET(makeGetReq({ start: "2024-01-01", end: "2024-01-31" }));
    const whereArg = mockExpenseFindMany.mock.calls[0][0].where;
    const lte: Date = whereArg.createdAt.lte;
    expect(lte.getHours()).toBe(23);
    expect(lte.getMinutes()).toBe(59);
    expect(lte.getSeconds()).toBe(59);
    expect(lte.getMilliseconds()).toBe(999);
  });

  it("applies category filter as case-insensitive contains", async () => {
    await GET(makeGetReq({ category: "Rent" }));
    const whereArg = mockExpenseFindMany.mock.calls[0][0].where;
    expect(whereArg.category).toEqual({ contains: "Rent", mode: "insensitive" });
  });

  it("applies vendor filter as case-insensitive contains", async () => {
    await GET(makeGetReq({ vendor: "Shell" }));
    const whereArg = mockExpenseFindMany.mock.calls[0][0].where;
    expect(whereArg.vendor).toEqual({ contains: "Shell", mode: "insensitive" });
  });

  it("filters UNPAID settlement state in memory, excluding non-tracked rows", async () => {
    mockExpenseFindMany.mockResolvedValue([
      { ...rentExpense, note: "Settlement: accrued (unpaid)" },
      { ...utilitiesExpense, note: null }, // no settlement tracking
    ]);
    const res = await GET(makeGetReq({ settlementState: "UNPAID" }));
    const data = await res.json();
    // Only e1 is UNPAID — e2 has no settlement tracking so it has null settlementStatus
    expect(data.items).toHaveLength(1);
    expect(data.items[0].id).toBe("e1");
    expect(data.totalAmount).toBe(500);
  });

  it("PAID filter excludes UNPAID and non-tracked expenses", async () => {
    const paidExpense = {
      ...utilitiesExpense,
      id: "e3",
      amount: 300,
      note: "Settlement: accrued (unpaid)",
    };
    mockExpenseFindMany.mockResolvedValue([rentExpense, paidExpense]);
    // Simulate settlement journal: e3 fully paid
    mockJournalEntryFindMany.mockResolvedValue([
      {
        sourceId: "e3:settlement:1234",
        createdAt: new Date(),
        lines: [{ debit: 300 }],
      },
    ]);
    const res = await GET(makeGetReq({ settlementState: "PAID" }));
    const data = await res.json();
    expect(data.items).toHaveLength(1);
    expect(data.items[0].id).toBe("e3");
  });

  it("scopes settlement entry query to current result set (uses OR startsWith)", async () => {
    mockExpenseFindMany.mockResolvedValue([rentExpense]);
    await GET(makeGetReq());
    const jeFindCall = mockJournalEntryFindMany.mock.calls[0][0];
    expect(jeFindCall.where).toMatchObject({
      OR: [{ sourceId: { startsWith: "e1:settlement:" } }],
    });
  });

  it("returns empty settlement query when all items are reversals", async () => {
    const reversalRow = { ...rentExpense, isReversal: true };
    mockExpenseFindMany.mockResolvedValue([reversalRow]);
    await GET(makeGetReq());
    // Should not call journalEntry.findMany when all items are reversals
    expect(mockJournalEntryFindMany).not.toHaveBeenCalled();
  });

  it("returns CSV with settlement columns when format=csv", async () => {
    mockExpenseFindMany.mockResolvedValue([rentExpense]);
    const res = await GET(makeGetReq({ format: "csv" }));
    expect(res.headers.get("content-type")).toMatch(/text\/csv/i);
    const text = await res.text();
    const headerRow = text.split("\n")[0];
    expect(headerRow).toContain("Settlement Status");
    expect(headerRow).toContain("Paid (GHS)");
    expect(headerRow).toContain("Outstanding (GHS)");
    // Data row should contain category
    expect(text).toContain("6200 Rent Expense");
  });

  it("uses date-range filename for CSV when start and end provided", async () => {
    mockExpenseFindMany.mockResolvedValue([]);
    const res = await GET(makeGetReq({ start: "2024-01-01", end: "2024-01-31", format: "csv" }));
    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition).toContain("2024-01-01_to_2024-01-31");
  });

  it("uses today as fallback filename for CSV when no date range", async () => {
    mockExpenseFindMany.mockResolvedValue([]);
    const res = await GET(makeGetReq({ format: "csv" }));
    const disposition = res.headers.get("content-disposition") ?? "";
    const today = new Date().toISOString().slice(0, 10);
    expect(disposition).toContain(today);
  });

  it("adds reversal metadata to reversal rows", async () => {
    const original = { ...rentExpense, id: "orig" };
    const reversal = { ...rentExpense, id: "rev1", isReversal: true, reversalOfId: "orig", amount: -500 };
    mockExpenseFindMany.mockResolvedValue([original, reversal]);
    mockExpenseGroupBy.mockResolvedValue([
      { reversalOfId: "orig", _sum: { amount: -500 } },
    ]);
    const res = await GET(makeGetReq());
    const data = await res.json();
    const origRow = data.items.find((i: { id: string }) => i.id === "orig");
    expect(origRow.reversedSoFar).toBe(500);
    expect(origRow.reversalRemaining).toBe(0); // fully reversed
    const revRow = data.items.find((i: { id: string }) => i.id === "rev1");
    expect(revRow.reversalRemaining).toBeNull(); // reversals get null
  });
});

// ── POST tests ────────────────────────────────────────────────────────────────

describe("POST /api/admin/expenses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetServerSession.mockResolvedValue(adminSession);
    mockAssertSameOrigin.mockReturnValue(true);
    mockRateLimit.mockResolvedValue({ ok: true });
    mockLedgerAccountFindUnique.mockResolvedValue({ id: "acc-1", type: "EXPENSE", isActive: true });
    mockExpenseCreate.mockResolvedValue({
      id: "e-new",
      category: "6200 Rent Expense",
      amount: 500,
      vendor: "Landlord",
      reason: null,
      note: "Settlement: accrued (unpaid)",
      isReversal: false,
      reversalOfId: null,
      createdAt: new Date(),
      payrollRunId: null,
    });
    mockPostExpenseEntry.mockResolvedValue({ id: "je-1" });
    mockRecordAuditLog.mockResolvedValue(undefined);
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await POST(makePostReq({ category: "6200 Rent Expense", amount: 100 }));
    expect(res.status).toBe(401);
  });

  it("returns 401 for non-admin, non-accountant role", async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: "u3", role: "MANAGER" } });
    const res = await POST(makePostReq({ category: "6200 Rent Expense", amount: 100 }));
    expect(res.status).toBe(401);
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimit.mockResolvedValue({ ok: false });
    const res = await POST(makePostReq({ category: "6200 Rent Expense", amount: 100 }));
    expect(res.status).toBe(429);
  });

  it("returns 403 when origin assertion fails", async () => {
    mockAssertSameOrigin.mockReturnValue(false);
    const res = await POST(makePostReq({ category: "6200 Rent Expense", amount: 100 }));
    expect(res.status).toBe(403);
  });

  it("returns 400 when amount is zero or negative for a normal expense", async () => {
    const res = await POST(makePostReq({ category: "6200 Rent Expense", amount: -50 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid input");
  });

  it("returns 400 for system-driven COGS code 5000", async () => {
    const res = await POST(makePostReq({ category: "5000 Cost of Goods Sold", amount: 100 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/system-driven/i);
  });

  it("returns 400 for system-driven payroll expense", async () => {
    const res = await POST(makePostReq({ category: "6100 Payroll Expense", amount: 100 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/system-driven/i);
  });

  it("returns 400 if ledger account is missing", async () => {
    mockLedgerAccountFindUnique.mockResolvedValue(null);
    const res = await POST(makePostReq({ category: "9999 Fake Category", amount: 100 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/missing or inactive/i);
  });

  it("returns 400 if ledger account type is not EXPENSE", async () => {
    mockLedgerAccountFindUnique.mockResolvedValue({ id: "acc-1", type: "ASSET", isActive: true });
    const res = await POST(makePostReq({ category: "1000 Cash", amount: 100 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/missing or inactive/i);
  });

  it("appends 'accrued (unpaid)' settlement note when payNow is false", async () => {
    await POST(makePostReq({ category: "6200 Rent Expense", amount: 500, payNow: false }));
    const createdData = mockExpenseCreate.mock.calls[0][0].data;
    expect(createdData.note).toMatch(/settlement:\s*accrued\s*\(unpaid\)/i);
  });

  it("appends 'cash (paid now)' when payNow=true and paymentMode=cash", async () => {
    await POST(makePostReq({ category: "6200 Rent Expense", amount: 500, payNow: true, paymentMode: "cash" }));
    const createdData = mockExpenseCreate.mock.calls[0][0].data;
    expect(createdData.note).toMatch(/settlement:\s*cash/i);
  });

  it("appends 'bank transfer' when payNow=true and paymentMode=bank", async () => {
    await POST(makePostReq({ category: "6200 Rent Expense", amount: 500, payNow: true, paymentMode: "bank" }));
    const createdData = mockExpenseCreate.mock.calls[0][0].data;
    expect(createdData.note).toMatch(/settlement:\s*bank transfer/i);
  });

  it("appends 'MoMo' when payNow=true and paymentMode=momo", async () => {
    await POST(makePostReq({ category: "6200 Rent Expense", amount: 500, payNow: true, paymentMode: "momo" }));
    const createdData = mockExpenseCreate.mock.calls[0][0].data;
    expect(createdData.note).toMatch(/settlement:\s*MoMo/i);
  });

  it("calls postExpenseEntry after creating the expense", async () => {
    await POST(makePostReq({ category: "6200 Rent Expense", amount: 500, payNow: false }));
    expect(mockPostExpenseEntry).toHaveBeenCalledOnce();
    const firstPostExpenseEntryCall = mockPostExpenseEntry.mock.calls[0] as unknown as
      | [Record<string, unknown>]
      | undefined;
    expect(firstPostExpenseEntryCall?.[0]).toMatchObject({ amount: 500 });
  });

  it("does not append settlement note for reversal entries", async () => {
    mockExpenseCreate.mockResolvedValue({
      id: "e-rev",
      category: "6200 Rent Expense",
      amount: -300,
      vendor: null,
      reason: "Wrong amount",
      note: "Correction",
      isReversal: true,
      reversalOfId: "e1",
      createdAt: new Date(),
    });
    mockExpenseAggregate.mockResolvedValue({ _sum: { amount: 0 } });
    mockExpenseFindUnique.mockResolvedValue({ id: "e1", amount: 500, isReversal: false });
    await POST(
      makePostReq({
        category: "6200 Rent Expense",
        amount: -300,
        isReversal: true,
        reversalOfId: "e1",
        reason: "Wrong amount",
      }),
    );
    const createdData = mockExpenseCreate.mock.calls[0][0].data;
    expect(String(createdData.note ?? "")).not.toMatch(/settlement:/i);
  });

  it("records audit log with sourcePage=admin/expenses on success", async () => {
    await POST(makePostReq({ category: "6200 Rent Expense", amount: 500, payNow: false }));
    expect(mockRecordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "EXPENSE_CREATE",
        entityType: "EXPENSE",
        meta: expect.objectContaining({ sourcePage: "admin/expenses" }),
      }),
    );
  });

  it("returns 201-equivalent 200 response with created expense", async () => {
    const res = await POST(makePostReq({ category: "6200 Rent Expense", amount: 500, payNow: false }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("e-new");
    expect(body.category).toBe("6200 Rent Expense");
  });
});
