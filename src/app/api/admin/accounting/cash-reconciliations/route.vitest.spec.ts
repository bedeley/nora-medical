import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mock state ────────────────────────────────────────────────────
const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockFindClosedPeriod,
  mockLedgerAccountFindUnique,
  mockAppSettingFindUnique,
  mockCashReconciliationFindMany,
  mockCashReconciliationCreate,
  mockJournalLineFindMany,
  mockJournalLineAggregate,
  mockJournalEntryCreate,
  mockAuditLogCreate,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockAssertSameOrigin: vi.fn(),
  mockFindClosedPeriod: vi.fn(),
  mockLedgerAccountFindUnique: vi.fn(),
  mockAppSettingFindUnique: vi.fn(),
  mockCashReconciliationFindMany: vi.fn(),
  mockCashReconciliationCreate: vi.fn(),
  mockJournalLineFindMany: vi.fn(),
  mockJournalLineAggregate: vi.fn(),
  mockJournalEntryCreate: vi.fn(),
  mockAuditLogCreate: vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────
vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/origin", () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/accounting-periods", () => ({ findClosedPeriod: mockFindClosedPeriod }));
// Do NOT mock @/lib/otc-shift-close — let buildUtcDayRange run naturally
vi.mock("@/lib/prisma", () => ({
  prisma: {
    ledgerAccount: { findUnique: mockLedgerAccountFindUnique },
    appSetting: { findUnique: mockAppSettingFindUnique },
    cashReconciliation: {
      findMany: mockCashReconciliationFindMany,
      create: mockCashReconciliationCreate,
    },
    journalLine: {
      findMany: mockJournalLineFindMany,
      aggregate: mockJournalLineAggregate,
    },
    journalEntry: { create: mockJournalEntryCreate },
    auditLog: { create: mockAuditLogCreate },
  },
}));

// ── Import after mocks ────────────────────────────────────────────────────
import { POST } from "./route";

// ── Helpers ───────────────────────────────────────────────────────────────
const ADMIN_SESSION = { user: { id: "admin-1", role: "ADMIN" } };
const ACCOUNTANT_SESSION = { user: { id: "acct-1", role: "ACCOUNTANT" } };
const STAFF_SESSION = { user: { id: "staff-1", role: "STAFF" } };

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/admin/accounting/cash-reconciliations", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin: "http://localhost" },
  });
}

// Zero-variance valid body — actualAmount:0, expectedAmount:0 (journalLine.findMany → [])
const VALID_BODY = { countedAt: "2026-03-01", actualAmount: 0, cashAccountId: "acct-cash-1" };

const CASH_ACCOUNT = { id: "acct-cash-1", code: "1000", name: "Cash", type: "ASSET" };
const OVER_SHORT_ACCOUNT = { id: "acct-over-short", code: "6990", name: "Cash Over/Short", type: "EXPENSE" };

const BASE_RECONCILIATION = {
  id: "rec-1",
  cashAccountId: "acct-cash-1",
  countedAt: new Date(),
  expectedAmount: 0,
  actualAmount: 0,
  variance: 0,
  notes: null,
  journalEntryId: null,
  cashAccount: CASH_ACCOUNT,
  createdBy: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
  mockAssertSameOrigin.mockReturnValue(true);
  mockFindClosedPeriod.mockResolvedValue(null);
  mockAppSettingFindUnique.mockResolvedValue(null);
  mockLedgerAccountFindUnique.mockImplementation(
    ({ where }: { where?: { id?: string; code?: string } }) => {
      if (where?.id === "acct-cash-1") return Promise.resolve(CASH_ACCOUNT);
      if (where?.code === "6990") return Promise.resolve(OVER_SHORT_ACCOUNT);
      return Promise.resolve(null);
    },
  );
  mockCashReconciliationFindMany.mockResolvedValue([]);
  mockJournalLineFindMany.mockResolvedValue([]);
  // loadCashLedgerDelta calls journalLine.aggregate twice (end-of-day and start-of-day-1ms).
  // Default: zero balance so expectedAmount=0, matching VALID_BODY.actualAmount=0 → variance 0.
  mockJournalLineAggregate.mockResolvedValue({ _sum: { debit: 0, credit: 0 } });
  mockJournalEntryCreate.mockResolvedValue({ id: "entry-1" });
  mockCashReconciliationCreate.mockResolvedValue(BASE_RECONCILIATION);
  mockAuditLogCreate.mockResolvedValue({});
});

// ── Auth guard ─────────────────────────────────────────────────────────────

describe("POST /api/admin/accounting/cash-reconciliations – auth guard", () => {
  it("returns 401 when session is null", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Unauthorized");
  });

  it("returns 401 when role is STAFF", async () => {
    mockGetServerSession.mockResolvedValue(STAFF_SESSION);
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(401);
  });

  it("returns 200 when role is ACCOUNTANT (passes auth)", async () => {
    mockGetServerSession.mockResolvedValue(ACCOUNTANT_SESSION);
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(200);
  });
});

// ── CSRF guard ─────────────────────────────────────────────────────────────

describe("POST /api/admin/accounting/cash-reconciliations – CSRF guard", () => {
  it("returns 403 when assertSameOrigin returns false", async () => {
    mockAssertSameOrigin.mockReturnValue(false);
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Bad origin");
  });
});

// ── Input validation ───────────────────────────────────────────────────────

describe("POST /api/admin/accounting/cash-reconciliations – input validation", () => {
  it("returns 400 with 'Invalid input' when countedAt is missing", async () => {
    const res = await POST(makeRequest({ actualAmount: 0, cashAccountId: "acct-cash-1" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid input");
  });

  it("returns 400 when mode is an invalid enum value", async () => {
    const res = await POST(makeRequest({ ...VALID_BODY, mode: "realtime" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid input");
  });
});

// ── Cash account resolution ────────────────────────────────────────────────

describe("POST /api/admin/accounting/cash-reconciliations – cash account", () => {
  it("returns 404 when cash account is not found", async () => {
    // cashAccountId provided → findUnique({ where: { id } }) → null → 404
    mockLedgerAccountFindUnique.mockResolvedValue(null);
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Cash account not found");
  });
});

// ── Duplicate day ──────────────────────────────────────────────────────────

describe("POST /api/admin/accounting/cash-reconciliations – duplicate day", () => {
  const EXISTING_REC = {
    id: "rec-old",
    createdAt: new Date("2026-03-01T08:00:00Z"),
    variance: 0,
    createdBy: null,
  };

  it("returns 409 with code DAY_ALREADY_RECONCILED when existing reconciliation found and no override", async () => {
    mockCashReconciliationFindMany.mockResolvedValue([EXISTING_REC]);
    const res = await POST(makeRequest({ ...VALID_BODY, allowReopenOverride: false }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("DAY_ALREADY_RECONCILED");
    expect(body.error).toMatch(/already exists/i);
  });

  it("returns 400 when override is enabled but reopenReason is fewer than 10 characters", async () => {
    mockCashReconciliationFindMany.mockResolvedValue([EXISTING_REC]);
    const res = await POST(makeRequest({
      ...VALID_BODY,
      allowReopenOverride: true,
      reopenReason: "short",
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Override reason must be at least 10 characters.");
  });
});

// ── Variance validation ────────────────────────────────────────────────────

describe("POST /api/admin/accounting/cash-reconciliations – variance validation", () => {
  it("returns 400 with variance reason message when variance != 0 and no varianceReason provided", async () => {
    // actualAmount:100, expectedAmount:0 (journalLine.findMany → []) → variance = 100
    const res = await POST(makeRequest({ ...VALID_BODY, actualAmount: 100 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Variance reason is required when variance is non-zero.");
  });

  it("returns 400 with notes message when variance != 0, varianceReason set, but no notes provided", async () => {
    const res = await POST(makeRequest({
      ...VALID_BODY,
      actualAmount: 100,
      varianceReason: "COUNT_ERROR",
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Variance explanation is required when variance is non-zero.");
  });
});

// ── Closed period guard (variance path) ───────────────────────────────────

describe("POST /api/admin/accounting/cash-reconciliations – closed period guard", () => {
  it("returns 400 when variance is non-zero and countedAt falls in a closed period", async () => {
    mockFindClosedPeriod.mockResolvedValue({ id: "period-1", name: "March 2026" });
    const res = await POST(makeRequest({
      ...VALID_BODY,
      actualAmount: 100,
      varianceReason: "COUNT_ERROR",
      notes: "Found extra cash in drawer during end-of-day count.",
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/closed period/i);
  });
});

// ── Success ────────────────────────────────────────────────────────────────

describe("POST /api/admin/accounting/cash-reconciliations – success", () => {
  it("returns 200 and does NOT call journalEntry.create when variance is zero", async () => {
    // actualAmount:0, expectedAmount:0 → variance = 0 → no journal entry
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(200);
    expect(mockJournalEntryCreate).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.id).toBe("rec-1");
  });

  it("returns 200 and calls journalEntry.create when variance is non-zero", async () => {
    // actualAmount:100, expectedAmount:0 → variance = 100 → journal entry posted
    mockCashReconciliationCreate.mockResolvedValue({
      ...BASE_RECONCILIATION,
      actualAmount: 100,
      variance: 100,
      journalEntryId: "entry-1",
    });
    const res = await POST(makeRequest({
      ...VALID_BODY,
      actualAmount: 100,
      varianceReason: "COUNT_ERROR",
      notes: "Found extra cash in drawer during end-of-day count.",
    }));
    expect(res.status).toBe(200);
    expect(mockJournalEntryCreate).toHaveBeenCalledOnce();
    const body = await res.json();
    expect(body.id).toBe("rec-1");
  });
});
