import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockRateLimit,
  mockUserFindUnique,
  mockPaymentFindMany,
  mockOrderFindMany,
  mockOrderUpdate,
  mockTransaction,
  mockRecordAuditLog,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockAssertSameOrigin: vi.fn(),
  mockRateLimit: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockPaymentFindMany: vi.fn(),
  mockOrderFindMany: vi.fn(),
  mockOrderUpdate: vi.fn(),
  mockTransaction: vi.fn(),
  mockRecordAuditLog: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/origin", () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mockRateLimit }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: mockRecordAuditLog }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: mockUserFindUnique },
    payment: { findMany: mockPaymentFindMany },
    order: {
      findMany: mockOrderFindMany,
      update: mockOrderUpdate,
    },
    $transaction: mockTransaction,
  },
}));

import { POST } from "./route";

function makeRequest(body?: unknown) {
  return new Request("http://localhost:3000/api/admin/customers/customer-1/backfill-orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      origin: "http://localhost:3000",
      "x-request-id": "req-backfill-1",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("POST /api/admin/customers/[id]/backfill-orders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetServerSession.mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN", name: "Admin", email: "admin@example.com" },
    });
    mockAssertSameOrigin.mockReturnValue(true);
    mockRateLimit.mockResolvedValue({ ok: true });
    mockUserFindUnique.mockResolvedValue({
      id: "customer-1",
      name: "Alice Clinic",
      email: "alice@example.com",
    });
    mockPaymentFindMany.mockResolvedValue([]);
    mockTransaction.mockResolvedValue([]);
    mockOrderUpdate.mockImplementation((arg) => Promise.resolve(arg));
  });

  it("links unassigned orders from manual order ids and audits the operation", async () => {
    mockOrderFindMany.mockResolvedValue([
      { id: "order-1", invoiceNumber: "INV-1", userId: null },
      { id: "order-2", invoiceNumber: "INV-2", userId: "other-customer" },
    ]);

    const res = await POST(makeRequest({ orderIds: ["INV-1", "INV-2", "MISSING"] }), {
      params: Promise.resolve({ id: "customer-1" }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      linked: 1,
      skippedDifferentUser: 1,
      missingOrders: 1,
      linkedOrderIds: ["order-1"],
    });
    expect(mockOrderUpdate).toHaveBeenCalledWith({
      where: { id: "order-1" },
      data: { userId: "customer-1" },
    });
    expect(mockRecordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "CUSTOMER_ORDER_LINK_BACKFILL",
        entityType: "USER",
        entityId: "customer-1",
        outcome: "PARTIAL",
        meta: expect.objectContaining({
          mode: "manual",
          linkedOrderIds: ["order-1"],
          skippedDifferentUser: 1,
          missingOrders: 1,
        }),
      }),
    );
  });

  it("infers order ids from payment metadata when no manual ids are supplied", async () => {
    mockPaymentFindMany.mockResolvedValue([
      {
        orderId: null,
        note: JSON.stringify({ applied: [{ orderId: "order-9" }] }),
      },
    ]);
    mockOrderFindMany.mockResolvedValue([
      { id: "order-9", invoiceNumber: "INV-9", userId: null },
    ]);

    const res = await POST(makeRequest(), {
      params: Promise.resolve({ id: "customer-1" }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      linked: 1,
      linkedOrderIds: ["order-9"],
    });
    expect(mockRecordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({
          mode: "inferred_from_payments",
          requestedReferences: ["order-9"],
        }),
      }),
    );
  });
});
