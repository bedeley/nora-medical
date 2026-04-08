import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mock state ────────────────────────────────────────────────────
const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockPrismaJournalEntryCreate,
  mockPrismaJournalEntryFindMany,
  mockPrismaJournalEntryCount,
  mockPrismaJournalLineFindMany,
  mockPrismaJournalLineGroupBy,
  mockPrismaLedgerAccountFindMany,
  mockPrismaAppSettingFindUnique,
  mockPrismaFiscalPeriodFindFirst,
  mockPrismaFiscalPeriodFindUnique,
  mockPrismaOrderFindMany,
  mockPrismaPaymentFindMany,
  mockPrismaPurchaseFindMany,
  mockPrismaSupplierPaymentFindMany,
  mockPrismaSupplierPaymentGroupBy,
  mockFindClosedPeriod,
  mockLoadAccountingJournalPolicy,
  mockNormalizeJournalSearchQuery,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockAssertSameOrigin: vi.fn(),
  mockPrismaJournalEntryCreate: vi.fn(),
  mockPrismaJournalEntryFindMany: vi.fn(),
  mockPrismaJournalEntryCount: vi.fn(),
  mockPrismaJournalLineFindMany: vi.fn(),
  mockPrismaJournalLineGroupBy: vi.fn(),
  mockPrismaLedgerAccountFindMany: vi.fn(),
  mockPrismaAppSettingFindUnique: vi.fn(),
  mockPrismaFiscalPeriodFindFirst: vi.fn(),
  mockPrismaFiscalPeriodFindUnique: vi.fn(),
  mockPrismaOrderFindMany: vi.fn(),
  mockPrismaPaymentFindMany: vi.fn(),
  mockPrismaPurchaseFindMany: vi.fn(),
  mockPrismaSupplierPaymentFindMany: vi.fn(),
  mockPrismaSupplierPaymentGroupBy: vi.fn(),
  mockFindClosedPeriod: vi.fn(),
  mockLoadAccountingJournalPolicy: vi.fn(),
  mockNormalizeJournalSearchQuery: vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────
vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/origin", () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: vi.fn() }));
vi.mock("@/lib/accounting-periods", () => ({ findClosedPeriod: mockFindClosedPeriod }));
vi.mock("@/lib/accounting-journal-policy", () => ({
  loadAccountingJournalPolicy: mockLoadAccountingJournalPolicy,
}));
vi.mock("@/lib/accounting-journal-query", () => ({
  applyIdsOnlyCap: vi.fn((ids: string[]) => ids),
  compareJournalStatus: vi.fn(() => 0),
  normalizeJournalSearchQuery: mockNormalizeJournalSearchQuery,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    journalEntry: {
      create: mockPrismaJournalEntryCreate,
      findMany: mockPrismaJournalEntryFindMany,
      count: mockPrismaJournalEntryCount,
    },
    journalLine: {
      findMany: mockPrismaJournalLineFindMany,
      groupBy: mockPrismaJournalLineGroupBy,
    },
    ledgerAccount: { findMany: mockPrismaLedgerAccountFindMany },
    appSetting: { findUnique: mockPrismaAppSettingFindUnique },
    fiscalPeriod: {
      findFirst: mockPrismaFiscalPeriodFindFirst,
      findUnique: mockPrismaFiscalPeriodFindUnique,
    },
    order: { findMany: mockPrismaOrderFindMany },
    payment: { findMany: mockPrismaPaymentFindMany },
    purchase: { findMany: mockPrismaPurchaseFindMany },
    supplierPayment: {
      findMany: mockPrismaSupplierPaymentFindMany,
      groupBy: mockPrismaSupplierPaymentGroupBy,
    },
  },
}));

// ── Import after mocks ────────────────────────────────────────────────────
import { GET, POST } from "./route";

// ── Helpers ───────────────────────────────────────────────────────────────
const ADMIN_SESSION = { user: { id: "u1", role: "ADMIN", email: "admin@example.com" } };
const ACCOUNTANT_SESSION = { user: { id: "u2", role: "ACCOUNTANT", email: "ac@example.com" } };
const STAFF_SESSION = { user: { id: "u3", role: "STAFF" } };

function makeRequest(method: "GET" | "POST", body?: unknown, search = ""): Request {
  const url = `http://localhost:3000/api/admin/accounting/journal${search}`;
  if (method === "GET") {
    return new Request(url, { method: "GET", headers: { origin: "http://localhost:3000" } });
  }
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify(body),
  });
}

// A balanced two-line entry (debit = credit = 100)
const validEntry = {
  entryDate: "2026-03-01",
  sourceType: "PAYMENT",
  sourceId: "payment-123",
  memo: "Test payment entry",
  lines: [
    { accountId: "acc-cash", debit: 100, credit: 0 },
    { accountId: "acc-ar", debit: 0, credit: 100 },
  ],
};

const mockCreatedEntry = {
  id: "entry-1",
  entryDate: new Date("2026-03-01"),
  sourceType: "PAYMENT",
  sourceId: "payment-123",
  status: "POSTED",
  memo: "Test payment entry",
  lines: [
    { id: "line-1", accountId: "acc-cash", debit: 100, credit: 0 },
    { id: "line-2", accountId: "acc-ar", debit: 0, credit: 100 },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no closed period, policy allows all
  mockFindClosedPeriod.mockResolvedValue(null);
  mockLoadAccountingJournalPolicy.mockResolvedValue({
    recentWindowDays: 90,
    manualEntryAllowPnl: false,
  });
  mockNormalizeJournalSearchQuery.mockReturnValue({ ok: true, q: "" });
  mockPrismaAppSettingFindUnique.mockResolvedValue(null);
  mockPrismaLedgerAccountFindMany.mockResolvedValue([]);
  mockPrismaOrderFindMany.mockResolvedValue([]);
  mockPrismaPaymentFindMany.mockResolvedValue([]);
  mockPrismaPurchaseFindMany.mockResolvedValue([]);
  mockPrismaSupplierPaymentFindMany.mockResolvedValue([]);
  mockPrismaSupplierPaymentGroupBy.mockResolvedValue([]);
});

// ── GET – auth guard ───────────────────────────────────────────────────────

describe("GET /api/admin/accounting/journal – auth guard", () => {
  it("returns 401 when no session", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await GET(makeRequest("GET"));
    expect(res.status).toBe(401);
  });

  it("returns 401 when role is STAFF", async () => {
    mockGetServerSession.mockResolvedValue(STAFF_SESSION);
    const res = await GET(makeRequest("GET"));
    expect(res.status).toBe(401);
  });

  it("returns 200 for ADMIN", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockPrismaJournalEntryFindMany.mockResolvedValue([]);
    const res = await GET(makeRequest("GET", undefined, "?start=2026-01-01&end=2026-03-31"));
    expect(res.status).toBe(200);
  });

  it("returns 200 for ACCOUNTANT", async () => {
    mockGetServerSession.mockResolvedValue(ACCOUNTANT_SESSION);
    mockPrismaJournalEntryFindMany.mockResolvedValue([]);
    const res = await GET(makeRequest("GET", undefined, "?start=2026-01-01&end=2026-03-31"));
    expect(res.status).toBe(200);
  });
});

// ── GET – search query validation ─────────────────────────────────────────

describe("GET /api/admin/accounting/journal – search validation", () => {
  it("returns 400 when search query is invalid", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockNormalizeJournalSearchQuery.mockReturnValue({ ok: false, error: "Invalid query" });
    const res = await GET(makeRequest("GET", undefined, "?q=bad%%query"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid query");
  });
});

// ── POST – auth guard ──────────────────────────────────────────────────────

describe("POST /api/admin/accounting/journal – auth guard", () => {
  it("returns 401 when no session", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await POST(makeRequest("POST", validEntry));
    expect(res.status).toBe(401);
  });

  it("returns 401 when role is STAFF", async () => {
    mockGetServerSession.mockResolvedValue(STAFF_SESSION);
    const res = await POST(makeRequest("POST", validEntry));
    expect(res.status).toBe(401);
  });
});

// ── POST – CSRF guard ──────────────────────────────────────────────────────

describe("POST /api/admin/accounting/journal – CSRF guard", () => {
  it("returns 403 when assertSameOrigin returns false", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockAssertSameOrigin.mockReturnValue(false);
    const res = await POST(makeRequest("POST", validEntry));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Bad origin");
  });
});

// ── POST – schema validation ───────────────────────────────────────────────

describe("POST /api/admin/accounting/journal – schema validation", () => {
  beforeEach(() => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockAssertSameOrigin.mockReturnValue(true);
  });

  it("returns 400 when entryDate is missing", async () => {
    const res = await POST(makeRequest("POST", {
      sourceType: "PAYMENT",
      lines: [
        { accountId: "acc-1", debit: 100, credit: 0 },
        { accountId: "acc-2", debit: 0, credit: 100 },
      ],
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid input");
  });

  it("returns 400 when lines has fewer than 2 entries", async () => {
    const res = await POST(makeRequest("POST", {
      entryDate: "2026-03-01",
      sourceType: "PAYMENT",
      lines: [{ accountId: "acc-1", debit: 100, credit: 0 }],
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid input");
  });

  it("returns 400 when debits do not equal credits", async () => {
    const res = await POST(makeRequest("POST", {
      entryDate: "2026-03-01",
      sourceType: "PAYMENT",
      lines: [
        { accountId: "acc-1", debit: 100, credit: 0 },
        { accountId: "acc-2", debit: 0, credit: 50 }, // 100 debit ≠ 50 credit
      ],
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid input");
  });

  it("returns 400 when a line has both debit and credit", async () => {
    const res = await POST(makeRequest("POST", {
      entryDate: "2026-03-01",
      sourceType: "PAYMENT",
      lines: [
        { accountId: "acc-1", debit: 100, credit: 50 }, // both set
        { accountId: "acc-2", debit: 0, credit: 50 },
      ],
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid input");
  });

  it("returns 400 when sourceType is invalid", async () => {
    const res = await POST(makeRequest("POST", {
      entryDate: "2026-03-01",
      sourceType: "UNKNOWN_TYPE",
      lines: [
        { accountId: "acc-1", debit: 100, credit: 0 },
        { accountId: "acc-2", debit: 0, credit: 100 },
      ],
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid input");
  });
});

// ── POST – MANUAL entry guards ─────────────────────────────────────────────

describe("POST /api/admin/accounting/journal – MANUAL entry guards", () => {
  beforeEach(() => {
    mockAssertSameOrigin.mockReturnValue(true);
    // Give appSetting a monthly calendar policy (within window — avoid exception note check)
    mockPrismaAppSettingFindUnique.mockResolvedValue(null); // use defaults
    // Put entryDate near end of month so it's within the 5-day window
    // 2026-03-31 is end of month; entry on 2026-03-28 → 3 days to end ≤ 5 days
    mockPrismaLedgerAccountFindMany.mockResolvedValue([
      { id: "acc-cash", type: "ASSET" },
      { id: "acc-equity", type: "EQUITY" },
    ]);
  });

  const manualEntry = {
    entryDate: "2026-03-28", // within 5-day month-end window
    sourceType: "MANUAL",
    memo: "Reclassification adjustment",
    manualCategory: "RECLASSIFICATION",
    lines: [
      { accountId: "acc-cash", debit: 200, credit: 0 },
      { accountId: "acc-equity", debit: 0, credit: 200 },
    ],
  };

  it("returns 403 when ACCOUNTANT tries to create a manual entry", async () => {
    mockGetServerSession.mockResolvedValue(ACCOUNTANT_SESSION);
    const res = await POST(makeRequest("POST", manualEntry));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/limited to admins/i);
  });

  it("returns 400 when MANUAL entry has no memo", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    const res = await POST(makeRequest("POST", { ...manualEntry, memo: "" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/memo/i);
  });

  it("returns 400 when MANUAL entry has no manualCategory", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    const res = await POST(makeRequest("POST", { ...manualEntry, manualCategory: undefined }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/adjustment category/i);
  });

  it("returns 400 when MANUAL entry posts to INCOME account (policy disallows PnL)", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockPrismaLedgerAccountFindMany.mockResolvedValue([
      { id: "acc-cash", type: "ASSET" },
      { id: "acc-income", type: "INCOME" }, // not allowed
    ]);
    const res = await POST(makeRequest("POST", {
      ...manualEntry,
      lines: [
        { accountId: "acc-cash", debit: 200, credit: 0 },
        { accountId: "acc-income", debit: 0, credit: 200 },
      ],
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/income\/expense/i);
  });

  it("returns 200 when ADMIN creates valid MANUAL entry within period-end window", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockPrismaJournalEntryCreate.mockResolvedValue({ ...mockCreatedEntry, sourceType: "MANUAL" });
    const res = await POST(makeRequest("POST", manualEntry));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("entry-1");
  });
});

// ── POST – closed period guard ─────────────────────────────────────────────

describe("POST /api/admin/accounting/journal – closed period guard", () => {
  beforeEach(() => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockAssertSameOrigin.mockReturnValue(true);
  });

  it("returns 400 when entry date falls in a closed period", async () => {
    mockFindClosedPeriod.mockResolvedValue({ id: "period-1", name: "January 2026" });
    const res = await POST(makeRequest("POST", validEntry));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/closed/i);
  });
});

// ── POST – successful creation ─────────────────────────────────────────────

describe("POST /api/admin/accounting/journal – success", () => {
  beforeEach(() => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockAssertSameOrigin.mockReturnValue(true);
  });

  it("returns 400 when a posted non-manual entry omits sourceId", async () => {
    const res = await POST(makeRequest("POST", { ...validEntry, sourceId: undefined }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/source reference/i);
  });

  it("returns 200 with created entry for PAYMENT sourceType", async () => {
    mockPrismaJournalEntryCreate.mockResolvedValue(mockCreatedEntry);
    const res = await POST(makeRequest("POST", validEntry));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("entry-1");
    expect(body.status).toBe("POSTED");
    expect(body.lines).toHaveLength(2);
  });

  it("creates entry as DRAFT when status=DRAFT is passed", async () => {
    const draftEntry = { ...mockCreatedEntry, status: "DRAFT", approvedById: null };
    mockPrismaJournalEntryCreate.mockResolvedValue(draftEntry);
    const res = await POST(makeRequest("POST", { ...validEntry, status: "DRAFT", sourceId: undefined }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("DRAFT");
  });

  it("returns 200 for ACCOUNTANT creating non-manual entry", async () => {
    mockGetServerSession.mockResolvedValue(ACCOUNTANT_SESSION);
    mockPrismaJournalEntryCreate.mockResolvedValue(mockCreatedEntry);
    const res = await POST(makeRequest("POST", validEntry));
    expect(res.status).toBe(200);
  });
});
