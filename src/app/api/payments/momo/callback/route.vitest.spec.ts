import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mock state ────────────────────────────────────────────────────
const {
  mockVerifyMomoSignature,
  mockParseMomoCallbackBody,
  mockPrismaPaymentFindUnique,
  mockPrismaUserFindUnique,
  mockPrismaTransaction,
  mockPrismaJournalEntryFindFirst,
  mockPrismaOrderFindUnique,
  mockPostPaymentEntry,
  mockNotifyPaymentEvent,
  mockRecordAuditLog,
} = vi.hoisted(() => ({
  mockVerifyMomoSignature: vi.fn(),
  mockParseMomoCallbackBody: vi.fn(),
  mockPrismaPaymentFindUnique: vi.fn(),
  mockPrismaUserFindUnique: vi.fn(),
  mockPrismaTransaction: vi.fn(),
  mockPrismaJournalEntryFindFirst: vi.fn(),
  mockPrismaOrderFindUnique: vi.fn(),
  mockPostPaymentEntry: vi.fn(),
  mockNotifyPaymentEvent: vi.fn(),
  mockRecordAuditLog: vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────
vi.mock("@/lib/momo", () => ({
  verifyMomoSignature: mockVerifyMomoSignature,
  parseMomoCallbackBody: mockParseMomoCallbackBody,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    payment: {
      findUnique: mockPrismaPaymentFindUnique,
    },
    user: {
      findUnique: mockPrismaUserFindUnique,
    },
    journalEntry: {
      findFirst: mockPrismaJournalEntryFindFirst,
    },
    order: {
      findUnique: mockPrismaOrderFindUnique,
    },
    $transaction: mockPrismaTransaction,
  },
}));
vi.mock("@/lib/accounting-posting", () => ({ postPaymentEntry: mockPostPaymentEntry }));
vi.mock("@/lib/notifications", () => ({ notifyPaymentEvent: mockNotifyPaymentEvent }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: mockRecordAuditLog }));

// ── Import after mocks ────────────────────────────────────────────────────
import { POST } from "./route";

// ── Fixtures ──────────────────────────────────────────────────────────────
const basePayment = {
  id: "payment-1",
  userId: null,
  orderId: null,
  amount: 100,
  note: null,
};

function makeRequest(): Request {
  return new Request("http://localhost/api/payments/momo/callback", {
    method: "POST",
    body: "raw-body",
    headers: { "content-type": "application/json" },
  });
}

// ── Default mock wiring (reset in beforeEach) ─────────────────────────────
beforeEach(() => {
  vi.clearAllMocks();

  // signature valid
  mockVerifyMomoSignature.mockReturnValue(true);
  // parsed body valid, SUCCESSFUL
  mockParseMomoCallbackBody.mockReturnValue({
    valid: true,
    externalId: "payment-1",
    status: "SUCCESSFUL",
  });
  // payment found
  mockPrismaPaymentFindUnique.mockResolvedValue(basePayment);
  // no user profile needed (userId null)
  mockPrismaUserFindUnique.mockResolvedValue(null);
  // transaction: not already done, successful
  mockPrismaTransaction.mockResolvedValue({ alreadyDone: false, successful: true });
  // postPaymentEntry returns null (no journal entry id)
  mockPostPaymentEntry.mockResolvedValue(null);
  // journalEntry fallback returns null
  mockPrismaJournalEntryFindFirst.mockResolvedValue(null);
  // order after: none (orderId is null)
  mockPrismaOrderFindUnique.mockResolvedValue(null);
  // second payment.findUnique (note read after)
  // mockPrismaPaymentFindUnique is also used for this; resolved above
  // notifyPaymentEvent resolves
  mockNotifyPaymentEvent.mockResolvedValue(undefined);
  // recordAuditLog resolves
  mockRecordAuditLog.mockResolvedValue(undefined);
});

// ── signature ─────────────────────────────────────────────────────────────

describe("POST /api/payments/momo/callback – signature", () => {
  it("returns 400 with 'Invalid signature' when verifyMomoSignature returns false", async () => {
    mockVerifyMomoSignature.mockReturnValue(false);
    const res = await POST(makeRequest());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid signature");
  });
});

// ── body parsing ──────────────────────────────────────────────────────────

describe("POST /api/payments/momo/callback – body parsing", () => {
  it("returns 400 with 'Invalid callback' when parsed.valid is false", async () => {
    mockParseMomoCallbackBody.mockReturnValue({
      valid: false,
      externalId: "payment-1",
      status: "SUCCESSFUL",
    });
    const res = await POST(makeRequest());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid callback");
  });

  it("returns 400 with 'Invalid callback' when externalId is missing", async () => {
    mockParseMomoCallbackBody.mockReturnValue({
      valid: true,
      externalId: undefined,
      status: "SUCCESSFUL",
    });
    const res = await POST(makeRequest());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid callback");
  });
});

// ── payment lookup ────────────────────────────────────────────────────────

describe("POST /api/payments/momo/callback – payment lookup", () => {
  it("returns 404 with 'Payment not found' when payment does not exist", async () => {
    mockPrismaPaymentFindUnique.mockResolvedValue(null);
    const res = await POST(makeRequest());
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Payment not found");
  });
});

// ── already applied ───────────────────────────────────────────────────────

describe("POST /api/payments/momo/callback – already applied", () => {
  it("returns 200 ok:true and does NOT call postPaymentEntry when alreadyDone is true", async () => {
    mockPrismaTransaction.mockResolvedValue({ alreadyDone: true });
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(mockPostPaymentEntry).not.toHaveBeenCalled();
  });
});

// ── non-successful status ─────────────────────────────────────────────────

describe("POST /api/payments/momo/callback – non-successful status", () => {
  beforeEach(() => {
    mockPrismaTransaction.mockResolvedValue({ alreadyDone: false, successful: false });
  });

  it("returns 200 with ok:true when transaction reports unsuccessful", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("calls postPaymentEntry (best-effort) when transaction reports unsuccessful", async () => {
    await POST(makeRequest());
    expect(mockPostPaymentEntry).toHaveBeenCalledWith({ paymentId: "payment-1" });
  });
});

// ── success ───────────────────────────────────────────────────────────────

describe("POST /api/payments/momo/callback – success", () => {
  it("returns 200 with ok:true on a successful transaction", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("calls postPaymentEntry after a successful transaction", async () => {
    await POST(makeRequest());
    expect(mockPostPaymentEntry).toHaveBeenCalledWith({ paymentId: "payment-1" });
  });

  it("falls back to journalEntry.findFirst when postPaymentEntry returns null", async () => {
    mockPostPaymentEntry.mockResolvedValue(null);
    await POST(makeRequest());
    expect(mockPrismaJournalEntryFindFirst).toHaveBeenCalled();
  });

  it("skips journalEntry.findFirst when postPaymentEntry returns an entry with an id", async () => {
    mockPostPaymentEntry.mockResolvedValue({ id: "je-1" });
    await POST(makeRequest());
    expect(mockPrismaJournalEntryFindFirst).not.toHaveBeenCalled();
  });

  it("calls notifyPaymentEvent when payment.userId is set", async () => {
    mockPrismaPaymentFindUnique.mockResolvedValue({
      ...basePayment,
      userId: "user-1",
    });
    await POST(makeRequest());
    expect(mockNotifyPaymentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", kind: "payment_recorded" }),
    );
  });

  it("does NOT call notifyPaymentEvent when payment.userId is null", async () => {
    // default basePayment has userId: null
    await POST(makeRequest());
    expect(mockNotifyPaymentEvent).not.toHaveBeenCalled();
  });
});

// ── error handling ────────────────────────────────────────────────────────

describe("POST /api/payments/momo/callback – error handling", () => {
  it("returns 500 with the error message when the transaction throws a non-P2034 error", async () => {
    mockPrismaTransaction.mockRejectedValue(new Error("DB exploded"));
    const res = await POST(makeRequest());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("DB exploded");
  });
});
