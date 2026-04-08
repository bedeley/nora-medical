import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mock state ────────────────────────────────────────────────────
const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockRateLimit,
  mockPrismaTransaction,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockAssertSameOrigin: vi.fn(),
  mockRateLimit: vi.fn(),
  mockPrismaTransaction: vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────
vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/origin", () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mockRateLimit }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: vi.fn() }));
vi.mock("@/lib/accounting-posting", () => ({ postSupplierReturnEntry: vi.fn() }));
vi.mock("@/lib/inventory-lots", () => ({
  allocateLotsForSale: vi.fn().mockResolvedValue(undefined),
  applyLotAdjustment: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
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
    `http://localhost:3000/api/admin/purchases/${id}/return`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify(body ?? { quantity: 5 }),
    },
  );
  return [req, { params: Promise.resolve({ id }) }];
}

const mockSuccessResult = {
  purchaseId: "purchase-1",
  productId: "prod-1",
  productName: "Sterile Gloves",
  productSku: "SG-001",
  unitCost: 5.0,
  nextStatus: "PARTIALLY_RECEIVED",
  supplier: "MedSupply Ltd",
  supplierId: "sup-1",
  creditId: "credit-1",
  creditAmount: 25.0,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAssertSameOrigin.mockReturnValue(true);
  mockRateLimit.mockResolvedValue({ ok: true });
});

// ── Auth guard ─────────────────────────────────────────────────────────────

describe("POST /api/admin/purchases/[id]/return – auth guard", () => {
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

describe("POST /api/admin/purchases/[id]/return – CSRF & rate limit", () => {
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

describe("POST /api/admin/purchases/[id]/return – input validation", () => {
  beforeEach(() => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
  });

  it("returns 400 when quantity is 0", async () => {
    const res = await POST(...makeRequest({ quantity: 0 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid return quantity/i);
  });

  it("returns 400 when quantity is negative", async () => {
    const res = await POST(...makeRequest({ quantity: -3 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid return quantity/i);
  });

  it("returns 400 when quantity is a non-numeric string", async () => {
    const res = await POST(...makeRequest({ quantity: "xyz" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid return quantity/i);
  });
});

// ── Business logic guards ──────────────────────────────────────────────────

describe("POST /api/admin/purchases/[id]/return – business logic", () => {
  beforeEach(() => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
  });

  it("returns 400 when purchase not found", async () => {
    mockPrismaTransaction.mockRejectedValue(new Error("Purchase not found."));
    const res = await POST(...makeRequest({ quantity: 5 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Purchase not found.");
  });

  it("returns 400 when purchase has no received items to return", async () => {
    mockPrismaTransaction.mockRejectedValue(
      new Error("This purchase has no received items to return."),
    );
    const res = await POST(...makeRequest({ quantity: 5 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/no received items/i);
  });

  it("returns 400 when return quantity exceeds received quantity", async () => {
    mockPrismaTransaction.mockRejectedValue(
      new Error("Return quantity exceeds received quantity."),
    );
    const res = await POST(...makeRequest({ quantity: 999 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/exceeds received quantity/i);
  });

  it("returns 400 when insufficient on-hand stock", async () => {
    mockPrismaTransaction.mockRejectedValue(
      new Error("Insufficient on-hand stock to return."),
    );
    const res = await POST(...makeRequest({ quantity: 5 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/insufficient on-hand stock/i);
  });
});

// ── Success ────────────────────────────────────────────────────────────────

describe("POST /api/admin/purchases/[id]/return – success", () => {
  beforeEach(() => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
  });

  it("returns 200 with ok:true on successful supplier return", async () => {
    mockPrismaTransaction.mockResolvedValue(mockSuccessResult);
    const res = await POST(...makeRequest({ quantity: 5 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("accepts optional lotCode and note fields", async () => {
    mockPrismaTransaction.mockResolvedValue({
      ...mockSuccessResult,
      nextStatus: "CANCELLED",
    });
    const res = await POST(...makeRequest({ quantity: 10, lotCode: "LOT-001", note: "Damaged batch" }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });
});
