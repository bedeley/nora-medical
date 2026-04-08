import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mock state ────────────────────────────────────────────────────
const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockJournalEntryFindMany,
  mockJournalEntryUpdateMany,
  mockFiscalPeriodFindMany,
  mockAuditLogCreateMany,
  mockLoadMonthlyCloseRows,
  mockToMonthKey,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockAssertSameOrigin: vi.fn(),
  mockJournalEntryFindMany: vi.fn(),
  mockJournalEntryUpdateMany: vi.fn(),
  mockFiscalPeriodFindMany: vi.fn(),
  mockAuditLogCreateMany: vi.fn(),
  mockLoadMonthlyCloseRows: vi.fn(),
  mockToMonthKey: vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────
vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/origin", () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: vi.fn() }));
vi.mock("@/lib/accounting-periods", () => ({
  loadMonthlyCloseRows: mockLoadMonthlyCloseRows,
  toMonthKey: mockToMonthKey,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    journalEntry: {
      findMany: mockJournalEntryFindMany,
      updateMany: mockJournalEntryUpdateMany,
    },
    fiscalPeriod: { findMany: mockFiscalPeriodFindMany },
    auditLog: { createMany: mockAuditLogCreateMany },
  },
}));

// ── Import after mocks ────────────────────────────────────────────────────
import { POST } from "./route";

// ── Helpers ───────────────────────────────────────────────────────────────
const ADMIN_SESSION = { user: { id: "u1", role: "ADMIN", email: "admin@example.com" } };
const ACCOUNTANT_SESSION = { user: { id: "u2", role: "ACCOUNTANT" } };
const STAFF_SESSION = { user: { id: "u3", role: "STAFF" } };

function makeRequest(body?: unknown): Request {
  return new Request("http://localhost:3000/api/admin/accounting/journal/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify(body ?? { entryIds: ["entry-1"] }),
  });
}

const mockDraftEntries = [
  {
    id: "entry-1",
    entryDate: new Date("2026-03-15"),
    sourceType: "MANUAL",
    lines: [
      { debit: 100, credit: 0 },
      { debit: 0, credit: 100 },
    ],
  },
  {
    id: "entry-2",
    entryDate: new Date("2026-03-20"),
    sourceType: "ORDER",
    lines: [
      { debit: 55, credit: 0 },
      { debit: 0, credit: 55 },
    ],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockAssertSameOrigin.mockReturnValue(true);
  mockLoadMonthlyCloseRows.mockResolvedValue([]); // no closed months
  mockToMonthKey.mockReturnValue("2026-03"); // stable key
  mockFiscalPeriodFindMany.mockResolvedValue([]); // no closed fiscal periods
  mockAuditLogCreateMany.mockResolvedValue({ count: 0 });
  mockJournalEntryUpdateMany.mockResolvedValue({ count: 2 });
});

// ── Auth guard ─────────────────────────────────────────────────────────────

describe("POST /api/admin/accounting/journal/approve – auth guard", () => {
  it("returns 401 when no session", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Unauthorized");
  });

  it("returns 401 when role is STAFF", async () => {
    mockGetServerSession.mockResolvedValue(STAFF_SESSION);
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
  });

  it("allows ACCOUNTANT when the role has journal.post permission", async () => {
    mockGetServerSession.mockResolvedValue(ACCOUNTANT_SESSION);
    mockJournalEntryFindMany.mockResolvedValue([]);
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
  });
});

// ── CSRF guard ─────────────────────────────────────────────────────────────

describe("POST /api/admin/accounting/journal/approve – CSRF guard", () => {
  it("returns 403 when assertSameOrigin returns false", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockAssertSameOrigin.mockReturnValue(false);
    const res = await POST(makeRequest());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Bad origin");
  });
});

// ── Input validation ───────────────────────────────────────────────────────

describe("POST /api/admin/accounting/journal/approve – input validation", () => {
  beforeEach(() => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
  });

  it("returns 400 when entryIds is missing", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid input");
  });

  it("returns 400 when entryIds is an empty array", async () => {
    const res = await POST(makeRequest({ entryIds: [] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid input");
  });

  it("returns 400 when entryIds contains a non-string (number)", async () => {
    const res = await POST(makeRequest({ entryIds: [123] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid input");
  });

  it("returns 400 when entryIds contains an empty string", async () => {
    const res = await POST(makeRequest({ entryIds: [""] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid input");
  });
});

// ── Business logic guards ──────────────────────────────────────────────────

describe("POST /api/admin/accounting/journal/approve – business logic", () => {
  beforeEach(() => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
  });

  it("returns 200 with approved:0 when no DRAFT entries match", async () => {
    mockJournalEntryFindMany.mockResolvedValue([]); // none found
    const res = await POST(makeRequest({ entryIds: ["entry-1", "entry-2"] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approved).toBe(0);
    expect(body.requested).toBe(2);
    expect(body.matchedDrafts).toBe(0);
  });

  it("returns 400 when entries are in a closed monthly period", async () => {
    mockJournalEntryFindMany.mockResolvedValue([mockDraftEntries[0]]);
    mockLoadMonthlyCloseRows.mockResolvedValue([{ month: "2026-03" }]);
    mockToMonthKey.mockReturnValue("2026-03"); // entry's month matches closed month
    const res = await POST(makeRequest({ entryIds: ["entry-1"] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/closed periods/i);
    expect(body.blockedCount).toBe(1);
    expect(body.closed).toContain("entry-1");
  });

  it("returns 400 when entries fall within a closed fiscal period", async () => {
    mockJournalEntryFindMany.mockResolvedValue([mockDraftEntries[0]]);
    mockLoadMonthlyCloseRows.mockResolvedValue([]); // no closed months
    mockFiscalPeriodFindMany.mockResolvedValue([
      {
        id: "fp-1",
        name: "Q1 2026",
        startDate: new Date("2026-01-01"),
        endDate: new Date("2026-03-31"),
      },
    ]);
    // entry date is 2026-03-15, inside the closed fiscal period
    const res = await POST(makeRequest({ entryIds: ["entry-1"] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/closed periods/i);
  });

  it("returns 400 when any selected draft is out of balance", async () => {
    mockJournalEntryFindMany.mockResolvedValue([
      {
        ...mockDraftEntries[0],
        lines: [
          { debit: 100, credit: 0 },
          { debit: 0, credit: 75 },
        ],
      },
    ]);
    const res = await POST(makeRequest({ entryIds: ["entry-1"] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/out of balance/i);
    expect(body.unbalanced).toContain("entry-1");
  });
});

// ── Success ────────────────────────────────────────────────────────────────

describe("POST /api/admin/accounting/journal/approve – success", () => {
  beforeEach(() => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
  });

  it("returns 200 with approved count and sourceTypeCounts", async () => {
    mockJournalEntryFindMany.mockResolvedValue(mockDraftEntries);
    mockJournalEntryUpdateMany.mockResolvedValue({ count: 2 });
    const res = await POST(makeRequest({ entryIds: ["entry-1", "entry-2"] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approved).toBe(2);
    expect(body.requested).toBe(2);
    expect(body.matchedDrafts).toBe(2);
    expect(body.sourceTypeCounts).toMatchObject({ MANUAL: 1, ORDER: 1 });
  });

  it("marks entries as POSTED via updateMany", async () => {
    mockJournalEntryFindMany.mockResolvedValue([mockDraftEntries[0]]);
    mockJournalEntryUpdateMany.mockResolvedValue({ count: 1 });
    await POST(makeRequest({ entryIds: ["entry-1"] }));
    expect(mockJournalEntryUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "POSTED" }),
      }),
    );
  });

  it("partially approves when only some entries are valid DRAFT", async () => {
    // Only one of two requested IDs is a DRAFT (the other may be already POSTED)
    mockJournalEntryFindMany.mockResolvedValue([mockDraftEntries[0]]);
    mockJournalEntryUpdateMany.mockResolvedValue({ count: 1 });
    const res = await POST(makeRequest({ entryIds: ["entry-1", "already-posted"] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requested).toBe(2);
    expect(body.matchedDrafts).toBe(1);
    expect(body.approved).toBe(1);
  });
});
