import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mock state ────────────────────────────────────────────────────
const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockRateLimit,
  mockGetOtcShiftDayStatus,
  mockPrismaUserFindFirst,
  mockPrismaUserFindUnique,
  mockPrismaProductFindMany,
  mockPrismaInventoryLotFindMany,
  mockPrismaTransaction,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockAssertSameOrigin: vi.fn(),
  mockRateLimit: vi.fn(),
  mockGetOtcShiftDayStatus: vi.fn(),
  mockPrismaUserFindFirst: vi.fn(),
  mockPrismaUserFindUnique: vi.fn(),
  mockPrismaProductFindMany: vi.fn(),
  mockPrismaInventoryLotFindMany: vi.fn(),
  mockPrismaTransaction: vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────
vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/origin", () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mockRateLimit }));
vi.mock("@/lib/otc-shift-close", () => ({ getOtcShiftDayStatus: mockGetOtcShiftDayStatus }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: vi.fn() }));
vi.mock("@/lib/notifications", () => ({
  notifyOrderEvent: vi.fn(),
  notifyPaymentEvent: vi.fn(),
}));
vi.mock("@/lib/accounting-posting", () => ({
  postOrderEntry: vi.fn(),
  postPaymentEntry: vi.fn(),
}));
vi.mock("@/lib/inventory-lots", () => ({ allocateLotsForSale: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/credit", () => ({ isCreditLimitExceeded: vi.fn().mockResolvedValue(false) }));
vi.mock("@/lib/receipt-hash", () => ({ computeReceiptHash: vi.fn().mockReturnValue("hash-abc") }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findFirst: mockPrismaUserFindFirst, findUnique: mockPrismaUserFindUnique, create: vi.fn() },
    product: { findMany: mockPrismaProductFindMany },
    inventoryLot: { findMany: mockPrismaInventoryLotFindMany },
    $transaction: mockPrismaTransaction,
  },
}));

// ── Import after mocks ────────────────────────────────────────────────────
import { POST } from "./route";

// ── Helpers ───────────────────────────────────────────────────────────────
const ADMIN_SESSION = { user: { id: "u1", role: "ADMIN", email: "admin@example.com" } };
const STAFF_SESSION = { user: { id: "u2", role: "STAFF", email: "staff@example.com" } };

function makeRequest(body: unknown, origin = "http://localhost:3000"): Request {
  return new Request(`${origin}/api/admin/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", origin },
    body: JSON.stringify(body),
  });
}

const minValidRegisteredOrder = {
  customerType: "REGISTERED",
  userId: "customer-1",
  items: [{ productId: "prod-1", quantity: 1 }],
};

const minValidWalkInOrder = {
  customerType: "WALK_IN",
  walkInName: "Jane Doe",
  items: [{ productId: "prod-1", quantity: 1 }],
};

const baseProduct = {
  id: "prod-1",
  name: "Sterile Gloves",
  price: 25.5,
  cost: 10.0,
  stock: 50,
  archived: false,
  requiresLotTracking: false,
  requiresExpiryDate: false,
};

const mockCustomer = {
  id: "customer-1",
  role: "CUSTOMER",
  name: "Test Customer",
  email: "test@example.com",
  phone: null,
};

// ── Default "everything succeeds" setup ───────────────────────────────────
function setupHappyPath() {
  mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
  mockAssertSameOrigin.mockReturnValue(true);
  mockRateLimit.mockResolvedValue({ ok: true });
  mockGetOtcShiftDayStatus.mockResolvedValue({ isOpen: true, isClosed: false });
  mockPrismaUserFindFirst.mockResolvedValue(null);
  mockPrismaUserFindUnique.mockResolvedValue(mockCustomer);
  mockPrismaProductFindMany.mockResolvedValue([baseProduct]);
  mockPrismaInventoryLotFindMany.mockResolvedValue([]);
  // Transaction returns the shape of { ...created, status, paymentId }
  mockPrismaTransaction.mockResolvedValue({
    id: "order-1",
    status: "UNPAID",
    paymentId: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Auth guard ────────────────────────────────────────────────────────────

describe("POST /api/admin/orders – auth guard", () => {
  it("returns 401 when no session", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await POST(makeRequest(minValidRegisteredOrder));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 401 when role is CUSTOMER", async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: "u3", role: "CUSTOMER" } });
    const res = await POST(makeRequest(minValidRegisteredOrder));
    expect(res.status).toBe(401);
  });

  it("returns 401 when role is ACCOUNTANT", async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: "u4", role: "ACCOUNTANT" } });
    const res = await POST(makeRequest(minValidRegisteredOrder));
    expect(res.status).toBe(401);
  });

  it("passes auth for ADMIN role", async () => {
    setupHappyPath();
    const res = await POST(makeRequest(minValidRegisteredOrder));
    // Should not be 401 – auth passed (might be other errors downstream)
    expect(res.status).not.toBe(401);
  });

  it("passes auth for STAFF role", async () => {
    mockGetServerSession.mockResolvedValue(STAFF_SESSION);
    mockAssertSameOrigin.mockReturnValue(true);
    mockRateLimit.mockResolvedValue({ ok: true });
    mockPrismaUserFindUnique.mockResolvedValue(mockCustomer);
    mockPrismaProductFindMany.mockResolvedValue([baseProduct]);
    mockPrismaInventoryLotFindMany.mockResolvedValue([]);
    mockPrismaTransaction.mockResolvedValue({ id: "order-1", total: 25.5, status: "UNPAID" });
    const res = await POST(makeRequest(minValidRegisteredOrder));
    expect(res.status).not.toBe(401);
  });
});

// ── CSRF / origin guard ───────────────────────────────────────────────────

describe("POST /api/admin/orders – CSRF origin guard", () => {
  it("returns 403 when assertSameOrigin returns false", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockAssertSameOrigin.mockReturnValue(false);
    const res = await POST(makeRequest(minValidRegisteredOrder));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Bad origin");
  });
});

// ── Rate limiting ─────────────────────────────────────────────────────────

describe("POST /api/admin/orders – rate limit", () => {
  it("returns 429 when rate limit exceeded", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockAssertSameOrigin.mockReturnValue(true);
    mockRateLimit.mockResolvedValue({ ok: false });
    const res = await POST(makeRequest(minValidRegisteredOrder));
    expect(res.status).toBe(429);
  });
});

// ── Schema validation ─────────────────────────────────────────────────────

describe("POST /api/admin/orders – schema validation", () => {
  beforeEach(() => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockAssertSameOrigin.mockReturnValue(true);
    mockRateLimit.mockResolvedValue({ ok: true });
  });

  it("returns 400 when body is empty", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid payload");
  });

  it("returns 400 when items array is empty", async () => {
    const res = await POST(makeRequest({ customerType: "REGISTERED", userId: "u1", items: [] }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when REGISTERED order has no userId", async () => {
    const res = await POST(makeRequest({ customerType: "REGISTERED", items: [{ productId: "p1", quantity: 1 }] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.details?.fieldErrors?.userId?.[0]).toMatch(/required/i);
  });

  it("returns 400 when WALK_IN order has no walkInName and no anonymous override", async () => {
    const res = await POST(makeRequest({
      customerType: "WALK_IN",
      items: [{ productId: "p1", quantity: 1 }],
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.details?.fieldErrors?.walkInName?.[0]).toMatch(/required/i);
  });

  it("returns 400 when anonymous walk-in has no reason", async () => {
    const res = await POST(makeRequest({
      customerType: "WALK_IN",
      allowAnonymousWalkIn: true,
      items: [{ productId: "p1", quantity: 1 }],
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.details?.fieldErrors?.anonymousReason?.[0]).toMatch(/required/i);
  });

  it("returns 400 when payment method selected but amount is zero", async () => {
    const res = await POST(makeRequest({
      ...minValidRegisteredOrder,
      initialPaymentMethod: "cash",
      initialPayment: 0,
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.details?.fieldErrors?.initialPayment?.[0]).toMatch(/required/i);
  });

  it("returns 400 when MoMo payment has no reference", async () => {
    const res = await POST(makeRequest({
      ...minValidRegisteredOrder,
      initialPaymentMethod: "momo",
      initialPayment: 50,
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.details?.fieldErrors?.initialPaymentReference?.[0]).toMatch(/required/i);
  });

  it("returns 400 when discount given without reason", async () => {
    const res = await POST(makeRequest({
      ...minValidRegisteredOrder,
      discountAmount: 5,
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.details?.fieldErrors?.discountReason?.[0]).toMatch(/required/i);
  });

  it("returns 400 when closed-shift override given without reason", async () => {
    const res = await POST(makeRequest({
      ...minValidWalkInOrder,
      forceClosedShiftOverride: true,
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.details?.fieldErrors?.closedShiftOverrideReason?.[0]).toMatch(/required/i);
  });

  it("returns 400 when closed-shift override reason is too short (< 10 chars)", async () => {
    const res = await POST(makeRequest({
      ...minValidWalkInOrder,
      forceClosedShiftOverride: true,
      closedShiftOverrideReason: "short",
    }));
    expect(res.status).toBe(400);
  });
});

// ── Business logic guards (post-validation) ───────────────────────────────

describe("POST /api/admin/orders – business logic guards", () => {
  beforeEach(() => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockAssertSameOrigin.mockReturnValue(true);
    mockRateLimit.mockResolvedValue({ ok: true });
  });

  it("returns 409 when OTC shift is not open (walk-in order)", async () => {
    mockGetOtcShiftDayStatus.mockResolvedValue({ isOpen: false, isClosed: false, day: "2026-03-29" });
    const res = await POST(makeRequest(minValidWalkInOrder));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("OTC_SHIFT_NOT_OPEN");
  });

  it("returns 409 when OTC shift is closed and no override (walk-in order)", async () => {
    mockGetOtcShiftDayStatus.mockResolvedValue({
      isOpen: true,
      isClosed: true,
      day: "2026-03-29",
      closeEventId: "evt-1",
      closedAt: new Date().toISOString(),
    });
    const res = await POST(makeRequest(minValidWalkInOrder));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("OTC_SHIFT_CLOSED");
  });

  it("returns 403 when STAFF tries to apply a discount", async () => {
    mockGetServerSession.mockResolvedValue(STAFF_SESSION);
    mockGetOtcShiftDayStatus.mockResolvedValue({ isOpen: true, isClosed: false });
    const res = await POST(makeRequest({
      ...minValidRegisteredOrder,
      discountAmount: 5,
      discountReason: "loyalty reward",
    }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/admin/i);
  });

  it("returns 404 when registered customer userId does not exist", async () => {
    mockGetOtcShiftDayStatus.mockResolvedValue({ isOpen: true, isClosed: false });
    mockPrismaUserFindUnique.mockResolvedValue(null);
    const res = await POST(makeRequest(minValidRegisteredOrder));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/user not found/i);
  });

  it("returns 400 when product is not found", async () => {
    mockGetOtcShiftDayStatus.mockResolvedValue({ isOpen: true, isClosed: false });
    mockPrismaUserFindUnique.mockResolvedValue(mockCustomer);
    mockPrismaProductFindMany.mockResolvedValue([]); // no products
    mockPrismaInventoryLotFindMany.mockResolvedValue([]);
    const res = await POST(makeRequest(minValidRegisteredOrder));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/product not found/i);
  });

  it("returns 400 when product is archived", async () => {
    mockGetOtcShiftDayStatus.mockResolvedValue({ isOpen: true, isClosed: false });
    mockPrismaUserFindUnique.mockResolvedValue(mockCustomer);
    mockPrismaProductFindMany.mockResolvedValue([{ ...baseProduct, archived: true }]);
    mockPrismaInventoryLotFindMany.mockResolvedValue([]);
    const res = await POST(makeRequest(minValidRegisteredOrder));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/archived/i);
  });

  it("returns 400 when requested quantity exceeds stock", async () => {
    mockGetOtcShiftDayStatus.mockResolvedValue({ isOpen: true, isClosed: false });
    mockPrismaUserFindUnique.mockResolvedValue(mockCustomer);
    mockPrismaProductFindMany.mockResolvedValue([{ ...baseProduct, stock: 0 }]);
    mockPrismaInventoryLotFindMany.mockResolvedValue([]);
    const res = await POST(makeRequest(minValidRegisteredOrder));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/not enough stock/i);
  });

  it("returns 400 when anonymous walk-in has outstanding balance", async () => {
    mockGetOtcShiftDayStatus.mockResolvedValue({ isOpen: true, isClosed: false });
    mockPrismaUserFindFirst.mockResolvedValue(null);
    mockPrismaUserFindUnique.mockResolvedValue(null); // no linked user
    mockPrismaProductFindMany.mockResolvedValue([baseProduct]);
    mockPrismaInventoryLotFindMany.mockResolvedValue([]);
    // No initialPayment — anonymous walk-in must pay in full
    const res = await POST(makeRequest({
      customerType: "WALK_IN",
      allowAnonymousWalkIn: true,
      anonymousReason: "emergency patient, no ID",
      items: [{ productId: "prod-1", quantity: 1 }],
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/anonymous/i);
  });

  it("returns 200 with orderId on successful order creation", async () => {
    setupHappyPath();
    const res = await POST(makeRequest(minValidRegisteredOrder));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.orderId).toBe("order-1");
  });
});
