import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mock state ────────────────────────────────────────────────────
const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockRateLimit,
  mockPrismaProductFindUnique,
  mockPrismaAppSettingFindUnique,
  mockPrismaLedgerAccountFindMany,
  mockPrismaLedgerAccountUpsert,
  mockPrismaTransaction,
  mockPrismaMovementFindMany,
  mockPrismaMovementCount,
  mockFindClosedPeriod,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockAssertSameOrigin: vi.fn(),
  mockRateLimit: vi.fn(),
  mockPrismaProductFindUnique: vi.fn(),
  mockPrismaAppSettingFindUnique: vi.fn(),
  mockPrismaLedgerAccountFindMany: vi.fn(),
  mockPrismaLedgerAccountUpsert: vi.fn(),
  mockPrismaTransaction: vi.fn(),
  mockPrismaMovementFindMany: vi.fn(),
  mockPrismaMovementCount: vi.fn(),
  mockFindClosedPeriod: vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────
vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/origin", () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mockRateLimit }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: vi.fn() }));
vi.mock("@/lib/accounting-periods", () => ({ findClosedPeriod: mockFindClosedPeriod }));
vi.mock("@/lib/inventory-lots", () => ({
  applyLotAdjustment: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    product: { findUnique: mockPrismaProductFindUnique },
    appSetting: { findUnique: mockPrismaAppSettingFindUnique },
    ledgerAccount: {
      findMany: mockPrismaLedgerAccountFindMany,
      upsert: mockPrismaLedgerAccountUpsert,
    },
    inventoryMovement: {
      findMany: mockPrismaMovementFindMany,
      count: mockPrismaMovementCount,
    },
    $transaction: mockPrismaTransaction,
  },
}));

// ── Import after mocks ────────────────────────────────────────────────────
import { POST, GET } from "./route";

// ── Helpers ───────────────────────────────────────────────────────────────
const ADMIN_SESSION = { user: { id: "u1", role: "ADMIN", email: "admin@example.com" } };
const ACCOUNTANT_SESSION = { user: { id: "u2", role: "ACCOUNTANT", email: "ac@example.com" } };
const STAFF_SESSION = { user: { id: "u3", role: "STAFF" } };

function makeRequest(body?: unknown): Request {
  return new Request("http://localhost:3000/api/admin/stock-adjustments", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify(
      body ?? {
        productId: "prod-1",
        countedStock: 80,
        reasonType: "CYCLE_COUNT",
        reasonCode: "COUNT_VARIANCE",
        note: "Physical count",
      },
    ),
  });
}

function makeGetRequest(params: Record<string, string> = {}): Request {
  const sp = new URLSearchParams(params);
  return new Request(`http://localhost:3000/api/admin/stock-adjustments?${sp.toString()}`);
}

const mockProduct = {
  id: "prod-1",
  name: "Sterile Gloves",
  sku: "SG-001",
  stock: 100,
  cost: 5.0,
  requiresLotTracking: false,
  requiresExpiryDate: false,
};

// Ledger accounts returned by resolveAccounts
const mockLedgerAccounts = [
  { code: "1200", id: "acct-inventory" },
  { code: "5000", id: "acct-cogs" },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockAssertSameOrigin.mockReturnValue(true);
  mockRateLimit.mockResolvedValue({ ok: true });
  mockFindClosedPeriod.mockResolvedValue(null);
  mockPrismaAppSettingFindUnique.mockResolvedValue(null);
  mockPrismaLedgerAccountFindMany.mockResolvedValue(mockLedgerAccounts);
  // Transaction runs the callback and returns delta/valueDelta
  mockPrismaTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
    const fakeTx = {
      product: {
        findUnique: vi.fn().mockResolvedValue(mockProduct),
        update: vi.fn().mockResolvedValue({}),
      },
      journalEntry: { create: vi.fn().mockResolvedValue({}) },
    };
    return fn(fakeTx);
  });
  // GET mocks
  mockPrismaMovementCount.mockResolvedValue(0);
  mockPrismaMovementFindMany.mockResolvedValue([]);
});

// ── Auth guard — POST ──────────────────────────────────────────────────────

describe("POST /api/admin/stock-adjustments – auth guard", () => {
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

  it("allows ADMIN", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockPrismaProductFindUnique.mockResolvedValue(mockProduct);
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
  });

  it("returns 401 when role is ACCOUNTANT", async () => {
    mockGetServerSession.mockResolvedValue(ACCOUNTANT_SESSION);
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
  });
});

// ── Auth guard — GET ───────────────────────────────────────────────────────

describe("GET /api/admin/stock-adjustments – auth guard", () => {
  it("returns 401 when no session", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(401);
  });

  it("returns 401 when role is STAFF", async () => {
    mockGetServerSession.mockResolvedValue(STAFF_SESSION);
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(401);
  });

  it("returns 401 when role is ACCOUNTANT", async () => {
    mockGetServerSession.mockResolvedValue(ACCOUNTANT_SESSION);
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(401);
  });

  it("returns 200 with empty items and total=0 when page param is NaN", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockPrismaMovementCount.mockResolvedValue(0);
    mockPrismaMovementFindMany.mockResolvedValue([]);
    const res = await GET(makeGetRequest({ page: "not-a-number" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.page).toBe(1); // should fall back to 1
  });

  it("allows ADMIN and returns items + pagination metadata", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockPrismaMovementCount.mockResolvedValue(1);
    mockPrismaMovementFindMany.mockResolvedValue([
      {
        id: "mov-1",
        productId: "prod-1",
        delta: -10,
        reason: "CYCLE_COUNT",
        reasonCode: "DAMAGE",
        note: "Water damage",
        unitCost: 5.0,
        createdAt: new Date("2026-04-01"),
        product: { name: "Sterile Gloves", sku: "SG-001", cost: 5.0 },
        lot: null,
      },
    ]);
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(25);
  });

  it("uses stored unitCost for valueDelta when available", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockPrismaMovementCount.mockResolvedValue(1);
    mockPrismaMovementFindMany.mockResolvedValue([
      {
        id: "mov-1",
        productId: "prod-1",
        delta: -10,
        reason: "CYCLE_COUNT",
        reasonCode: null,
        note: null,
        unitCost: 8.0, // stored at adjustment time
        createdAt: new Date("2026-04-01"),
        product: { name: "Sterile Gloves", sku: "SG-001", cost: 5.0 }, // current cost differs
        lot: null,
      },
    ]);
    const res = await GET(makeGetRequest());
    const body = await res.json();
    // Should use stored unitCost (8.0), not current product cost (5.0)
    expect(body.items[0].unitCost).toBe(8);
    expect(body.items[0].valueDelta).toBeCloseTo(-80, 2); // -10 * 8
  });

  it("falls back to current product cost when unitCost is null (legacy record)", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockPrismaMovementCount.mockResolvedValue(1);
    mockPrismaMovementFindMany.mockResolvedValue([
      {
        id: "mov-2",
        productId: "prod-1",
        delta: -10,
        reason: "CYCLE_COUNT",
        reasonCode: null,
        note: null,
        unitCost: null, // legacy: no stored cost
        createdAt: new Date("2026-04-01"),
        product: { name: "Sterile Gloves", sku: "SG-001", cost: 5.0 },
        lot: null,
      },
    ]);
    const res = await GET(makeGetRequest());
    const body = await res.json();
    expect(body.items[0].unitCost).toBe(5);
    expect(body.items[0].valueDelta).toBeCloseTo(-50, 2); // -10 * 5
  });
});

// ── CSRF & rate-limit ──────────────────────────────────────────────────────

describe("POST /api/admin/stock-adjustments – CSRF & rate limit", () => {
  it("returns 403 when assertSameOrigin returns false", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockAssertSameOrigin.mockReturnValue(false);
    const res = await POST(makeRequest());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Bad origin");
  });

  it("returns 429 when rate limit exceeded", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockRateLimit.mockResolvedValue({ ok: false });
    const res = await POST(makeRequest());
    expect(res.status).toBe(429);
  });
});

// ── Input validation (Zod schema) ──────────────────────────────────────────

describe("POST /api/admin/stock-adjustments – input validation", () => {
  beforeEach(() => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
  });

  it("returns 400 when productId is missing", async () => {
    const res = await POST(makeRequest({ countedStock: 80, reasonType: "CYCLE_COUNT", reasonCode: "COUNT_VARIANCE", note: "count" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid input");
  });

  it("returns 400 when countedStock is negative", async () => {
    const res = await POST(makeRequest({ productId: "prod-1", countedStock: -1, reasonType: "CYCLE_COUNT", reasonCode: "COUNT_VARIANCE", note: "count" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid input");
  });

  it("returns 400 when countedStock is fractional", async () => {
    const res = await POST(makeRequest({ productId: "prod-1", countedStock: 10.5, reasonType: "CYCLE_COUNT", reasonCode: "COUNT_VARIANCE", note: "count" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid input");
  });

  it("returns 400 when reasonType is invalid", async () => {
    const res = await POST(makeRequest({ productId: "prod-1", countedStock: 80, reasonType: "INVALID", reasonCode: "COUNT_VARIANCE", note: "count" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid input");
  });

  it("returns 400 when reasonCode is invalid", async () => {
    const res = await POST(makeRequest({ productId: "prod-1", countedStock: 80, reasonType: "CYCLE_COUNT", reasonCode: "INVALID_CODE", note: "count" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid input");
  });

  it("returns 400 when note is missing", async () => {
    const res = await POST(makeRequest({ productId: "prod-1", countedStock: 80, reasonType: "CYCLE_COUNT", reasonCode: "COUNT_VARIANCE" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid input");
  });

  it("returns 400 when note is empty string", async () => {
    const res = await POST(makeRequest({ productId: "prod-1", countedStock: 80, reasonType: "CYCLE_COUNT", reasonCode: "COUNT_VARIANCE", note: "" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid input");
  });

  it("returns 400 when expiryDate is an invalid date string", async () => {
    const res = await POST(makeRequest({
      productId: "prod-1",
      countedStock: 80,
      reasonType: "CYCLE_COUNT",
      reasonCode: "COUNT_VARIANCE",
      note: "count",
      expiryDate: "not-a-date",
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid expiry date/i);
  });
});

// ── Business logic guards ──────────────────────────────────────────────────

describe("POST /api/admin/stock-adjustments – business logic guards", () => {
  beforeEach(() => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
  });

  it("returns 400 when entry date falls in a closed period", async () => {
    mockFindClosedPeriod.mockResolvedValue({ id: "period-1", name: "February 2026" });
    const res = await POST(makeRequest());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/closed/i);
  });

  it("returns 404 when product not found", async () => {
    mockPrismaProductFindUnique.mockResolvedValue(null);
    const res = await POST(makeRequest());
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Product not found");
  });

  it("returns 400 when product requires lot tracking but no lotCode provided", async () => {
    mockPrismaProductFindUnique.mockResolvedValue({ ...mockProduct, requiresLotTracking: true });
    const res = await POST(makeRequest());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/lot/i);
  });

  it("returns 400 when product requires expiry date but none provided", async () => {
    mockPrismaProductFindUnique.mockResolvedValue({ ...mockProduct, requiresExpiryDate: true });
    const res = await POST(makeRequest());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/expiry date/i);
  });

  it("returns 200 with no-change message and delta=0 when countedStock equals current stock", async () => {
    mockPrismaProductFindUnique.mockResolvedValue({ ...mockProduct, stock: 80 });
    // Transaction returns noop when delta is 0
    mockPrismaTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const fakeTx = {
        product: {
          findUnique: vi.fn().mockResolvedValue({ stock: 80 }),
          update: vi.fn(),
        },
        journalEntry: { create: vi.fn() },
      };
      return fn(fakeTx);
    });
    const res = await POST(makeRequest({ productId: "prod-1", countedStock: 80, reasonType: "CYCLE_COUNT", reasonCode: "COUNT_VARIANCE", note: "physical count" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.delta).toBe(0);
    expect(body.valueDelta).toBe(0);
    expect(body.message).toMatch(/no stock change/i);
  });

  it("returns 500 when product is deleted between pre-check and transaction", async () => {
    mockPrismaProductFindUnique.mockResolvedValue(mockProduct);
    // Simulate product disappearing inside transaction
    mockPrismaTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const fakeTx = {
        product: {
          findUnique: vi.fn().mockResolvedValue(null), // gone
          update: vi.fn(),
        },
        journalEntry: { create: vi.fn() },
      };
      return fn(fakeTx);
    });
    const res = await POST(makeRequest());
    expect(res.status).toBe(500);
  });

  it("returns 400 when ledger accounts are missing", async () => {
    mockPrismaProductFindUnique.mockResolvedValue(mockProduct);
    mockPrismaLedgerAccountFindMany.mockResolvedValue([]);
    mockPrismaLedgerAccountUpsert.mockResolvedValue({});
    const res = await POST(makeRequest());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/missing ledger accounts/i);
  });
});

// ── Success ────────────────────────────────────────────────────────────────

describe("POST /api/admin/stock-adjustments – success", () => {
  beforeEach(() => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockPrismaProductFindUnique.mockResolvedValue(mockProduct); // stock: 100, cost: 5
  });

  it("returns 200 with delta and valueDelta for stock decrease", async () => {
    const res = await POST(makeRequest({
      productId: "prod-1",
      countedStock: 80,
      reasonType: "CYCLE_COUNT",
      reasonCode: "COUNT_VARIANCE",
      note: "Physical count",
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.delta).toBe(-20);
    expect(body.valueDelta).toBeCloseTo(-100, 2); // -20 * 5.0
  });

  it("returns 200 with positive delta for stock increase", async () => {
    // Override transaction to simulate an increase
    mockPrismaTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const fakeTx = {
        product: {
          findUnique: vi.fn().mockResolvedValue({ stock: 100 }),
          update: vi.fn().mockResolvedValue({}),
        },
        journalEntry: { create: vi.fn().mockResolvedValue({}) },
      };
      return fn(fakeTx);
    });
    const res = await POST(makeRequest({
      productId: "prod-1",
      countedStock: 120,
      reasonType: "STOCK_ADJUSTMENT",
      reasonCode: "OTHER",
      note: "Recount after audit",
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.delta).toBe(20);
    expect(body.valueDelta).toBeCloseTo(100, 2); // 20 * 5.0
  });

  it("accepts optional note and lotCode fields", async () => {
    const res = await POST(makeRequest({
      productId: "prod-1",
      countedStock: 95,
      reasonType: "STOCK_ADJUSTMENT",
      reasonCode: "DAMAGE",
      note: "Water damage in warehouse",
      lotCode: "LOT-A",
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });
});
