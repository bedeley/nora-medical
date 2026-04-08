import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mock state ────────────────────────────────────────────────────
const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockRateLimit,
  mockFindClosedPeriod,
  mockRecordAuditLog,
  mockProductFindUnique,
  mockAppSettingFindUnique,
  mockLedgerAccountFindMany,
  mockLedgerAccountUpsert,
  mockPrismaTransaction,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockAssertSameOrigin: vi.fn(),
  mockRateLimit: vi.fn(),
  mockFindClosedPeriod: vi.fn(),
  mockRecordAuditLog: vi.fn(),
  mockProductFindUnique: vi.fn(),
  mockAppSettingFindUnique: vi.fn(),
  mockLedgerAccountFindMany: vi.fn(),
  mockLedgerAccountUpsert: vi.fn(),
  mockPrismaTransaction: vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────
vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/origin", () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mockRateLimit }));
vi.mock("@/lib/accounting-periods", () => ({ findClosedPeriod: mockFindClosedPeriod }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: mockRecordAuditLog }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    product: { findUnique: mockProductFindUnique },
    appSetting: { findUnique: mockAppSettingFindUnique },
    ledgerAccount: {
      findMany: mockLedgerAccountFindMany,
      upsert: mockLedgerAccountUpsert,
    },
    $transaction: mockPrismaTransaction,
  },
}));

// ── Import after mocks ────────────────────────────────────────────────────
import { POST } from "./route";

// ── Helpers ───────────────────────────────────────────────────────────────
const ADMIN_SESSION = { user: { id: "admin-1", role: "ADMIN" } };
const ACCOUNTANT_SESSION = { user: { id: "acct-1", role: "ACCOUNTANT" } };
const STAFF_SESSION = { user: { id: "staff-1", role: "STAFF" } };

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/admin/accounting/inventory-adjustments", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin: "http://localhost" },
  });
}

const VALID_BODY = { productId: "prod-1", newUnitCost: 12, reason: "Market price increase" };

// stock:100, cost:10 → delta = 100*12 - 100*10 = 200
const MOCK_PRODUCT = { id: "prod-1", name: "Amoxicillin", stock: 100, cost: 10 };

const LEDGER_ACCOUNTS = [
  { code: "1200", id: "acct-inventory" },
  { code: "5000", id: "acct-cogs" },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
  mockAssertSameOrigin.mockReturnValue(true);
  mockRateLimit.mockResolvedValue({ ok: true });
  mockFindClosedPeriod.mockResolvedValue(null);
  mockAppSettingFindUnique.mockResolvedValue(null);
  mockLedgerAccountFindMany.mockImplementation(
    ({ where }: { where?: { code?: { in?: string[] } } }) => {
      const requested: string[] = where?.code?.in ?? [];
      return Promise.resolve(LEDGER_ACCOUNTS.filter((a) => requested.includes(a.code)));
    },
  );
  mockProductFindUnique.mockResolvedValue(MOCK_PRODUCT);
  mockPrismaTransaction.mockResolvedValue(undefined);
  mockRecordAuditLog.mockResolvedValue(undefined);
});

// ── Auth guard ─────────────────────────────────────────────────────────────

describe("POST /api/admin/accounting/inventory-adjustments – auth guard", () => {
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

describe("POST /api/admin/accounting/inventory-adjustments – CSRF guard", () => {
  it("returns 403 when assertSameOrigin returns false", async () => {
    mockAssertSameOrigin.mockReturnValue(false);
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Bad origin");
  });
});

// ── Rate limit ─────────────────────────────────────────────────────────────

describe("POST /api/admin/accounting/inventory-adjustments – rate limit", () => {
  it("returns 429 when rate limit exceeded", async () => {
    mockRateLimit.mockResolvedValue({ ok: false });
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("Too many requests");
  });
});

// ── Input validation ───────────────────────────────────────────────────────

describe("POST /api/admin/accounting/inventory-adjustments – input validation", () => {
  it("returns 400 with 'Invalid input' when productId is missing", async () => {
    const res = await POST(makeRequest({ newUnitCost: 12, reason: "Market price increase" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid input");
  });

  it("returns 400 when newUnitCost is negative", async () => {
    const res = await POST(makeRequest({ productId: "prod-1", newUnitCost: -1, reason: "Market price increase" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid input");
  });

  it("returns 400 when reason is too short (fewer than 3 characters)", async () => {
    const res = await POST(makeRequest({ productId: "prod-1", newUnitCost: 12, reason: "ab" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid input");
  });
});

// ── Product lookup ─────────────────────────────────────────────────────────

describe("POST /api/admin/accounting/inventory-adjustments – product lookup", () => {
  it("returns 404 when product is not found", async () => {
    mockProductFindUnique.mockResolvedValue(null);
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Product not found");
  });
});

// ── No-op delta ────────────────────────────────────────────────────────────

describe("POST /api/admin/accounting/inventory-adjustments – no-op delta", () => {
  it("returns 200 with 'No adjustment required.' when newUnitCost equals current cost", async () => {
    // stock:100, cost:10, newUnitCost:10 → delta = 0 → |delta| < 0.01
    const res = await POST(makeRequest({ productId: "prod-1", newUnitCost: 10, reason: "Market price increase" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.message).toBe("No adjustment required.");
  });
});

// ── Closed period guard ────────────────────────────────────────────────────

describe("POST /api/admin/accounting/inventory-adjustments – closed period guard", () => {
  it("returns 400 when the current date falls in a closed period", async () => {
    mockFindClosedPeriod.mockResolvedValue({ id: "period-1", name: "March 2026" });
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Period "March 2026" is closed.');
  });
});

// ── Missing ledger accounts ────────────────────────────────────────────────

describe("POST /api/admin/accounting/inventory-adjustments – missing ledger accounts", () => {
  it("returns 400 when ledgerAccount.findMany returns no accounts", async () => {
    mockLedgerAccountFindMany.mockResolvedValue([]);
    // upsert returns the account objects, but a second findMany call still returns [] to
    // simulate the case where accounts cannot be resolved
    mockLedgerAccountUpsert.mockResolvedValue({});
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Missing ledger accounts for inventory adjustment.");
  });
});

// ── Success ────────────────────────────────────────────────────────────────

describe("POST /api/admin/accounting/inventory-adjustments – success", () => {
  it("returns 200 with { ok: true, delta: 200 } when newUnitCost is higher (positive delta)", async () => {
    // stock:100, cost:10, newUnitCost:12 → delta = 200
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.delta).toBe(200);
  });

  it("returns 200 with { ok: true, delta: -200 } when newUnitCost is lower (negative delta)", async () => {
    // stock:100, cost:10, newUnitCost:8 → delta = -200
    const res = await POST(makeRequest({ productId: "prod-1", newUnitCost: 8, reason: "Price correction" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.delta).toBe(-200);
  });
});
