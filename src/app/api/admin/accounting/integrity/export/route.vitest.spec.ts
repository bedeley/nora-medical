import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetServerSession,
  mockRecordAuditLog,
  mockLoadAccountTotals,
  mockParseDateRange,
  mockToNet,
  mockLedgerAccountFindUnique,
  mockJournalEntryCount,
  mockJournalEntryFindMany,
  mockProductFindMany,
  mockPaymentFindMany,
  mockJournalLineFindMany,
  mockPurchaseFindMany,
  mockSupplierPaymentFindMany,
  mockAuditLogFindMany,
  mockOrderAggregate,
  mockOrderItemFindMany,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockRecordAuditLog: vi.fn(),
  mockLoadAccountTotals: vi.fn(),
  mockParseDateRange: vi.fn(),
  mockToNet: vi.fn(),
  mockLedgerAccountFindUnique: vi.fn(),
  mockJournalEntryCount: vi.fn(),
  mockJournalEntryFindMany: vi.fn(),
  mockProductFindMany: vi.fn(),
  mockPaymentFindMany: vi.fn(),
  mockJournalLineFindMany: vi.fn(),
  mockPurchaseFindMany: vi.fn(),
  mockSupplierPaymentFindMany: vi.fn(),
  mockAuditLogFindMany: vi.fn(),
  mockOrderAggregate: vi.fn(),
  mockOrderItemFindMany: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: mockRecordAuditLog }));
vi.mock("@/app/api/admin/accounting/reports/utils", () => ({
  loadAccountTotals: mockLoadAccountTotals,
  parseDateRange: mockParseDateRange,
  toNet: mockToNet,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    ledgerAccount: { findUnique: mockLedgerAccountFindUnique },
    journalEntry: {
      count: mockJournalEntryCount,
      findMany: mockJournalEntryFindMany,
    },
    product: { findMany: mockProductFindMany },
    payment: { findMany: mockPaymentFindMany },
    journalLine: { findMany: mockJournalLineFindMany },
    purchase: { findMany: mockPurchaseFindMany },
    supplierPayment: { findMany: mockSupplierPaymentFindMany },
    auditLog: { findMany: mockAuditLogFindMany },
    order: { aggregate: mockOrderAggregate },
    orderItem: { findMany: mockOrderItemFindMany },
  },
}));

import { GET } from "./route";

const adminSession = {
  user: { id: "admin-1", role: "ADMIN", email: "admin@example.com" },
};

function makeReq(params: Record<string, string> = {}) {
  const url = new URL("http://localhost/api/admin/accounting/integrity/export");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return new Request(url.toString());
}

describe("GET /api/admin/accounting/integrity/export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetServerSession.mockResolvedValue(adminSession);
    mockParseDateRange.mockReturnValue(undefined);
    mockToNet.mockImplementation((row: { net?: number }) => Number(row?.net || 0));
    mockLoadAccountTotals.mockResolvedValue([
      { code: "1100", net: 120, debit: 0, credit: 0 },
      { code: "1200", net: 80, debit: 0, credit: 0 },
      { code: "2000", net: 60, debit: 0, credit: 0 },
      { code: "4000", net: 300, debit: 0, credit: 0 },
      { code: "5000", net: 90, debit: 0, credit: 0 },
      { code: "2100", net: 45, debit: 0, credit: 0 },
      { code: "2200", net: 15, debit: 0, credit: 0 },
      { code: "1000", net: 25, debit: 0, credit: 0 },
      { code: "1010", net: 50, debit: 0, credit: 0 },
    ]);
    mockLedgerAccountFindUnique.mockResolvedValue({ id: "ar-1100" });
    mockJournalEntryCount.mockResolvedValue(2);
    mockJournalEntryFindMany.mockResolvedValue([]);
    mockProductFindMany.mockResolvedValue([]);
    mockPaymentFindMany.mockResolvedValue([]);
    mockJournalLineFindMany.mockResolvedValue([]);
    mockPurchaseFindMany.mockResolvedValue([]);
    mockSupplierPaymentFindMany.mockResolvedValue([]);
    mockAuditLogFindMany.mockResolvedValue([]);
    mockOrderAggregate.mockResolvedValue({ _sum: { subtotal: 0, taxAmount: 0 } });
    mockOrderItemFindMany.mockResolvedValue([]);
    mockRecordAuditLog.mockResolvedValue(undefined);
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    expect(mockRecordAuditLog).not.toHaveBeenCalled();
  });

  it("records an audit event when exporting the integrity CSV", async () => {
    const res = await GET(makeReq({ asOf: "2026-04-01" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");

    const body = await res.text();
    expect(body).toContain("Section,Metric,Value,Explanation");
    expect(body).toContain("Core integrity,Draft journal entries,2,");
    expect(body).toContain("Receivables,AR ledger balance,120.00,");

    expect(mockRecordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "admin-1",
        action: "report.export.integrity.csv",
        entityType: "AccountingReport",
        entityId: "integrity",
        meta: expect.objectContaining({
          exportLabel: "Accounting integrity CSV export",
          reportLabel: "Accounting integrity report",
          sourcePage: "admin/accounting/integrity",
          report: "accounting-integrity",
          format: "CSV",
          fileName: expect.stringMatching(/^accounting-integrity-\d{4}-\d{2}-\d{2}\.csv$/),
          displayFileName: "Accounting integrity report (April 1, 2026).csv",
          columnCount: 4,
          scopeSnapshot: "As of April 1, 2026",
          asOf: "2026-04-01",
          asOfApplied: "2026-04-01T23:59:59.999Z",
          rowCount: expect.any(Number),
          byteSize: expect.any(Number),
          generatedAt: expect.any(String),
          resultSummary: expect.any(String),
          actorRole: "ADMIN",
          actorEmail: "admin@example.com",
        }),
      }),
    );
  });
});
