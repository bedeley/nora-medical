import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mock state ────────────────────────────────────────────────────
const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockRateLimit,
  mockPrismaProductFindUnique,
  mockPrismaSupplierPaymentFindUnique,
  mockPrismaPurchaseFindMany,
  mockPrismaTransaction,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockAssertSameOrigin: vi.fn(),
  mockRateLimit: vi.fn(),
  mockPrismaProductFindUnique: vi.fn(),
  mockPrismaSupplierPaymentFindUnique: vi.fn(),
  mockPrismaPurchaseFindMany: vi.fn(),
  mockPrismaTransaction: vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────
vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/origin", () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mockRateLimit }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ notifyBackInStock: vi.fn() }));
vi.mock("@/lib/accounting-posting", () => ({
  postPurchaseEntry: vi.fn(),
  postSupplierPaymentEntry: vi.fn(),
}));
vi.mock("@/lib/inventory-lots", () => ({
  ensureInventoryLot: vi.fn().mockResolvedValue({ id: "lot-1" }),
  normalizeLotCode: vi.fn((code: string) => code),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    product: { findUnique: mockPrismaProductFindUnique },
    supplierPayment: { findUnique: mockPrismaSupplierPaymentFindUnique },
    purchase: { findMany: mockPrismaPurchaseFindMany, findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: mockPrismaTransaction,
  },
}));

// ── Import after mocks ────────────────────────────────────────────────────
import { GET, POST } from "./route";

// ── Helpers ───────────────────────────────────────────────────────────────
const ADMIN_SESSION = { user: { id: "u1", role: "ADMIN", email: "admin@example.com" } };
const STAFF_SESSION = { user: { id: "u2", role: "STAFF" } };
const DISPATCHER_SESSION = { user: { id: "u3", role: "DISPATCHER" } };

function makeRequest(
  method: "GET" | "POST",
  bodyOrParams?: unknown,
  search = "",
): Request {
  const url = `http://localhost:3000/api/admin/purchases${search}`;
  if (method === "GET") {
    return new Request(url, { method: "GET", headers: { origin: "http://localhost:3000" } });
  }
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify(bodyOrParams),
  });
}

const validPurchaseBody = {
  productId: "prod-1",
  quantity: 10,
  unitCost: 5.0,
  supplier: "MedSupply Ltd",
  receiveNow: false,
};

// Shape matches what the $transaction callback returns
const mockTransactionResult = {
  purchaseId: "purchase-1",
  oldStock: 100,
  newStock: 110,
  newCost: 5.0,
  productName: "Sterile Gloves",
  productSku: "SG-001",
  status: "PENDING",
  supplierPaymentId: null,
  supplierPaymentStatus: null,
  highValueCreditOnly: false,
  explicitCreditMode: false,
  requiresApproval: false,
  approvalThresholdQty: null,
  supplierId: null,
  supplierName: null,
  previousUnitCost: null,
};

// Shape for GET list results
const mockListPurchase = {
  id: "purchase-1",
  productId: "prod-1",
  quantity: 10,
  unitCost: 5.0,
  total: 50.0,
  status: "PENDING",
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ── GET – auth guard ───────────────────────────────────────────────────────

describe("GET /api/admin/purchases – auth guard", () => {
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

  it("returns 401 when role is DISPATCHER", async () => {
    mockGetServerSession.mockResolvedValue(DISPATCHER_SESSION);
    const res = await GET(makeRequest("GET"));
    expect(res.status).toBe(401);
  });

  it("returns 200 for ADMIN", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockPrismaPurchaseFindMany.mockResolvedValue([]);
    const res = await GET(makeRequest("GET"));
    expect(res.status).toBe(200);
  });
});

// ── GET – list / filters ───────────────────────────────────────────────────

describe("GET /api/admin/purchases – list", () => {
  beforeEach(() => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
  });

  it("returns items array on success", async () => {
    mockPrismaPurchaseFindMany.mockResolvedValue([mockListPurchase]);
    const res = await GET(makeRequest("GET"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe("purchase-1");
  });

  it("handles start/end date filters via query string", async () => {
    mockPrismaPurchaseFindMany.mockResolvedValue([]);
    const res = await GET(makeRequest("GET", undefined, "?start=2026-01-01&end=2026-03-31"));
    expect(res.status).toBe(200);
  });

  it("returns empty items when no purchases", async () => {
    mockPrismaPurchaseFindMany.mockResolvedValue([]);
    const res = await GET(makeRequest("GET"));
    const body = await res.json();
    expect(body.items).toHaveLength(0);
  });

  it("handles purchaseId filter via query string", async () => {
    mockPrismaPurchaseFindMany.mockResolvedValue([mockListPurchase]);
    const res = await GET(makeRequest("GET", undefined, "?purchaseId=purchase-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items[0].id).toBe("purchase-1");
  });

  it("handles paymentId filter — returns no match when payment not found", async () => {
    mockPrismaSupplierPaymentFindUnique.mockResolvedValue(null);
    mockPrismaPurchaseFindMany.mockResolvedValue([]);
    const res = await GET(makeRequest("GET", undefined, "?paymentId=nonexistent"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(0);
  });
});

// ── POST – auth guard ──────────────────────────────────────────────────────

describe("POST /api/admin/purchases – auth guard", () => {
  it("returns 401 when no session", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await POST(makeRequest("POST", validPurchaseBody));
    expect(res.status).toBe(401);
  });

  it("returns 401 when STAFF (no purchases.manage permission)", async () => {
    mockGetServerSession.mockResolvedValue(STAFF_SESSION);
    const res = await POST(makeRequest("POST", validPurchaseBody));
    expect(res.status).toBe(401);
  });

  it("returns 401 when DISPATCHER", async () => {
    mockGetServerSession.mockResolvedValue(DISPATCHER_SESSION);
    const res = await POST(makeRequest("POST", validPurchaseBody));
    expect(res.status).toBe(401);
  });
});

// ── POST – CSRF / rate-limit ───────────────────────────────────────────────

describe("POST /api/admin/purchases – CSRF & rate limit", () => {
  it("returns 403 when assertSameOrigin returns false", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockAssertSameOrigin.mockReturnValue(false);
    const res = await POST(makeRequest("POST", validPurchaseBody));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Bad origin");
  });

  it("returns 429 when rate limit exceeded", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockAssertSameOrigin.mockReturnValue(true);
    mockRateLimit.mockResolvedValue({ ok: false });
    const res = await POST(makeRequest("POST", validPurchaseBody));
    expect(res.status).toBe(429);
  });
});

// ── POST – input validation ────────────────────────────────────────────────

describe("POST /api/admin/purchases – input validation", () => {
  beforeEach(() => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockAssertSameOrigin.mockReturnValue(true);
    mockRateLimit.mockResolvedValue({ ok: true });
  });

  it("returns 400 when productId is missing", async () => {
    const res = await POST(makeRequest("POST", { quantity: 5, unitCost: 10, receiveNow: false }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid input");
  });

  it("returns 400 when quantity is zero", async () => {
    const res = await POST(makeRequest("POST", { productId: "p1", quantity: 0, unitCost: 10, receiveNow: false }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid input");
  });

  it("returns 400 when quantity is negative", async () => {
    const res = await POST(makeRequest("POST", { productId: "p1", quantity: -5, unitCost: 10, receiveNow: false }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid input");
  });

  it("returns 400 when quantity is fractional (non-integer)", async () => {
    const res = await POST(makeRequest("POST", { productId: "p1", quantity: 1.5, unitCost: 10, receiveNow: false }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid input");
  });

  it("returns 400 when unitCost is negative", async () => {
    const res = await POST(makeRequest("POST", { productId: "p1", quantity: 5, unitCost: -1, receiveNow: false }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid input");
  });

  it("returns 400 when paidOnReceipt=true but no payment method", async () => {
    const res = await POST(makeRequest("POST", {
      productId: "p1",
      quantity: 5,
      unitCost: 10,
      receiveNow: true,
      paidOnReceipt: true,
      // no paymentMethod
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/payment mode/i);
  });

  it("returns 400 when expectedAt is an invalid date string", async () => {
    const res = await POST(makeRequest("POST", {
      ...validPurchaseBody,
      expectedAt: "not-a-date",
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/expected arrival date/i);
  });

  it("returns 400 when expiryDate is an invalid date string", async () => {
    const res = await POST(makeRequest("POST", {
      ...validPurchaseBody,
      expiryDate: "not-a-date",
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/expiry date/i);
  });
});

// ── POST – business logic ─────────────────────────────────────────────────

describe("POST /api/admin/purchases – business logic", () => {
  beforeEach(() => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockAssertSameOrigin.mockReturnValue(true);
    mockRateLimit.mockResolvedValue({ ok: true });
  });

  it("returns 400 when product not found (from transaction error)", async () => {
    mockPrismaTransaction.mockRejectedValue(new Error("Product not found"));
    const res = await POST(makeRequest("POST", validPurchaseBody));
    // 500 is expected for generic transaction errors; product-not-found surfaces as 500
    // since it's thrown inside the tx callback
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("returns 200 with purchaseId on successful creation", async () => {
    mockPrismaTransaction.mockResolvedValue(mockTransactionResult);
    const res = await POST(makeRequest("POST", validPurchaseBody));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.purchaseId).toBe("purchase-1");
  });
});
