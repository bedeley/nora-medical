import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mock state ────────────────────────────────────────────────────
const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockSupplierFindFirst,
  mockSupplierPaymentCreate,
  mockSupplierPaymentGroupBy,
  mockSupplierPaymentFindMany,
  mockSupplierPaymentAggregate,
  mockPurchaseFindUnique,
  mockPurchaseFindMany,
  mockPrismaTransaction,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockAssertSameOrigin: vi.fn(),
  mockSupplierFindFirst: vi.fn(),
  mockSupplierPaymentCreate: vi.fn(),
  mockSupplierPaymentGroupBy: vi.fn(),
  mockSupplierPaymentFindMany: vi.fn(),
  mockSupplierPaymentAggregate: vi.fn(),
  mockPurchaseFindUnique: vi.fn(),
  mockPurchaseFindMany: vi.fn(),
  mockPrismaTransaction: vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────
vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/origin", () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: vi.fn() }));
vi.mock("@/lib/accounting-posting", () => ({
  postSupplierPaymentEntry: vi.fn(),
  postSupplierRefundEntry: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    supplier: { findFirst: mockSupplierFindFirst },
    supplierPayment: {
      create: mockSupplierPaymentCreate,
      groupBy: mockSupplierPaymentGroupBy,
      findMany: mockSupplierPaymentFindMany,
      aggregate: mockSupplierPaymentAggregate,
    },
    purchase: {
      findUnique: mockPurchaseFindUnique,
      findMany: mockPurchaseFindMany,
    },
    $transaction: mockPrismaTransaction,
  },
}));

// ── Import after mocks ────────────────────────────────────────────────────
import { POST } from "./route";

// ── Helpers ───────────────────────────────────────────────────────────────
const ADMIN_SESSION = { user: { id: "u1", role: "ADMIN", email: "admin@example.com" } };
const ACCOUNTANT_SESSION = { user: { id: "u2", role: "ACCOUNTANT" } };
const STAFF_SESSION = { user: { id: "u3", role: "STAFF" } };

function makePOST(body?: unknown): Request {
  return new Request("http://localhost:3000/api/admin/supplier-payments", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
    body: JSON.stringify(body ?? {}),
  });
}

const mockCreatedPayment = {
  id: "pay-1",
  supplierId: "sup-1",
  purchaseId: "purchase-1",
  amount: 500,
  method: "cash",
  reference: null,
  note: null,
  proofUrl: null,
  status: "NORMAL",
  paidAt: new Date(),
};

const eligiblePurchase = {
  id: "purchase-1",
  supplierId: "sup-1",
  unitCost: 100,
  quantity: 10,
  orderedQuantity: 10,
  receivedQuantity: 10,
  status: "RECEIVED",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAssertSameOrigin.mockReturnValue(true);
  mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
});

// ── CSRF guard (first check in POST) ──────────────────────────────────────

describe("POST /api/admin/supplier-payments – CSRF guard", () => {
  it("returns 403 when assertSameOrigin returns false (no session required)", async () => {
    mockAssertSameOrigin.mockReturnValue(false);
    const res = await POST(makePOST());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Bad origin");
  });
});

// ── Auth guard ─────────────────────────────────────────────────────────────

describe("POST /api/admin/supplier-payments – auth guard", () => {
  it("returns 401 when no session", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await POST(makePOST({ amount: 100 }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Unauthorized");
  });

  it("returns 401 when role is ACCOUNTANT (no supplierPayments.manage)", async () => {
    mockGetServerSession.mockResolvedValue(ACCOUNTANT_SESSION);
    const res = await POST(makePOST({ amount: 100 }));
    expect(res.status).toBe(401);
  });

  it("returns 401 when role is STAFF", async () => {
    mockGetServerSession.mockResolvedValue(STAFF_SESSION);
    const res = await POST(makePOST({ amount: 100 }));
    expect(res.status).toBe(401);
  });
});

// ── Input validation ───────────────────────────────────────────────────────

describe("POST /api/admin/supplier-payments – input validation", () => {
  it("returns 400 when amount is 0", async () => {
    const res = await POST(makePOST({ amount: 0, purchaseId: "p-1" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid payment details/i);
  });

  it("returns 400 when amount is negative", async () => {
    const res = await POST(makePOST({ amount: -50, purchaseId: "p-1" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid payment details/i);
  });

  it("returns 400 when amount is non-numeric", async () => {
    const res = await POST(makePOST({ amount: "abc", purchaseId: "p-1" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid payment details/i);
  });
});

// ── Refund path ────────────────────────────────────────────────────────────

describe("POST /api/admin/supplier-payments – refund path", () => {
  it("returns 400 when refund has no supplierId or supplierName", async () => {
    const res = await POST(makePOST({ kind: "refund", amount: 200 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/supplier is required for refunds/i);
  });

  it("returns 200 with payment id when refund succeeds (supplierId provided)", async () => {
    mockSupplierPaymentCreate.mockResolvedValue({ ...mockCreatedPayment, method: "refund" });
    const res = await POST(makePOST({ kind: "refund", amount: 200, supplierId: "sup-1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.id).toBe("pay-1");
  });

  it("resolves supplierId by supplierName when supplierId is absent", async () => {
    mockSupplierFindFirst.mockResolvedValue({ id: "sup-found", name: "MedSupply Ltd" });
    mockSupplierPaymentCreate.mockResolvedValue({ ...mockCreatedPayment, supplierId: "sup-found", method: "refund" });
    const res = await POST(makePOST({ kind: "refund", amount: 200, supplierName: "MedSupply Ltd" }));
    expect(res.status).toBe(200);
    expect(mockSupplierFindFirst).toHaveBeenCalled();
  });
});

// ── Single purchase payment path ───────────────────────────────────────────

describe("POST /api/admin/supplier-payments – single purchase payment", () => {
  it("returns 404 when purchase is not found", async () => {
    mockPurchaseFindUnique.mockResolvedValue(null);
    const res = await POST(makePOST({ amount: 500, purchaseId: "nonexistent" }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Purchase not found");
  });

  it("returns 400 when purchase is in PENDING status (not eligible)", async () => {
    mockPurchaseFindUnique.mockResolvedValue({ ...eligiblePurchase, status: "PENDING", receivedQuantity: 0 });
    const res = await POST(makePOST({ amount: 500, purchaseId: "purchase-1" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/cannot record payment/i);
  });

  it("returns 400 when purchase is CANCELLED with no received items", async () => {
    // CANCELLED + receivedQty=0 fails the eligibility check first (not in eligibleStatuses,
    // canPayCancelled is false) so the route returns the generic "approved" message.
    mockPurchaseFindUnique.mockResolvedValue({ ...eligiblePurchase, status: "CANCELLED", receivedQuantity: 0 });
    const res = await POST(makePOST({ amount: 500, purchaseId: "purchase-1" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/cannot record payment/i);
  });

  it("returns 200 with payment id on success (RECEIVED purchase)", async () => {
    mockPurchaseFindUnique.mockResolvedValue(eligiblePurchase);
    mockSupplierPaymentCreate.mockResolvedValue(mockCreatedPayment);
    const res = await POST(makePOST({ amount: 500, purchaseId: "purchase-1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.id).toBe("pay-1");
  });

  it("returns 200 for APPROVED purchase (payment before receipt)", async () => {
    mockPurchaseFindUnique.mockResolvedValue({ ...eligiblePurchase, status: "APPROVED", receivedQuantity: 0 });
    mockSupplierPaymentCreate.mockResolvedValue(mockCreatedPayment);
    const res = await POST(makePOST({ amount: 500, purchaseId: "purchase-1" }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });
});

// ── Bulk payment path ──────────────────────────────────────────────────────

describe("POST /api/admin/supplier-payments – bulk payment", () => {
  it("returns 400 when no purchaseId and no supplierId or supplierName", async () => {
    const res = await POST(makePOST({ amount: 1000 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/supplier is required for bulk payments/i);
  });

  it("returns 404 when no matching purchases found for supplier", async () => {
    mockPurchaseFindMany.mockResolvedValue([]);
    const res = await POST(makePOST({ amount: 1000, supplierId: "sup-1" }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/no matching purchases found/i);
  });

  it("returns 400 when all supplier purchases are already fully paid", async () => {
    mockPurchaseFindMany.mockResolvedValue([
      { ...eligiblePurchase, createdAt: new Date() },
    ]);
    mockSupplierPaymentGroupBy.mockResolvedValue([
      { purchaseId: "purchase-1", _sum: { amount: 1000 } }, // fully paid
    ]);
    const res = await POST(makePOST({ amount: 500, supplierId: "sup-1" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/no outstanding balances/i);
  });

  it("returns 200 with allocations on successful bulk payment", async () => {
    mockPurchaseFindMany.mockResolvedValue([
      { ...eligiblePurchase, createdAt: new Date() },
    ]);
    mockSupplierPaymentGroupBy.mockResolvedValue([]); // nothing paid yet
    mockPrismaTransaction.mockResolvedValue([mockCreatedPayment]);
    const res = await POST(makePOST({ amount: 500, supplierId: "sup-1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.allocations).toHaveLength(1);
    expect(body.allocations[0].id).toBe("pay-1");
  });
});
