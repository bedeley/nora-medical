import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockRateLimit,
  mockOrderFindFirst,
  mockSendWhatsApp,
  mockSendSms,
  mockSendEmail,
  mockRecordAuditLog,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockAssertSameOrigin: vi.fn(),
  mockRateLimit: vi.fn(),
  mockOrderFindFirst: vi.fn(),
  mockSendWhatsApp: vi.fn(),
  mockSendSms: vi.fn(),
  mockSendEmail: vi.fn(),
  mockRecordAuditLog: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/origin", () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mockRateLimit }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    order: {
      findFirst: mockOrderFindFirst,
    },
  },
}));
vi.mock("@/lib/whatsapp", () => ({ sendWhatsApp: mockSendWhatsApp }));
vi.mock("@/lib/sms", () => ({ sendSms: mockSendSms }));
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
  return new Request("http://localhost:3000/api/orders/order-1/receipt/sms", {
    method: "POST",
    headers: {
      origin: "http://localhost:3000",
      "x-request-id": "req-sms-1",
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
  mockAssertSameOrigin.mockReturnValue(true);
  mockRateLimit.mockResolvedValue({ ok: true });
  mockOrderFindFirst.mockResolvedValue({
    id: "order-1",
    userId: "customer-1",
    invoiceNumber: "INV-1001",
    subtotal: 100,
    taxRate: 15,
    taxAmount: 15,
    createdAt: new Date("2026-04-01T10:00:00.000Z"),
    user: {
      name: "Alice Clinic",
      phone: "0240000000",
      email: "alice@example.com",
    },
    items: [
      {
        quantity: 1,
        price: 115,
        product: { name: "Sterile Gloves" },
      },
    ],
    total: 115,
    amountPaid: 80,
    status: "PARTIALLY_PAID",
    receiptHash: "hash-1",
  });
  mockSendWhatsApp.mockResolvedValue({ ok: true });
  mockSendSms.mockResolvedValue({ ok: true });
  mockSendEmail.mockResolvedValue({ ok: true });
});

describe("POST /api/orders/[id]/receipt/sms", () => {
  it("audits successful WhatsApp receipt sends with admin order source metadata", async () => {
    const res = await POST(makeRequest(), {
      params: { id: "order-1" },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      channel: "whatsapp",
    });
    expect(mockRecordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ORDER_RECEIPT_SEND",
        entityType: "ORDER",
        entityId: "order-1",
        outcome: "SUCCESS",
        meta: expect.objectContaining({
          sourcePage: "/admin/orders/[id]",
          sourceRoute: "/api/orders/order-1/receipt/sms",
          channel: "whatsapp",
          recipientPhone: "0240000000",
          customerId: "customer-1",
          attemptedChannels: ["whatsapp"],
          failedChannels: [],
        }),
      }),
    );
  });
});
