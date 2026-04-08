import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mock state ────────────────────────────────────────────────────────
const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockFindClosedPeriod,
  mockLedgerAccountFindUnique,
  mockLedgerAccountCreate,
  mockAppSettingFindUnique,
  mockCashReconciliationFindFirst,
  mockCashReconciliationCreate,
  mockJournalLineAggregate,
  mockJournalEntryCreate,
  mockAuditLogCreate,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockAssertSameOrigin: vi.fn(),
  mockFindClosedPeriod: vi.fn(),
  mockLedgerAccountFindUnique: vi.fn(),
  mockLedgerAccountCreate: vi.fn(),
  mockAppSettingFindUnique: vi.fn(),
  mockCashReconciliationFindFirst: vi.fn(),
  mockCashReconciliationCreate: vi.fn(),
  mockJournalLineAggregate: vi.fn(),
  mockJournalEntryCreate: vi.fn(),
  mockAuditLogCreate: vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────────
vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/origin", () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/accounting-periods", () => ({ findClosedPeriod: mockFindClosedPeriod }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    appSetting: { findUnique: mockAppSettingFindUnique },
    ledgerAccount: {
      findUnique: mockLedgerAccountFindUnique,
      create: mockLedgerAccountCreate,
    },
    cashReconciliation: {
      findFirst: mockCashReconciliationFindFirst,
      create: mockCashReconciliationCreate,
    },
    journalLine: { aggregate: mockJournalLineAggregate },
    journalEntry: { create: mockJournalEntryCreate },
    auditLog: { create: mockAuditLogCreate },
  },
}));

import { POST } from "./route";

// ── Fixtures ──────────────────────────────────────────────────────────────────
const adminSession = { user: { id: "u1", role: "ADMIN" } };
const accountantSession = { user: { id: "u2", role: "ACCOUNTANT" } };

const cashAccount = { id: "ca1", code: "1000", name: "Cash", type: "ASSET" };
const obEquityAccount = { id: "eq1", code: "3900", name: "Opening Balance Equity", type: "EQUITY" };

function makeReq(body: Record<string, unknown>) {
  return new Request("http://localhost/api/admin/accounting/cash-reconciliations/opening-balance", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function setupHappyPath(glBalance = 4750, verifiedCount = 5000) {
  mockGetServerSession.mockResolvedValue(adminSession);
  mockAssertSameOrigin.mockReturnValue(true);
  mockFindClosedPeriod.mockResolvedValue(null);
  mockAppSettingFindUnique.mockResolvedValue(null);
  // Cash account resolution
  mockLedgerAccountFindUnique.mockImplementation(({ where }: { where: { code?: string; id?: string } }) => {
    if (where?.code === "1000" || where?.id === "ca1") return Promise.resolve(cashAccount);
    if (where?.code === "3900") return Promise.resolve(obEquityAccount);
    return Promise.resolve(null);
  });
  // No existing opening balance
  mockCashReconciliationFindFirst.mockResolvedValue(null);
  // GL balance
  const diff = glBalance;
  mockJournalLineAggregate.mockResolvedValue({
    _sum: { debit: diff, credit: 0 },
  });
  // Journal entry creation
  mockJournalEntryCreate.mockResolvedValue({ id: "je-ob" });
  // Reconciliation creation
  mockCashReconciliationCreate.mockResolvedValue({
    id: "rec-ob",
    cashAccountId: cashAccount.id,
    countedAt: new Date(),
    expectedAmount: verifiedCount,
    actualAmount: verifiedCount,
    variance: 0,
    reconcileMode: "opening_balance",
    isOpeningBalance: true,
    notes: "[OPENING_BALANCE]",
    cashAccount,
    createdBy: null,
  });
  mockAuditLogCreate.mockResolvedValue({});
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe("POST /api/admin/accounting/cash-reconciliations/opening-balance", () => {
  beforeEach(() => vi.clearAllMocks());

  // ── Auth guards ───────────────────────────────────────────────────────────

  it("returns 401 when unauthenticated", async () => {
    mockGetServerSession.mockResolvedValue(null);
    mockAssertSameOrigin.mockReturnValue(true);
    const res = await POST(makeReq({ verifiedCount: 5000 }));
    expect(res.status).toBe(401);
  });

  it("returns 401 for STAFF role", async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: "u3", role: "STAFF" } });
    mockAssertSameOrigin.mockReturnValue(true);
    const res = await POST(makeReq({ verifiedCount: 5000 }));
    expect(res.status).toBe(401);
  });

  it("allows ACCOUNTANT role", async () => {
    mockGetServerSession.mockResolvedValue(accountantSession);
    setupHappyPath();
    // override session
    mockGetServerSession.mockResolvedValue(accountantSession);
    const res = await POST(makeReq({ verifiedCount: 5000 }));
    expect(res.status).toBe(200);
  });

  // ── CSRF ──────────────────────────────────────────────────────────────────

  it("returns 403 when origin check fails", async () => {
    mockGetServerSession.mockResolvedValue(adminSession);
    mockAssertSameOrigin.mockReturnValue(false);
    const res = await POST(makeReq({ verifiedCount: 5000 }));
    expect(res.status).toBe(403);
  });

  // ── Input validation ──────────────────────────────────────────────────────

  it("returns 400 when verifiedCount is missing", async () => {
    mockGetServerSession.mockResolvedValue(adminSession);
    mockAssertSameOrigin.mockReturnValue(true);
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
  });

  it("returns 400 when verifiedCount is not a finite number", async () => {
    mockGetServerSession.mockResolvedValue(adminSession);
    mockAssertSameOrigin.mockReturnValue(true);
    const res = await POST(makeReq({ verifiedCount: "not-a-number" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when notes exceeds 500 chars", async () => {
    mockGetServerSession.mockResolvedValue(adminSession);
    mockAssertSameOrigin.mockReturnValue(true);
    const res = await POST(makeReq({ verifiedCount: 5000, notes: "x".repeat(501) }));
    expect(res.status).toBe(400);
  });

  // ── Closed period guard ───────────────────────────────────────────────────

  it("returns 400 when GL adjustment needed but period is closed", async () => {
    setupHappyPath(4000, 5000); // GL=4000, count=5000 → adjustment needed
    mockFindClosedPeriod.mockResolvedValue({ name: "March 2026" });
    const res = await POST(makeReq({ verifiedCount: 5000 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/closed period/i);
  });

  it("allows closed period when postGlAdjustment is false", async () => {
    setupHappyPath(4000, 5000);
    mockFindClosedPeriod.mockResolvedValue({ name: "March 2026" });
    const res = await POST(makeReq({ verifiedCount: 5000, postGlAdjustment: false }));
    expect(res.status).toBe(200);
  });

  // ── Duplicate opening balance guard ───────────────────────────────────────

  it("returns 409 when opening balance already exists for this account", async () => {
    setupHappyPath();
    mockCashReconciliationFindFirst.mockResolvedValue({
      id: "existing-ob",
      countedAt: new Date("2026-01-01"),
    });
    const res = await POST(makeReq({ verifiedCount: 5000 }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("OPENING_BALANCE_EXISTS");
    expect(body.existing.id).toBe("existing-ob");
  });

  // ── GL adjustment posting ─────────────────────────────────────────────────

  it("posts a journal entry when GL balance differs from verified count", async () => {
    setupHappyPath(4750, 5000); // GL=4750, count=5000 → adjustment +250
    const res = await POST(makeReq({ verifiedCount: 5000 }));
    expect(res.status).toBe(200);
    expect(mockJournalEntryCreate).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.glAdjustment).toBeCloseTo(250, 2);
    expect(body.adjustmentPosted).toBe(true);
  });

  it("does NOT post a journal entry when GL already matches verified count", async () => {
    setupHappyPath(5000, 5000); // GL=5000, count=5000 → no adjustment
    const res = await POST(makeReq({ verifiedCount: 5000 }));
    expect(res.status).toBe(200);
    expect(mockJournalEntryCreate).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.glAdjustment).toBeCloseTo(0, 2);
    expect(body.adjustmentPosted).toBe(false);
  });

  it("does NOT post a journal entry when postGlAdjustment is false even with difference", async () => {
    setupHappyPath(4000, 5000); // diff of 1000
    const res = await POST(makeReq({ verifiedCount: 5000, postGlAdjustment: false }));
    expect(res.status).toBe(200);
    expect(mockJournalEntryCreate).not.toHaveBeenCalled();
  });

  it("debits Cash when GL is understated (count > GL)", async () => {
    setupHappyPath(4000, 5000); // count 5000 > GL 4000 → debit Cash
    await POST(makeReq({ verifiedCount: 5000 }));
    const lines = mockJournalEntryCreate.mock.calls[0]?.[0]?.data?.lines?.create;
    const cashLine = lines?.find((l: { accountId: string }) => l.accountId === cashAccount.id);
    expect(cashLine?.debit).toBeCloseTo(1000, 2);
    expect(cashLine?.credit).toBe(0);
  });

  it("credits Cash when GL is overstated (count < GL)", async () => {
    setupHappyPath(6000, 5000); // count 5000 < GL 6000 → credit Cash
    const res = await POST(makeReq({ verifiedCount: 5000 }));
    expect(res.status).toBe(200);
    const lines = mockJournalEntryCreate.mock.calls[0]?.[0]?.data?.lines?.create;
    const cashLine = lines?.find((l: { accountId: string }) => l.accountId === cashAccount.id);
    expect(cashLine?.credit).toBeCloseTo(1000, 2);
    expect(cashLine?.debit).toBe(0);
  });

  // ── Reconciliation record ─────────────────────────────────────────────────

  it("creates CashReconciliation with isOpeningBalance=true and zero variance", async () => {
    setupHappyPath(4750, 5000);
    await POST(makeReq({ verifiedCount: 5000 }));
    const createArgs = mockCashReconciliationCreate.mock.calls[0]?.[0]?.data;
    expect(createArgs?.isOpeningBalance).toBe(true);
    expect(createArgs?.reconcileMode).toBe("opening_balance");
    expect(Number(createArgs?.variance)).toBe(0);
    expect(Number(createArgs?.expectedAmount)).toBe(5000);
    expect(Number(createArgs?.actualAmount)).toBe(5000);
  });

  it("records audit log entry", async () => {
    setupHappyPath(4750, 5000);
    await POST(makeReq({ verifiedCount: 5000 }));
    expect(mockAuditLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "CASH_OPENING_BALANCE_SET",
          entityType: "CASH_RECONCILIATION",
        }),
      }),
    );
  });

  // ── Response shape ────────────────────────────────────────────────────────

  it("returns correct response fields", async () => {
    setupHappyPath(4750, 5000);
    const res = await POST(makeReq({ verifiedCount: 5000, date: "2026-03-31" }));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.verifiedCount).toBe(5000);
    expect(body.previousGlBalance).toBe(4750);
    expect(body.glAdjustment).toBeCloseTo(250, 2);
    expect(body.date).toBe("2026-03-31");
    expect(body.cashAccountCode).toBe("1000");
  });

  // ── Auto-create equity account ────────────────────────────────────────────

  it("auto-creates Opening Balance Equity account (3900) if missing", async () => {
    setupHappyPath(4750, 5000);
    mockLedgerAccountFindUnique.mockImplementation(({ where }: { where: { code?: string } }) => {
      if (where?.code === "1000") return Promise.resolve(cashAccount);
      if (where?.code === "3900") return Promise.resolve(null); // missing
      return Promise.resolve(null);
    });
    mockLedgerAccountCreate.mockResolvedValue(obEquityAccount);
    const res = await POST(makeReq({ verifiedCount: 5000 }));
    expect(res.status).toBe(200);
    expect(mockLedgerAccountCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ code: "3900", type: "EQUITY" }),
      }),
    );
  });

  // ── Error handling ────────────────────────────────────────────────────────

  it("returns 500 when Prisma throws unexpectedly", async () => {
    setupHappyPath();
    mockCashReconciliationCreate.mockRejectedValue(new Error("DB failure"));
    const res = await POST(makeReq({ verifiedCount: 5000 }));
    expect(res.status).toBe(500);
  });
});
