import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mock state ────────────────────────────────────────────────────
const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockPrismaJournalEntryFindUnique,
  mockPrismaJournalEntryUpdate,
  mockFindClosedPeriod,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockAssertSameOrigin: vi.fn(),
  mockPrismaJournalEntryFindUnique: vi.fn(),
  mockPrismaJournalEntryUpdate: vi.fn(),
  mockFindClosedPeriod: vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────
vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/origin", () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: vi.fn() }));
vi.mock("@/lib/accounting-periods", () => ({ findClosedPeriod: mockFindClosedPeriod }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    journalEntry: {
      findUnique: mockPrismaJournalEntryFindUnique,
      update: mockPrismaJournalEntryUpdate,
    },
  },
}));

// ── Import after mocks ────────────────────────────────────────────────────
import { POST } from "./route";

// ── Helpers ───────────────────────────────────────────────────────────────
const ADMIN_SESSION = { user: { id: "u1", role: "ADMIN", email: "admin@example.com" } };
const ACCOUNTANT_SESSION = { user: { id: "u2", role: "ACCOUNTANT", email: "ac@example.com" } };
const STAFF_SESSION = { user: { id: "u3", role: "STAFF" } };

function makeRequest(entryId = "entry-1"): Request {
  return new Request(
    `http://localhost:3000/api/admin/accounting/journal/${entryId}/post`,
    {
      method: "POST",
      headers: { origin: "http://localhost:3000" },
    },
  );
}

const mockDraftEntry = {
  id: "entry-1",
  entryDate: new Date("2026-03-01"),
  status: "DRAFT",
  archivedAt: null,
  lines: [
    { debit: 100, credit: 0 },
    { debit: 0, credit: 100 },
  ],
};

const mockPostedEntry = {
  id: "entry-1",
  entryDate: new Date("2026-03-01"),
  status: "POSTED",
  archivedAt: null,
  approvedById: "u1",
  approvedAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAssertSameOrigin.mockReturnValue(true);
  mockFindClosedPeriod.mockResolvedValue(null);
});

// ── Auth guard ─────────────────────────────────────────────────────────────

describe("POST /api/admin/accounting/journal/[id]/post – auth guard", () => {
  it("returns 401 when no session", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await POST(makeRequest(), { params: { id: "entry-1" } });
    expect(res.status).toBe(401);
  });

  it("returns 401 when role is STAFF (no journal.post permission)", async () => {
    mockGetServerSession.mockResolvedValue(STAFF_SESSION);
    const res = await POST(makeRequest(), { params: { id: "entry-1" } });
    expect(res.status).toBe(401);
  });

  it("allows ADMIN (has journal.post permission)", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockPrismaJournalEntryFindUnique.mockResolvedValue(mockDraftEntry);
    mockPrismaJournalEntryUpdate.mockResolvedValue(mockPostedEntry);
    const res = await POST(makeRequest(), { params: { id: "entry-1" } });
    expect(res.status).toBe(200);
  });

  it("allows ACCOUNTANT (has journal.post permission)", async () => {
    mockGetServerSession.mockResolvedValue(ACCOUNTANT_SESSION);
    mockPrismaJournalEntryFindUnique.mockResolvedValue(mockDraftEntry);
    mockPrismaJournalEntryUpdate.mockResolvedValue(mockPostedEntry);
    const res = await POST(makeRequest(), { params: { id: "entry-1" } });
    expect(res.status).toBe(200);
  });
});

// ── CSRF guard ─────────────────────────────────────────────────────────────

describe("POST /api/admin/accounting/journal/[id]/post – CSRF guard", () => {
  it("returns 403 when assertSameOrigin returns false", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockAssertSameOrigin.mockReturnValue(false);
    const res = await POST(makeRequest(), { params: { id: "entry-1" } });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Bad origin");
  });
});

// ── Business logic guards ──────────────────────────────────────────────────

describe("POST /api/admin/accounting/journal/[id]/post – business logic", () => {
  beforeEach(() => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
  });

  it("returns 404 when entry does not exist", async () => {
    mockPrismaJournalEntryFindUnique.mockResolvedValue(null);
    const res = await POST(makeRequest(), { params: { id: "entry-1" } });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Not found");
  });

  it("returns 400 when entry is already POSTED", async () => {
    mockPrismaJournalEntryFindUnique.mockResolvedValue({ ...mockDraftEntry, status: "POSTED" });
    const res = await POST(makeRequest(), { params: { id: "entry-1" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/already posted/i);
  });

  it("returns 400 when entry is VOID (not a DRAFT)", async () => {
    mockPrismaJournalEntryFindUnique.mockResolvedValue({ ...mockDraftEntry, status: "VOID" });
    const res = await POST(makeRequest(), { params: { id: "entry-1" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/only draft/i);
  });

  it("returns 400 when entry is archived", async () => {
    mockPrismaJournalEntryFindUnique.mockResolvedValue({
      ...mockDraftEntry,
      archivedAt: new Date("2026-01-01"),
    });
    const res = await POST(makeRequest(), { params: { id: "entry-1" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/archived/i);
  });

  it("returns 400 when entry date falls in a closed period", async () => {
    mockPrismaJournalEntryFindUnique.mockResolvedValue(mockDraftEntry);
    mockFindClosedPeriod.mockResolvedValue({ id: "period-1", name: "February 2026" });
    const res = await POST(makeRequest(), { params: { id: "entry-1" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/closed/i);
  });

  it("returns 400 when the draft entry is out of balance", async () => {
    mockPrismaJournalEntryFindUnique.mockResolvedValue({
      ...mockDraftEntry,
      lines: [
        { debit: 120, credit: 0 },
        { debit: 0, credit: 100 },
      ],
    });
    const res = await POST(makeRequest(), { params: { id: "entry-1" } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/out of balance/i);
  });
});

// ── Success ────────────────────────────────────────────────────────────────

describe("POST /api/admin/accounting/journal/[id]/post – success", () => {
  beforeEach(() => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
  });

  it("returns 200 with updated POSTED entry", async () => {
    mockPrismaJournalEntryFindUnique.mockResolvedValue(mockDraftEntry);
    mockPrismaJournalEntryUpdate.mockResolvedValue(mockPostedEntry);
    const res = await POST(makeRequest(), { params: { id: "entry-1" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("entry-1");
    expect(body.status).toBe("POSTED");
    expect(body.approvedById).toBe("u1");
  });
});
