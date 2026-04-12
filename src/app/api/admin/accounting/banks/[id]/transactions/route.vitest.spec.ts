import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetServerSession,
  mockBankTransactionFindMany,
  mockBankTransactionCount,
  mockRecordAccountingBankAudit,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockBankTransactionFindMany: vi.fn(),
  mockBankTransactionCount: vi.fn(),
  mockRecordAccountingBankAudit: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/origin", () => ({ assertSameOrigin: vi.fn(() => true) }));
vi.mock("@/lib/accounting-bank-audit", () => ({ recordAccountingBankAudit: mockRecordAccountingBankAudit }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    bankTransaction: {
      findMany: mockBankTransactionFindMany,
      count: mockBankTransactionCount,
    },
  },
}));

import { GET } from "./route";

const accountantSession = {
  user: { id: "acct-1", role: "ACCOUNTANT", email: "acct@example.com" },
};

function makeRequest(params: Record<string, string> = {}) {
  const url = new URL("http://localhost/api/admin/accounting/banks/bank-1/transactions");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new Request(url.toString());
}

function makeParams() {
  return Promise.resolve({ id: "bank-1" });
}

describe("GET /api/admin/accounting/banks/[id]/transactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetServerSession.mockResolvedValue(accountantSession);
    mockRecordAccountingBankAudit.mockResolvedValue(undefined);
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetServerSession.mockResolvedValue(null);

    const res = await GET(makeRequest(), { params: makeParams() });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("preserves the legacy array response when no server-list params are provided", async () => {
    mockBankTransactionFindMany.mockResolvedValue([
      {
        id: "txn-1",
        postedAt: new Date("2026-04-01T00:00:00.000Z"),
        amount: 1200,
        description: "Wire transfer",
        reference: "WIRE-001",
        type: "CREDIT",
        matched: false,
      },
    ]);

    const res = await GET(makeRequest({ limit: "25" }), { params: makeParams() });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Transactions-Limit")).toBe("25");
    expect(res.headers.get("X-Transactions-Returned")).toBe("1");
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]).toEqual(expect.objectContaining({ id: "txn-1", reference: "WIRE-001" }));
    expect(mockBankTransactionCount).not.toHaveBeenCalled();
    expect(mockBankTransactionFindMany).toHaveBeenCalledWith({
      where: { bankAccountId: "bank-1" },
      orderBy: [{ postedAt: "desc" }],
      take: 25,
    });
  });

  it("returns paginated filtered rows and summary for server-side list requests", async () => {
    mockBankTransactionCount.mockResolvedValueOnce(34).mockResolvedValueOnce(9);
    mockBankTransactionFindMany.mockResolvedValue([
      {
        id: "txn-2",
        postedAt: new Date("2026-04-02T00:00:00.000Z"),
        amount: 450,
        description: "Incoming wire",
        reference: "WIRE-002",
        type: "CREDIT",
        matched: false,
      },
    ]);

    const res = await GET(
      makeRequest({
        page: "2",
        pageSize: "20",
        q: "wire",
        unmatchedOnly: "1",
        sortBy: "amount",
        sortDir: "asc",
      }),
      { params: makeParams() },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(
      expect.objectContaining({
        total: 34,
        page: 2,
        pageSize: 20,
        totalPages: 2,
        sortBy: "amount",
        sortDir: "asc",
        summary: { total: 34, unmatched: 9, matched: 25 },
      }),
    );
    expect(body.rows[0]).toEqual(expect.objectContaining({ id: "txn-2", reference: "WIRE-002" }));
    expect(mockBankTransactionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 20,
        take: 20,
        orderBy: [{ amount: "asc" }, { postedAt: "desc" }, { createdAt: "desc" }],
        where: expect.objectContaining({
          bankAccountId: "bank-1",
          matched: false,
          OR: [
            { description: { contains: "wire", mode: "insensitive" } },
            { reference: { contains: "wire", mode: "insensitive" } },
          ],
        }),
      }),
    );
  });

  it("streams CSV exports for the current bank filters", async () => {
    mockBankTransactionFindMany.mockResolvedValue([
      {
        postedAt: new Date("2026-04-03T00:00:00.000Z"),
        amount: 99.5,
        description: "Bank charge",
        reference: "FEE-1",
        type: "DEBIT",
        matched: true,
      },
    ]);

    const res = await GET(
      makeRequest({
        format: "csv",
        q: "fee",
        sortBy: "postedAt",
        sortDir: "desc",
      }),
      { params: makeParams() },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    const csv = await res.text();
    expect(csv).toContain("date,type,amount,description,reference,matched");
    expect(csv).toContain("2026-04-03,DEBIT,99.50,Bank charge,FEE-1,true");
    expect(mockBankTransactionCount).not.toHaveBeenCalled();
    expect(mockRecordAccountingBankAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "BANK_TXN_EXPORT_CSV",
        entityType: "BANK_TRANSACTION",
        entityId: "bank-1",
        section: "transactions",
        operation: "export_csv",
        meta: expect.objectContaining({
          bankAccountId: "bank-1",
          format: "CSV",
          rowCount: 1,
          sourcePage: "admin/accounting/banks",
        }),
      }),
    );
  });
});
