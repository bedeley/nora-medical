import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mock state ────────────────────────────────────────────────────────
const {
  mockGetServerSession,
  mockJournalEntryFindMany,
  mockPaymentFindMany,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockJournalEntryFindMany: vi.fn(),
  mockPaymentFindMany: vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────────
vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    journalEntry: { findMany: mockJournalEntryFindMany },
    payment: { findMany: mockPaymentFindMany },
  },
}));

import { GET } from "./route";

// ── Shared fixtures ───────────────────────────────────────────────────────────
const adminSession = { user: { id: "u1", role: "ADMIN" } };
const accountantSession = { user: { id: "u2", role: "ACCOUNTANT" } };

const mockAccount = { id: "acct1", code: "4000", name: "Revenue", type: "INCOME" };

const mockEntry = {
  id: "je1",
  entryDate: new Date("2026-03-01T00:00:00Z"),
  memo: "Manual adjustment",
  lines: [
    {
      id: "jl1",
      debit: 100,
      credit: 0,
      description: "Debit line",
      account: mockAccount,
    },
  ],
};

const mockPayment = {
  id: "pay1",
  orderId: "ord1",
  amount: 250,
  note: null,
  refundDisposition: null,
  createdAt: new Date("2026-03-01T12:00:00Z"),
};

function makeReq(params: Record<string, string> = {}) {
  const url = new URL("http://localhost/api/admin/accounting/reconcile");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url.toString());
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe("GET /api/admin/accounting/reconcile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetServerSession.mockResolvedValue(adminSession);
    mockJournalEntryFindMany.mockResolvedValue([mockEntry]);
    mockPaymentFindMany.mockResolvedValue([mockPayment]);
  });

  // ── Auth guards ───────────────────────────────────────────────────────────

  it("returns 401 when unauthenticated", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
  });

  it("returns 401 for STAFF role", async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: "u3", role: "STAFF" } });
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
  });

  it("returns 401 for CUSTOMER role", async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: "u4", role: "CUSTOMER" } });
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
  });

  it("allows ACCOUNTANT role", async () => {
    mockGetServerSession.mockResolvedValue(accountantSession);
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
  });

  // ── Success cases ─────────────────────────────────────────────────────────

  it("returns 200 with manualEntries, autoApply, and returns arrays", async () => {
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("manualEntries");
    expect(body).toHaveProperty("autoApply");
    expect(body).toHaveProperty("returns");
    expect(Array.isArray(body.manualEntries)).toBe(true);
    expect(Array.isArray(body.autoApply)).toBe(true);
    expect(Array.isArray(body.returns)).toBe(true);
  });

  it("maps manual journal entry fields correctly", async () => {
    const res = await GET(makeReq());
    const body = await res.json();
    const entry = body.manualEntries[0];
    expect(entry.id).toBe("je1");
    expect(entry.memo).toBe("Manual adjustment");
    expect(Array.isArray(entry.lines)).toBe(true);
    expect(entry.lines[0].accountCode).toBe("4000");
    expect(entry.lines[0].accountName).toBe("Revenue");
    expect(entry.lines[0].debit).toBe(100);
  });

  it("separates AUTO_APPLY and ITEM_RETURN payments by note reference field", async () => {
    const autoApplyPayment = {
      ...mockPayment,
      id: "pay-auto",
      note: JSON.stringify({ reference: "AUTO_APPLY" }),
      refundDisposition: null,
    };
    const returnPayment = {
      ...mockPayment,
      id: "pay-return",
      note: JSON.stringify({ reference: "ITEM_RETURN" }),
      refundDisposition: "CASH_BACK",
    };
    // plain payment with no matching reference — goes into neither bucket
    const plainPayment = { ...mockPayment, id: "pay-plain", note: null };
    mockPaymentFindMany.mockResolvedValue([autoApplyPayment, returnPayment, plainPayment]);
    const res = await GET(makeReq());
    const body = await res.json();
    const autoApplyIds = body.autoApply.map((p: { id: string }) => p.id);
    const returnIds = body.returns.map((p: { id: string }) => p.id);
    expect(autoApplyIds).toContain("pay-auto");
    expect(returnIds).toContain("pay-return");
    expect(autoApplyIds).not.toContain("pay-return");
    expect(returnIds).not.toContain("pay-auto");
    // plain payment with no reference appears in neither bucket
    expect(autoApplyIds).not.toContain("pay-plain");
    expect(returnIds).not.toContain("pay-plain");
  });

  // ── Date filtering ────────────────────────────────────────────────────────

  it("passes date filter to Prisma when start and end provided", async () => {
    await GET(makeReq({ start: "2026-03-01", end: "2026-03-31" }));
    const callArgs = mockJournalEntryFindMany.mock.calls[0]?.[0];
    expect(callArgs?.where?.entryDate).toHaveProperty("gte");
    expect(callArgs?.where?.entryDate).toHaveProperty("lte");
  });

  it("omits date filter when no params provided", async () => {
    await GET(makeReq());
    const callArgs = mockJournalEntryFindMany.mock.calls[0]?.[0];
    expect(callArgs?.where?.entryDate).toBeUndefined();
  });

  it("ignores invalid start date and omits filter", async () => {
    await GET(makeReq({ start: "not-a-date" }));
    const callArgs = mockJournalEntryFindMany.mock.calls[0]?.[0];
    expect(callArgs?.where?.entryDate).toBeUndefined();
  });

  it("applies only end filter when only end param is valid", async () => {
    await GET(makeReq({ end: "2026-03-31" }));
    const callArgs = mockJournalEntryFindMany.mock.calls[0]?.[0];
    expect(callArgs?.where?.entryDate?.lte).toBeDefined();
    expect(callArgs?.where?.entryDate?.gte).toBeUndefined();
  });

  // ── Empty states ──────────────────────────────────────────────────────────

  it("returns empty arrays when no journal entries or payments exist", async () => {
    mockJournalEntryFindMany.mockResolvedValue([]);
    mockPaymentFindMany.mockResolvedValue([]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.manualEntries).toEqual([]);
    expect(body.autoApply).toEqual([]);
    expect(body.returns).toEqual([]);
  });

  it("returns empty manualEntries and empty buckets for a plain payment with no reference", async () => {
    // mockPayment has note: null — no AUTO_APPLY or ITEM_RETURN reference, goes into neither bucket
    mockJournalEntryFindMany.mockResolvedValue([]);
    mockPaymentFindMany.mockResolvedValue([mockPayment]);
    const res = await GET(makeReq());
    const body = await res.json();
    expect(body.manualEntries).toHaveLength(0);
    expect(body.autoApply).toHaveLength(0);
    expect(body.returns).toHaveLength(0);
  });

  // ── Error handling ────────────────────────────────────────────────────────

  it("returns 500 when Prisma throws", async () => {
    mockJournalEntryFindMany.mockRejectedValue(new Error("DB error"));
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
  });
});
