import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockRateLimit,
  mockNotifyOrderEvent,
  mockRecordAuditLog,
  mockOrderFindUnique,
  mockOrderItemFindMany,
  mockOrderUpdate,
  mockTransaction,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockAssertSameOrigin: vi.fn(),
  mockRateLimit: vi.fn(),
  mockNotifyOrderEvent: vi.fn(),
  mockRecordAuditLog: vi.fn(),
  mockOrderFindUnique: vi.fn(),
  mockOrderItemFindMany: vi.fn(),
  mockOrderUpdate: vi.fn(),
  mockTransaction: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/origin", () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: mockRecordAuditLog }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mockRateLimit }));
vi.mock("@/lib/notifications", () => ({ notifyOrderEvent: mockNotifyOrderEvent }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    order: {
      findUnique: mockOrderFindUnique,
      update: mockOrderUpdate,
    },
    orderItem: {
      findMany: mockOrderItemFindMany,
    },
    journalEntry: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: mockTransaction,
    payment: { findMany: vi.fn().mockResolvedValue([]) },
    auditLog: { findFirst: vi.fn().mockResolvedValue(null) },
  },
}));

import { DELETE, PATCH } from "./route";

const ADMIN_SESSION = {
  user: { id: "admin-1", role: "ADMIN", email: "admin@example.com" },
};

function makePatchRequest(body: unknown) {
  return new Request("http://localhost:3000/api/orders/order-1", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      origin: "http://localhost:3000",
    },
    body: JSON.stringify(body),
  });
}

function makeDeleteRequest() {
  return new Request("http://localhost:3000/api/orders/order-1", {
    method: "DELETE",
    headers: {
      origin: "http://localhost:3000",
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
  mockAssertSameOrigin.mockReturnValue(true);
  mockRateLimit.mockResolvedValue({ ok: true });
  mockTransaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
    callback({
      order: { findUnique: vi.fn(), update: vi.fn() },
      orderItem: { findMany: vi.fn(), update: vi.fn() },
      product: { update: vi.fn() },
      inventoryMovement: { create: vi.fn() },
    }),
  );
});

describe("PATCH /api/orders/[id]", () => {
  it("audits note-only updates with source-page metadata", async () => {
    mockOrderFindUnique.mockResolvedValue({
      id: "order-1",
      status: "PARTIALLY_PAID",
      total: 100,
      amountPaid: 20,
      balance: 80,
      deliveryStatus: "PARTIALLY_DELIVERED",
      adminNote: "Call first",
      userId: "customer-1",
    });
    mockOrderUpdate.mockResolvedValue({ id: "order-1" });

    const res = await PATCH(
      makePatchRequest({ adminNote: "Customer requested afternoon call" }),
      { params: Promise.resolve({ id: "order-1" }) },
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ success: true });
    expect(mockRecordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ORDER_NOTE_UPDATED",
        entityType: "ORDER",
        entityId: "order-1",
        meta: expect.objectContaining({
          sourcePage: "/admin/orders/[id]",
          sourceRoute: "/api/orders/order-1",
          previousStatus: "PARTIALLY_PAID",
          deliveryStatus: "PARTIALLY_DELIVERED",
          previousNote: "Call first",
          newNote: "Customer requested afternoon call",
        }),
      }),
    );
  });

  it("rejects direct RETURNED delivery updates", async () => {
    const res = await PATCH(
      makePatchRequest({ deliveryStatus: "RETURNED" }),
      { params: Promise.resolve({ id: "order-1" }) },
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "Invalid update payload",
    });
  });

  it("blocks cancellation while delivered units remain outstanding", async () => {
    mockOrderFindUnique.mockResolvedValue({
      id: "order-1",
      status: "PARTIALLY_PAID",
      total: 100,
      amountPaid: 20,
      balance: 80,
      deliveryStatus: "DELIVERED",
      userId: "customer-1",
    });
    mockOrderItemFindMany.mockResolvedValue([
      {
        id: "item-1",
        quantity: 2,
        deliveredQuantity: 2,
        returnedQuantity: 1,
        product: { name: "Sterile Gloves" },
      },
    ]);

    const res = await PATCH(
      makePatchRequest({ status: "CANCELLED", cancelReason: "Customer requested cancellation" }),
      { params: Promise.resolve({ id: "order-1" }) },
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "Process returns for all delivered units before cancelling this order.",
    });
  });
});

describe("DELETE /api/orders/[id]", () => {
  it("rejects deletion when the order has delivery history", async () => {
    mockOrderFindUnique.mockResolvedValue({
      id: "order-1",
      amountPaid: 0,
      deliveryStatus: "RETURNED",
    });

    const res = await DELETE(makeDeleteRequest(), {
      params: Promise.resolve({ id: "order-1" }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "Only undelivered, unpaid orders can be deleted",
    });
    expect(mockOrderUpdate).not.toHaveBeenCalled();
  });
});
