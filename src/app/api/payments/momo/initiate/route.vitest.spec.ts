import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mock state ────────────────────────────────────────────────────
const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockRateLimit,
  mockPrismaUserFindUnique,
  mockPrismaOrderFindFirst,
  mockPrismaOrderFindMany,
  mockPrismaOrderFindUnique,
  mockPrismaPaymentCreate,
  mockPrismaPaymentUpdate,
  mockPrismaPaymentFindUnique,
  mockPrismaJournalEntryFindFirst,
  mockPrismaTransaction,
  mockInitiateMomo,
  mockIsLiveStage,
  mockPostPaymentEntry,
  mockRecordAuditLog,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockAssertSameOrigin: vi.fn(),
  mockRateLimit: vi.fn(),
  mockPrismaUserFindUnique: vi.fn(),
  mockPrismaOrderFindFirst: vi.fn(),
  mockPrismaOrderFindMany: vi.fn(),
  mockPrismaOrderFindUnique: vi.fn(),
  mockPrismaPaymentCreate: vi.fn(),
  mockPrismaPaymentUpdate: vi.fn(),
  mockPrismaPaymentFindUnique: vi.fn(),
  mockPrismaJournalEntryFindFirst: vi.fn(),
  mockPrismaTransaction: vi.fn(),
  mockInitiateMomo: vi.fn(),
  mockIsLiveStage: vi.fn(),
  mockPostPaymentEntry: vi.fn(),
  mockRecordAuditLog: vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────
vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/origin", () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mockRateLimit }));
vi.mock("@/lib/momo", () => ({ initiateMomo: mockInitiateMomo }));
vi.mock("@/lib/env", () => ({ isLiveStage: mockIsLiveStage }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: mockRecordAuditLog }));
vi.mock("@/lib/accounting-posting", () => ({ postPaymentEntry: mockPostPaymentEntry }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: mockPrismaUserFindUnique },
    order: {
      findFirst: mockPrismaOrderFindFirst,
      findMany: mockPrismaOrderFindMany,
      findUnique: mockPrismaOrderFindUnique,
    },
    payment: {
      create: mockPrismaPaymentCreate,
      update: mockPrismaPaymentUpdate,
      findUnique: mockPrismaPaymentFindUnique,
    },
    journalEntry: { findFirst: mockPrismaJournalEntryFindFirst },
    $transaction: mockPrismaTransaction,
  },
}));

// ── Import after mocks ────────────────────────────────────────────────────
import { POST } from "./route";

// ── Fixtures ──────────────────────────────────────────────────────────────
const baseSession = { user: { id: "user-1", role: "CUSTOMER" } };

const openOrder = {
  id: "order-1",
  total: 200,
  amountPaid: 50,
  status: "UNPAID",
  balance: 150,
};

const basePayment = {
  id: "payment-1",
  userId: "user-1",
  orderId: null,
  amount: 150,
  note: null,
  createdAt: new Date(),
};

function makeRequest(body: Record<string, unknown> = {}): Request {
  const defaults = { phone: "0201234567", provider: "mtn" };
  return new Request("http://localhost/api/payments/momo/initiate", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify({ ...defaults, ...body }),
  });
}

// ── Default mock wiring (reset in beforeEach) ─────────────────────────────
beforeEach(() => {
  vi.clearAllMocks();

  mockGetServerSession.mockResolvedValue(baseSession);
  mockAssertSameOrigin.mockReturnValue(true);
  mockRateLimit.mockResolvedValue({ ok: true });
  mockPrismaUserFindUnique.mockResolvedValue({
    id: "user-1",
    name: "Test User",
    email: "test@example.com",
    phone: null,
  });
  // No specific orderId used by default → orderFindFirst returns null
  mockPrismaOrderFindFirst.mockResolvedValue(null);
  // findMany returns one open order so balance > 0
  mockPrismaOrderFindMany.mockResolvedValue([openOrder]);
  mockPrismaPaymentCreate.mockResolvedValue(basePayment);
  mockPrismaPaymentUpdate.mockResolvedValue({ ...basePayment });
  mockPrismaPaymentFindUnique.mockResolvedValue({
    note: JSON.stringify({ applied: [] }),
  });
  mockPrismaJournalEntryFindFirst.mockResolvedValue(null);
  mockPrismaOrderFindUnique.mockResolvedValue(null);
  // transaction resolves undefined (bypassed)
  mockPrismaTransaction.mockResolvedValue(undefined);
  // initiateMomo succeeds with a real (non-TEST) reference
  mockInitiateMomo.mockResolvedValue({ ok: true, reference: "MOMO-REF-123" });
  // not live stage → TEST- references would auto-apply
  mockIsLiveStage.mockReturnValue(false);
  mockPostPaymentEntry.mockResolvedValue(null);
  mockRecordAuditLog.mockResolvedValue(undefined);
});

// ── auth ──────────────────────────────────────────────────────────────────

describe("POST /api/payments/momo/initiate – auth", () => {
  it("returns 401 when there is no session", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/unauthorized/i);
  });
});

// ── CSRF ──────────────────────────────────────────────────────────────────

describe("POST /api/payments/momo/initiate – CSRF", () => {
  it("returns 403 when assertSameOrigin returns false", async () => {
    mockAssertSameOrigin.mockReturnValue(false);
    const res = await POST(makeRequest());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/origin/i);
  });
});

// ── rate limit ────────────────────────────────────────────────────────────

describe("POST /api/payments/momo/initiate – rate limit", () => {
  it("returns 429 when rate limit is exceeded", async () => {
    mockRateLimit.mockResolvedValue({ ok: false });
    const res = await POST(makeRequest());
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toMatch(/too many/i);
  });
});

// ── validation ────────────────────────────────────────────────────────────

describe("POST /api/payments/momo/initiate – validation", () => {
  it("returns 400 'Invalid payload' when phone is missing", async () => {
    const res = await POST(makeRequest({ phone: undefined }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid payload");
  });

  it("returns 400 'Invalid payload' when phone is fewer than 7 characters", async () => {
    const res = await POST(makeRequest({ phone: "01234" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid payload");
  });

  it("returns 400 'Invalid payload' when provider is not a valid enum value", async () => {
    const res = await POST(makeRequest({ provider: "orange" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid payload");
  });
});

// ── order lookup ──────────────────────────────────────────────────────────

describe("POST /api/payments/momo/initiate – order lookup", () => {
  it("returns 404 'Order not found' when a valid orderId is provided but the order does not exist", async () => {
    const validCuid = "clgmq8fx60000mg2rhp5c7hrd";
    mockPrismaOrderFindFirst.mockResolvedValue(null);
    const res = await POST(makeRequest({ orderId: validCuid }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Order not found");
  });
});

// ── balance check ─────────────────────────────────────────────────────────

describe("POST /api/payments/momo/initiate – balance check", () => {
  it("returns 400 'Order already paid' when findMany returns no open orders (balance=0)", async () => {
    mockPrismaOrderFindMany.mockResolvedValue([]);
    const res = await POST(makeRequest());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Order already paid");
  });

  it("returns 400 'Order already paid' when the single open order is fully paid (balance=0)", async () => {
    mockPrismaOrderFindMany.mockResolvedValue([
      { ...openOrder, total: 200, amountPaid: 200, balance: 0 },
    ]);
    const res = await POST(makeRequest());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Order already paid");
  });
});

// ── provider failure ──────────────────────────────────────────────────────

describe("POST /api/payments/momo/initiate – provider failure", () => {
  beforeEach(() => {
    mockInitiateMomo.mockResolvedValue({ ok: false, error: "Provider timeout" });
  });

  it("returns 502 with the provider error message when initiateMomo fails", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("Provider timeout");
  });

  it("soft-deletes the payment (sets deletedAt) when initiateMomo fails", async () => {
    await POST(makeRequest());
    expect(mockPrismaPaymentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "payment-1" },
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    );
  });
});

// ── test reference auto-apply ─────────────────────────────────────────────

describe("POST /api/payments/momo/initiate – test reference auto-apply", () => {
  it("returns applied:true and simulated:true when reference starts with TEST- and not live stage", async () => {
    mockInitiateMomo.mockResolvedValue({ ok: true, reference: "TEST-ABC-123" });
    mockIsLiveStage.mockReturnValue(false);
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.paymentId).toBe("payment-1");
    expect(body.reference).toBe("TEST-ABC-123");
    expect(body.applied).toBe(true);
    expect(body.simulated).toBe(true);
  });
});

// ── success ───────────────────────────────────────────────────────────────

describe("POST /api/payments/momo/initiate – success", () => {
  it("returns status 200 for a normal (non-TEST) successful initiation", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
  });

  it("response body contains ok, paymentId, and reference — but NOT applied — for a normal reference", async () => {
    const res = await POST(makeRequest());
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.paymentId).toBe("payment-1");
    expect(body.reference).toBe("MOMO-REF-123");
    expect(body.applied).toBeUndefined();
  });
});
