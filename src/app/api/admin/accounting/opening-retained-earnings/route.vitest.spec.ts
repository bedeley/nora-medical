import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockRateLimit,
  mockFindClosedPeriod,
  mockLedgerAccountFindUnique,
  mockLedgerAccountCreate,
  mockAppSettingFindUnique,
  mockAppSettingCreate,
  mockJournalEntryCreate,
  mockAuditLogCreate,
  mockTransaction,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockAssertSameOrigin: vi.fn(),
  mockRateLimit: vi.fn(),
  mockFindClosedPeriod: vi.fn(),
  mockLedgerAccountFindUnique: vi.fn(),
  mockLedgerAccountCreate: vi.fn(),
  mockAppSettingFindUnique: vi.fn(),
  mockAppSettingCreate: vi.fn(),
  mockJournalEntryCreate: vi.fn(),
  mockAuditLogCreate: vi.fn(),
  mockTransaction: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/origin", () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mockRateLimit }));
vi.mock("@/lib/accounting-periods", () => ({ findClosedPeriod: mockFindClosedPeriod }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    ledgerAccount: {
      findUnique: mockLedgerAccountFindUnique,
      create: mockLedgerAccountCreate,
    },
    appSetting: {
      findUnique: mockAppSettingFindUnique,
      create: mockAppSettingCreate,
    },
    journalEntry: {
      create: mockJournalEntryCreate,
    },
    auditLog: {
      create: mockAuditLogCreate,
    },
    $transaction: mockTransaction,
  },
}));

import { POST } from "./route";

const ADMIN_SESSION = { user: { id: "admin-1", role: "ADMIN" } };
const OB_EQUITY = { id: "acc-3900", code: "3900", name: "Opening Balance Equity", type: "EQUITY" };
const RETAINED_EARNINGS = { id: "acc-3100", code: "3100", name: "Retained Earnings", type: "EQUITY" };

function makeRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/admin/accounting/opening-retained-earnings", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "http://localhost" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
  mockAssertSameOrigin.mockReturnValue(true);
  mockRateLimit.mockResolvedValue({ ok: true });
  mockFindClosedPeriod.mockResolvedValue(null);
  mockAppSettingFindUnique.mockResolvedValue(null);
  mockJournalEntryCreate.mockResolvedValue({ id: "je-re-open" });
  mockAppSettingCreate.mockResolvedValue({});
  mockAuditLogCreate.mockResolvedValue({});
  mockTransaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
    callback({
      ledgerAccount: {
        findUnique: mockLedgerAccountFindUnique,
        create: mockLedgerAccountCreate,
      },
      journalEntry: { create: mockJournalEntryCreate },
      appSetting: { create: mockAppSettingCreate },
      auditLog: { create: mockAuditLogCreate },
    }),
  );
  mockLedgerAccountFindUnique.mockImplementation(({ where }: { where: { code?: string } }) => {
    if (where.code === "3900") return Promise.resolve(OB_EQUITY);
    if (where.code === "3100") return Promise.resolve(RETAINED_EARNINGS);
    return Promise.resolve(null);
  });
});

describe("POST /api/admin/accounting/opening-retained-earnings", () => {
  it("returns 401 when unauthenticated", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await POST(makeRequest({ amount: 5000, entryDate: "2026-04-01" }));
    expect(res.status).toBe(401);
  });

  it("returns 409 when opening retained earnings is already configured", async () => {
    mockAppSettingFindUnique.mockResolvedValue({
      value: {
        amount: 5000,
        entryDate: "2026-04-01",
        journalEntryId: "je-existing",
        configuredAt: "2026-04-01T00:00:00.000Z",
      },
      updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    });

    const res = await POST(makeRequest({ amount: 5000, entryDate: "2026-04-01" }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("OPENING_RETAINED_EARNINGS_EXISTS");
  });

  it("returns 400 when the entry date falls in a closed period", async () => {
    mockFindClosedPeriod.mockResolvedValue({ name: "March 2026" });
    const res = await POST(makeRequest({ amount: 5000, entryDate: "2026-03-31" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/closed period/i);
  });

  it("posts a one-time opening retained earnings journal and stores the setup metadata", async () => {
    const res = await POST(
      makeRequest({
        amount: 8750,
        entryDate: "2026-04-01",
        notes: "Legacy retained earnings at go-live",
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.journalEntryId).toBe("je-re-open");
    expect(mockJournalEntryCreate).toHaveBeenCalledTimes(1);

    const journalPayload = mockJournalEntryCreate.mock.calls[0]?.[0]?.data;
    expect(journalPayload.sourceType).toBe("MANUAL");
    expect(journalPayload.lines.create).toEqual([
      expect.objectContaining({
        accountId: "acc-3900",
        debit: 8750,
        credit: 0,
      }),
      expect.objectContaining({
        accountId: "acc-3100",
        debit: 0,
        credit: 8750,
      }),
    ]);

    expect(mockAppSettingCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          key: "accounting.openingRetainedEarnings",
          value: expect.objectContaining({
            amount: 8750,
            entryDate: "2026-04-01",
            journalEntryId: "je-re-open",
          }),
        }),
      }),
    );
    expect(mockAuditLogCreate).toHaveBeenCalledTimes(1);
  });
});
