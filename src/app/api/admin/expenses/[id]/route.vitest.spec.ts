import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must be declared before any imports that reference them
// ---------------------------------------------------------------------------
const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockRateLimit,
  mockRecordAuditLog,
  mockPostExpenseEntry,
  mockExpenseFindUnique,
  mockExpenseFindMany,
  mockExpenseCount,
  mockExpenseUpdate,
  mockJournalEntryFindFirst,
  mockJournalEntryFindMany,
  mockJournalEntryCount,
  mockJournalEntryUpdate,
  mockLedgerAccountFindUnique,
  mockAuditLogFindMany,
} = vi.hoisted(() => {
  return {
    mockGetServerSession: vi.fn(),
    mockAssertSameOrigin: vi.fn(),
    mockRateLimit: vi.fn(),
    mockRecordAuditLog: vi.fn(),
    mockPostExpenseEntry: vi.fn(),
    mockExpenseFindUnique: vi.fn(),
    mockExpenseFindMany: vi.fn(),
    mockExpenseCount: vi.fn(),
    mockExpenseUpdate: vi.fn(),
    mockJournalEntryFindFirst: vi.fn(),
    mockJournalEntryFindMany: vi.fn(),
    mockJournalEntryCount: vi.fn(),
    mockJournalEntryUpdate: vi.fn(),
    mockLedgerAccountFindUnique: vi.fn(),
    mockAuditLogFindMany: vi.fn(),
  };
});

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/origin", () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mockRateLimit }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: mockRecordAuditLog }));
vi.mock("@/lib/accounting-posting", () => ({ postExpenseEntry: mockPostExpenseEntry }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    expense: {
      findUnique: mockExpenseFindUnique,
      findMany: mockExpenseFindMany,
      count: mockExpenseCount,
      update: mockExpenseUpdate,
    },
    journalEntry: {
      findFirst: mockJournalEntryFindFirst,
      findMany: mockJournalEntryFindMany,
      count: mockJournalEntryCount,
      update: mockJournalEntryUpdate,
    },
    ledgerAccount: {
      findUnique: mockLedgerAccountFindUnique,
    },
    auditLog: {
      findMany: mockAuditLogFindMany,
    },
  },
}));

// ---------------------------------------------------------------------------
// Import SUT after mocks
// ---------------------------------------------------------------------------
import { DELETE, GET, PATCH, POST } from "./route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeReq(body?: unknown): Request {
  return new Request("http://localhost/api/admin/expenses/e1", {
    method: "PATCH",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function makeGetReq() {
  return new Request("http://localhost/api/admin/expenses/e1");
}

function makeParams(id = "e1"): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

const adminSession = { user: { id: "user1", role: "ADMIN" } };
const accountantSession = { user: { id: "user2", role: "ACCOUNTANT" } };
const staffSession = { user: { id: "user3", role: "STAFF" } };

// Expense created 1 hour ago (within 48h edit window)
function recentExpense(overrides = {}) {
  return {
    id: "e1",
    createdAt: new Date(Date.now() - 60 * 60 * 1000),
    isReversal: false,
    amount: 100,
    category: "5100 - Office Supplies",
    note: "old note",
    reason: "old reason",
    vendor: "Vendor A",
    deletedAt: null,
    payrollRunId: null,
    reversalOfId: null,
    ...overrides,
  };
}

// Expense created 50 hours ago (outside 48h window)
function staleExpense(overrides = {}) {
  return recentExpense({ createdAt: new Date(Date.now() - 50 * 60 * 60 * 1000), ...overrides });
}

function validCategory() {
  return { id: "acc1", type: "EXPENSE", isActive: true };
}

// ---------------------------------------------------------------------------
// GET tests
// ---------------------------------------------------------------------------
describe("GET /api/admin/expenses/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetServerSession.mockResolvedValue(adminSession);
    mockExpenseCount.mockResolvedValue(0);
    mockJournalEntryCount.mockResolvedValue(0);
    mockExpenseFindMany.mockResolvedValue([]);
    mockJournalEntryFindMany.mockResolvedValue([]);
    mockAuditLogFindMany.mockResolvedValue([]);
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await GET(makeGetReq(), makeParams());
    expect(res.status).toBe(401);
  });

  it("returns 404 when expense is missing", async () => {
    mockExpenseFindUnique.mockResolvedValue(null);
    const res = await GET(makeGetReq(), makeParams());
    expect(res.status).toBe(404);
  });

  it("returns expense detail payload with metrics and audits", async () => {
    mockExpenseFindUnique
      .mockResolvedValueOnce(recentExpense({ amount: 500, category: "6200 Rent Expense" }))
      .mockResolvedValueOnce(null);
    mockExpenseFindMany.mockResolvedValue([
      recentExpense({ id: "rev1", amount: -150, isReversal: true, reversalOfId: "e1", reason: "Correction" }),
    ]);
    mockJournalEntryFindMany.mockResolvedValue([
      {
        id: "je1",
        sourceId: "e1:settlement:1",
        memo: "Expense settlement - 6200 Rent Expense",
        entryDate: new Date("2024-01-16T00:00:00Z"),
        createdAt: new Date("2024-01-16T00:00:00Z"),
        status: "POSTED",
        lines: [
          {
            debit: 200,
            credit: 0,
            description: "Settlement",
            account: { code: "2300", name: "Accrued expenses" },
          },
        ],
      },
    ]);
    mockAuditLogFindMany.mockResolvedValue([
      {
        id: "audit-1",
        action: "EXPENSE_SETTLE",
        outcome: "SUCCESS",
        meta: JSON.stringify({ amount: 200 }),
        createdAt: new Date("2024-01-16T00:00:00Z"),
        actor: { id: "u1", name: "Admin", email: "admin@test.com" },
      },
    ]);

    const res = await GET(makeGetReq(), makeParams());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.expense.id).toBe("e1");
    expect(body.metrics.settlementPaid).toBe(200);
    expect(body.metrics.remainingAfterReversals).toBe(350);
    expect(body.reversals).toHaveLength(1);
    expect(body.audits[0].meta.amount).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// PATCH tests
// ---------------------------------------------------------------------------
describe("PATCH /api/admin/expenses/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertSameOrigin.mockReturnValue(true);
    mockRateLimit.mockResolvedValue({ ok: true });
    mockRecordAuditLog.mockResolvedValue(undefined);
    mockPostExpenseEntry.mockResolvedValue({ id: "je1" });
    mockJournalEntryFindFirst.mockResolvedValue(null);
    mockJournalEntryFindMany.mockResolvedValue([]);
    mockJournalEntryCount.mockResolvedValue(0);
    mockExpenseFindMany.mockResolvedValue([]);
    mockExpenseCount.mockResolvedValue(0);
    mockAuditLogFindMany.mockResolvedValue([]);
    mockLedgerAccountFindUnique.mockResolvedValue(validCategory());
    mockExpenseUpdate.mockImplementation(async ({ data }) => ({
      id: "e1",
      amount: data.amount ?? 100,
      category: data.category ?? "5100 - Office Supplies",
      note: data.note ?? "old note",
      reason: data.reason ?? "old reason",
      createdAt: new Date(),
      isReversal: false,
    }));
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await PATCH(makeReq({ reason: "test" }), makeParams());
    expect(res.status).toBe(401);
  });

  it("returns 401 when role is STAFF", async () => {
    mockGetServerSession.mockResolvedValue(staffSession);
    const res = await PATCH(makeReq({ reason: "test" }), makeParams());
    expect(res.status).toBe(401);
  });

  it("allows ACCOUNTANT role", async () => {
    mockGetServerSession.mockResolvedValue(accountantSession);
    mockExpenseFindUnique.mockResolvedValue(recentExpense());
    const res = await PATCH(makeReq({ reason: "update" }), makeParams());
    expect(res.status).toBe(200);
  });

  it("returns 403 when origin check fails", async () => {
    mockGetServerSession.mockResolvedValue(adminSession);
    mockAssertSameOrigin.mockReturnValue(false);
    const res = await PATCH(makeReq({ reason: "test" }), makeParams());
    expect(res.status).toBe(403);
  });

  it("returns 404 when expense not found", async () => {
    mockGetServerSession.mockResolvedValue(adminSession);
    mockExpenseFindUnique.mockResolvedValue(null);
    const res = await PATCH(makeReq({ reason: "test" }), makeParams());
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
  });

  it("returns 403 when expense is a reversal", async () => {
    mockGetServerSession.mockResolvedValue(adminSession);
    mockExpenseFindUnique.mockResolvedValue(recentExpense({ isReversal: true }));
    const res = await PATCH(makeReq({ reason: "test" }), makeParams());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/reversal/i);
  });

  it("returns 403 when expense is older than 48h", async () => {
    mockGetServerSession.mockResolvedValue(adminSession);
    mockExpenseFindUnique.mockResolvedValue(staleExpense());
    const res = await PATCH(makeReq({ reason: "test" }), makeParams());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/48 hours/i);
  });

  it("returns 400 when reason is missing", async () => {
    mockGetServerSession.mockResolvedValue(adminSession);
    mockExpenseFindUnique.mockResolvedValue(recentExpense());
    const res = await PATCH(makeReq({ amount: 200 }), makeParams());
    expect(res.status).toBe(400);
  });

  it("updates successfully with valid payload (reason only)", async () => {
    mockGetServerSession.mockResolvedValue(adminSession);
    mockExpenseFindUnique.mockResolvedValue(recentExpense());
    const res = await PATCH(makeReq({ reason: "corrected reason" }), makeParams());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("e1");
  });

  it("does NOT void/repost journal when only reason changes", async () => {
    mockGetServerSession.mockResolvedValue(adminSession);
    mockExpenseFindUnique.mockResolvedValue(recentExpense({ amount: 100, category: "5100 - Office Supplies" }));
    await PATCH(makeReq({ reason: "new reason" }), makeParams());
    expect(mockJournalEntryFindFirst).not.toHaveBeenCalled();
    expect(mockPostExpenseEntry).not.toHaveBeenCalled();
  });

  it("voids old journal entry and reposts when amount changes", async () => {
    mockGetServerSession.mockResolvedValue(adminSession);
    mockExpenseFindUnique.mockResolvedValue(recentExpense({ amount: 100, category: "5100 - Office Supplies" }));
    mockJournalEntryFindFirst.mockResolvedValue({ id: "je-old" });
    const res = await PATCH(makeReq({ amount: 200, reason: "price corrected" }), makeParams());
    expect(res.status).toBe(200);
    expect(mockJournalEntryUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "je-old" }, data: { status: "VOID" } })
    );
    expect(mockPostExpenseEntry).toHaveBeenCalledOnce();
  });

  it("reposts journal when category changes", async () => {
    mockGetServerSession.mockResolvedValue(adminSession);
    mockExpenseFindUnique.mockResolvedValue(recentExpense({ category: "5100 - Office Supplies" }));
    mockJournalEntryFindFirst.mockResolvedValue({ id: "je-old" });
    const res = await PATCH(
      makeReq({ category: "5200 - Marketing", reason: "recategorized" }),
      makeParams()
    );
    expect(res.status).toBe(200);
    expect(mockJournalEntryUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "VOID" } })
    );
    expect(mockPostExpenseEntry).toHaveBeenCalledOnce();
  });

  it("skips void step when no existing journal entry found", async () => {
    mockGetServerSession.mockResolvedValue(adminSession);
    mockExpenseFindUnique.mockResolvedValue(recentExpense({ amount: 100 }));
    mockJournalEntryFindFirst.mockResolvedValue(null);
    const res = await PATCH(makeReq({ amount: 250, reason: "increase" }), makeParams());
    expect(res.status).toBe(200);
    expect(mockJournalEntryUpdate).not.toHaveBeenCalled();
    expect(mockPostExpenseEntry).toHaveBeenCalledOnce();
  });

  it("includes audit log with previousAmount, amountChanged, journalReposted, sourcePage", async () => {
    mockGetServerSession.mockResolvedValue(adminSession);
    mockExpenseFindUnique.mockResolvedValue(recentExpense({ amount: 100, category: "5100 - Office Supplies" }));
    mockJournalEntryFindFirst.mockResolvedValue({ id: "je-old" });
    await PATCH(makeReq({ amount: 200, reason: "price corrected" }), makeParams());
    expect(mockRecordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "EXPENSE_UPDATE",
        entityType: "EXPENSE",
        entityId: "e1",
        meta: expect.objectContaining({
          sourcePage: "admin/expenses",
          previousAmount: 100,
          amountChanged: true,
          journalReposted: true,
        }),
      })
    );
  });

  it("audit log includes previousCategory and categoryChanged flag", async () => {
    mockGetServerSession.mockResolvedValue(adminSession);
    mockExpenseFindUnique.mockResolvedValue(recentExpense({ category: "5100 - Office Supplies" }));
    await PATCH(
      makeReq({ category: "5200 - Marketing", reason: "recategorized" }),
      makeParams()
    );
    expect(mockRecordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({
          previousCategory: "5100 - Office Supplies",
          categoryChanged: true,
        }),
      })
    );
  });

  it("rejects system-driven category (COGS)", async () => {
    mockGetServerSession.mockResolvedValue(adminSession);
    mockExpenseFindUnique.mockResolvedValue(recentExpense());
    const res = await PATCH(
      makeReq({ category: "5000 - Cost of Goods Sold", reason: "test" }),
      makeParams()
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/system-driven/i);
  });
});

// ---------------------------------------------------------------------------
// DELETE tests
// ---------------------------------------------------------------------------
describe("DELETE /api/admin/expenses/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertSameOrigin.mockReturnValue(true);
    mockRateLimit.mockResolvedValue({ ok: true });
    mockRecordAuditLog.mockResolvedValue(undefined);
    mockExpenseCount.mockResolvedValue(0);
    mockJournalEntryCount.mockResolvedValue(0);
    mockExpenseFindMany.mockResolvedValue([]);
    mockJournalEntryFindMany.mockResolvedValue([]);
    mockAuditLogFindMany.mockResolvedValue([]);
    mockExpenseUpdate.mockResolvedValue({ id: "e1" });
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await DELETE(makeReq(), makeParams());
    expect(res.status).toBe(401);
  });

  it("returns 401 when role is STAFF", async () => {
    mockGetServerSession.mockResolvedValue(staffSession);
    const res = await DELETE(makeReq(), makeParams());
    expect(res.status).toBe(401);
  });

  it("returns 403 when origin check fails", async () => {
    mockGetServerSession.mockResolvedValue(adminSession);
    mockAssertSameOrigin.mockReturnValue(false);
    const res = await DELETE(makeReq(), makeParams());
    expect(res.status).toBe(403);
  });

  it("returns 404 when expense not found", async () => {
    mockGetServerSession.mockResolvedValue(adminSession);
    mockExpenseFindUnique.mockResolvedValue(null);
    const res = await DELETE(makeReq(), makeParams());
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
  });

  it("returns 403 when expense is a reversal", async () => {
    mockGetServerSession.mockResolvedValue(adminSession);
    mockExpenseFindUnique.mockResolvedValue(recentExpense({ isReversal: true }));
    const res = await DELETE(makeReq(), makeParams());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/reversal/i);
  });

  it("returns 403 when expense is older than 48h", async () => {
    mockGetServerSession.mockResolvedValue(adminSession);
    mockExpenseFindUnique.mockResolvedValue(staleExpense());
    const res = await DELETE(makeReq(), makeParams());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/48 hours/i);
  });

  it("soft-deletes by setting deletedAt", async () => {
    mockGetServerSession.mockResolvedValue(adminSession);
    mockExpenseFindUnique.mockResolvedValue(recentExpense());
    const res = await DELETE(makeReq(), makeParams());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(mockExpenseUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "e1" },
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      })
    );
  });

  it("records audit log with sourcePage, category, amount, vendor", async () => {
    mockGetServerSession.mockResolvedValue(adminSession);
    mockExpenseFindUnique.mockResolvedValue(
      recentExpense({ category: "5100 - Office Supplies", amount: 250, vendor: "Vendor X" })
    );
    await DELETE(makeReq(), makeParams());
    expect(mockRecordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "EXPENSE_DELETE",
        entityType: "EXPENSE",
        entityId: "e1",
        meta: expect.objectContaining({
          sourcePage: "admin/expenses",
          category: "5100 - Office Supplies",
          amount: 250,
          vendor: "Vendor X",
        }),
      })
    );
  });

  it("allows ACCOUNTANT role to delete", async () => {
    mockGetServerSession.mockResolvedValue(accountantSession);
    mockExpenseFindUnique.mockResolvedValue(recentExpense());
    const res = await DELETE(makeReq(), makeParams());
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// POST (restore) tests
// ---------------------------------------------------------------------------
describe("POST /api/admin/expenses/[id] (restore)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertSameOrigin.mockReturnValue(true);
    mockRateLimit.mockResolvedValue({ ok: true });
    mockRecordAuditLog.mockResolvedValue(undefined);
    mockExpenseCount.mockResolvedValue(0);
    mockJournalEntryCount.mockResolvedValue(0);
    mockExpenseFindMany.mockResolvedValue([]);
    mockJournalEntryFindMany.mockResolvedValue([]);
    mockAuditLogFindMany.mockResolvedValue([]);
    mockExpenseUpdate.mockResolvedValue({ id: "e1" });
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await POST(makeReq(), makeParams());
    expect(res.status).toBe(401);
  });

  it("returns 401 when role is STAFF", async () => {
    mockGetServerSession.mockResolvedValue(staffSession);
    const res = await POST(makeReq(), makeParams());
    expect(res.status).toBe(401);
  });

  it("returns 403 when origin check fails", async () => {
    mockGetServerSession.mockResolvedValue(adminSession);
    mockAssertSameOrigin.mockReturnValue(false);
    const res = await POST(makeReq(), makeParams());
    expect(res.status).toBe(403);
  });

  it("returns 404 when expense not found", async () => {
    mockGetServerSession.mockResolvedValue(adminSession);
    mockExpenseFindUnique.mockResolvedValue(null);
    const res = await POST(makeReq(), makeParams());
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
  });

  it("returns 400 when expense is not deleted", async () => {
    mockGetServerSession.mockResolvedValue(adminSession);
    mockExpenseFindUnique.mockResolvedValue({
      id: "e1",
      deletedAt: null,
      category: "5100 - Office Supplies",
      amount: 100,
      vendor: null,
    });
    const res = await POST(makeReq(), makeParams());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/not deleted/i);
  });

  it("restores a deleted expense (sets deletedAt to null)", async () => {
    mockGetServerSession.mockResolvedValue(adminSession);
    mockExpenseFindUnique.mockResolvedValue({
      id: "e1",
      deletedAt: new Date(),
      category: "5100 - Office Supplies",
      amount: 100,
      vendor: "Vendor B",
    });
    const res = await POST(makeReq(), makeParams());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(mockExpenseUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "e1" },
        data: { deletedAt: null },
      })
    );
  });

  it("records audit log with sourcePage and restoredAt", async () => {
    mockGetServerSession.mockResolvedValue(adminSession);
    mockExpenseFindUnique.mockResolvedValue({
      id: "e1",
      deletedAt: new Date(),
      category: "5100 - Office Supplies",
      amount: 150,
      vendor: "Vendor C",
    });
    await POST(makeReq(), makeParams());
    expect(mockRecordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "EXPENSE_RESTORE",
        entityType: "EXPENSE",
        entityId: "e1",
        meta: expect.objectContaining({
          sourcePage: "admin/expenses",
          expenseId: "e1",
          category: "5100 - Office Supplies",
          amount: 150,
          restoredAt: expect.any(String),
        }),
      })
    );
  });

  it("allows ACCOUNTANT role to restore", async () => {
    mockGetServerSession.mockResolvedValue(accountantSession);
    mockExpenseFindUnique.mockResolvedValue({
      id: "e1",
      deletedAt: new Date(),
      category: "5100 - Office Supplies",
      amount: 100,
      vendor: null,
    });
    const res = await POST(makeReq(), makeParams());
    expect(res.status).toBe(200);
  });
});
