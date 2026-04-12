import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mock state ────────────────────────────────────────────────────
const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockRateLimit,
  mockPrismaTransaction,
  mockPrismaProductFindUnique,
  mockRecordAuditLog,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockAssertSameOrigin: vi.fn(),
  mockRateLimit: vi.fn(),
  mockPrismaTransaction: vi.fn(),
  mockPrismaProductFindUnique: vi.fn(),
  mockRecordAuditLog: vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────
vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/origin", () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mockRateLimit }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: mockRecordAuditLog }));
vi.mock("@/lib/stock-alerts", () => ({ notifyBackInStock: vi.fn() }));
vi.mock("@/lib/accounting-posting", () => ({ postPurchaseReceiptEntry: vi.fn() }));
vi.mock("@/lib/inventory-lots", () => ({
  ensureInventoryLot: vi.fn().mockResolvedValue({ id: "lot-1", lotCode: "LOT-001" }),
  normalizeLotCode: vi.fn((code: string) => code),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    product: { findUnique: mockPrismaProductFindUnique },
    $transaction: mockPrismaTransaction,
  },
}));

// ── Import after mocks ────────────────────────────────────────────────────
import { POST } from "./route";

// ── Helpers ───────────────────────────────────────────────────────────────
const ADMIN_SESSION = { user: { id: "u1", role: "ADMIN", email: "admin@example.com" } };
const STAFF_SESSION = { user: { id: "u2", role: "STAFF" } };
const ACCOUNTANT_SESSION = { user: { id: "u3", role: "ACCOUNTANT" } };

function makeRequest(body?: unknown, id = "purchase-1"): [Request, { params: Promise<{ id: string }> }] {
  const req = new Request(
    `http://localhost:3000/api/admin/purchases/${id}/receive`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify(body ?? { quantity: 10 }),
    },
  );
  return [req, { params: Promise.resolve({ id }) }];
}

const mockSuccessResult = {
  purchase: {
    id: "purchase-1",
    productId: "prod-1",
    receivedQuantity: 10,
    unitCost: 5.0,
    status: "RECEIVED",
  },
  previousStatus: "APPROVED",
  productName: "Sterile Gloves",
  productSku: "SG-001",
  oldStock: 100,
  newStock: 110,
  newCost: 5.0,
  delta: 10,
  ordered: 10,
  previousReceivedQuantity: 0,
  nextStatus: "RECEIVED",
  supplier: "MedSupply Ltd",
  lotCode: "LOT-001",
  lotNotes: null,
  supplierId: "sup-1",
  receivedAt: new Date("2026-04-08T12:00:00.000Z"),
  previousUnitCost: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAssertSameOrigin.mockReturnValue(true);
  mockRateLimit.mockResolvedValue({ ok: true });
});

// ── Auth guard ─────────────────────────────────────────────────────────────

describe("POST /api/admin/purchases/[id]/receive – auth guard", () => {
  it("returns 401 when no session", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await POST(...makeRequest());
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Unauthorized");
  });

  it("returns 401 when role is STAFF (no purchases.manage permission)", async () => {
    mockGetServerSession.mockResolvedValue(STAFF_SESSION);
    const res = await POST(...makeRequest());
    expect(res.status).toBe(401);
  });

  it("returns 401 when role is ACCOUNTANT (no purchases.manage permission)", async () => {
    mockGetServerSession.mockResolvedValue(ACCOUNTANT_SESSION);
    const res = await POST(...makeRequest());
    expect(res.status).toBe(401);
  });
});

// ── CSRF & rate-limit ──────────────────────────────────────────────────────

describe("POST /api/admin/purchases/[id]/receive – CSRF & rate limit", () => {
  it("returns 403 when assertSameOrigin returns false", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockAssertSameOrigin.mockReturnValue(false);
    const res = await POST(...makeRequest());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Bad origin");
  });

  it("returns 429 when rate limit exceeded", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockRateLimit.mockResolvedValue({ ok: false });
    const res = await POST(...makeRequest());
    expect(res.status).toBe(429);
  });
});

// ── Input validation ───────────────────────────────────────────────────────

describe("POST /api/admin/purchases/[id]/receive – input validation", () => {
  beforeEach(() => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
  });

  it("returns 400 when quantity is 0", async () => {
    const res = await POST(...makeRequest({ quantity: 0 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid receive quantity/i);
  });

  it("returns 400 when quantity is negative", async () => {
    const res = await POST(...makeRequest({ quantity: -5 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid receive quantity/i);
  });

  it("returns 400 when quantity is fractional", async () => {
    const res = await POST(...makeRequest({ quantity: 1.5 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid receive quantity/i);
  });

  it("returns 400 when quantity is non-numeric string", async () => {
    const res = await POST(...makeRequest({ quantity: "abc" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid receive quantity/i);
  });

  it("returns 400 when expiryDate is not a valid date string", async () => {
    const res = await POST(...makeRequest({ quantity: 10, expiryDate: "not-a-date" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid expiry date/i);
  });
});

// ── Business logic guards ──────────────────────────────────────────────────

describe("POST /api/admin/purchases/[id]/receive – business logic", () => {
  beforeEach(() => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
  });

  it("returns 400 when purchase not found", async () => {
    mockPrismaTransaction.mockRejectedValue(new Error("Purchase not found"));
    const res = await POST(...makeRequest({ quantity: 10 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Purchase not found");
  });

  it("returns 400 when purchase is cancelled", async () => {
    mockPrismaTransaction.mockRejectedValue(new Error("Purchase is cancelled"));
    const res = await POST(...makeRequest({ quantity: 10 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Purchase is cancelled");
  });

  it("returns 400 when purchase already fully received", async () => {
    mockPrismaTransaction.mockRejectedValue(new Error("Purchase already fully received"));
    const res = await POST(...makeRequest({ quantity: 10 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Purchase already fully received");
  });

  it("returns 400 when purchase is pending approval", async () => {
    mockPrismaTransaction.mockRejectedValue(new Error("Purchase must be approved before receiving"));
    const res = await POST(...makeRequest({ quantity: 10 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Purchase must be approved before receiving");
  });

  it("returns 400 when nothing left to receive (delta <= 0)", async () => {
    mockPrismaTransaction.mockRejectedValue(new Error("Nothing to receive"));
    const res = await POST(...makeRequest({ quantity: 10 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Nothing to receive");
  });

  it("returns 400 when lot tracking required but no lot code provided", async () => {
    mockPrismaTransaction.mockRejectedValue(new Error("Lot/Batch code is required for this product."));
    const res = await POST(...makeRequest({ quantity: 10 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/lot/i);
  });

  it("returns 400 when expiry date required but not provided", async () => {
    mockPrismaTransaction.mockRejectedValue(new Error("Expiry date is required for this product."));
    const res = await POST(...makeRequest({ quantity: 10 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/expiry date/i);
  });
});

// ── Success ────────────────────────────────────────────────────────────────

describe("POST /api/admin/purchases/[id]/receive – success", () => {
  beforeEach(() => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
  });

  it("returns 200 with ok:true and result shape on full receipt", async () => {
    mockPrismaTransaction.mockResolvedValue(mockSuccessResult);
    const res = await POST(...makeRequest({ quantity: 10 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.newStock).toBe(110);
    expect(body.delta).toBe(10);
    expect(body.nextStatus).toBe("RECEIVED");
    expect(mockRecordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "PURCHASE_RECEIVE",
        entityId: "purchase-1",
        meta: expect.objectContaining({
          productId: "prod-1",
          productName: "Sterile Gloves",
          productSku: "SG-001",
          supplierId: "sup-1",
          lotCode: "LOT-001",
          source: "PURCHASE_RECEIVE",
        }),
      }),
    );
  });

  it("returns 200 for partial receipt (delta < ordered)", async () => {
    mockPrismaTransaction.mockResolvedValue({
      ...mockSuccessResult,
      delta: 5,
      newStock: 105,
      nextStatus: "PARTIALLY_RECEIVED",
      purchase: { ...mockSuccessResult.purchase, receivedQuantity: 5, status: "PARTIALLY_RECEIVED" },
    });
    const res = await POST(...makeRequest({ quantity: 5 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.nextStatus).toBe("PARTIALLY_RECEIVED");
  });
});
