import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockOrderFindUnique,
  mockSendEmail,
  mockRecordAuditLog,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockAssertSameOrigin: vi.fn(),
  mockOrderFindUnique: vi.fn(),
  mockSendEmail: vi.fn(),
  mockRecordAuditLog: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/origin", () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    order: {
      findUnique: mockOrderFindUnique,
    },
  },
}));
vi.mock("@/lib/email", () => ({ sendEmail: mockSendEmail }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: mockRecordAuditLog }));

import { POST } from "./route";

const ADMIN_SESSION = {
  user: {
    id: "admin-1",
    role: "ADMIN",
    name: "Admin User",
    email: "admin@example.com",
  },
};

function makeRequest() {
  return new Request("http://localhost:3000/api/orders/order-1/receipt/email", {
    method: "POST",
    headers: {
      origin: "http://localhost:3000",
      "Content-Type": "application/json",
      "x-request-id": "req-email-1",
    },
    body: JSON.stringify({ to: "finance@example.com" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
  mockAssertSameOrigin.mockReturnValue(true);
  mockOrderFindUnique.mockResolvedValue({
    id: "order-1",
    userId: "customer-1",
    invoiceNumber: "INV-1001",
    subtotal: 100,
    taxRate: 15,
    taxAmount: 15,
    total: 115,
    amountPaid: 80,
    status: "PARTIALLY_PAID",
    deliveryStatus: "PARTIALLY_DELIVERED",
    createdAt: new Date("2026-04-01T10:00:00.000Z"),
    items: [
      {
        quantity: 1,
        price: 115,
        product: { name: "Sterile Gloves" },
      },
    ],
    user: {
      name: "Alice Clinic",
      email: "alice@example.com",
    },
  });
  mockSendEmail.mockResolvedValue({ ok: true, simulated: false });
});

describe("POST /api/orders/[id]/receipt/email", () => {
  it("audits successful receipt emails with source-page and recipient metadata", async () => {
    const res = await POST(makeRequest(), {
      params: Promise.resolve({ id: "order-1" }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      simulated: false,
    });
    expect(mockRecordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ORDER_RECEIPT_SEND",
        entityType: "ORDER",
        entityId: "order-1",
        outcome: "SUCCESS",
        meta: expect.objectContaining({
          sourcePage: "/admin/orders/[id]",
          sourceRoute: "/api/orders/order-1/receipt/email",
          channel: "email",
          recipientEmail: "finance@example.com",
          customerId: "customer-1",
          targetProvidedInBody: true,
          simulated: false,
        }),
      }),
    );
  });
});
