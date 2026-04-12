import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockRateLimit,
  mockAuditLogFindFirst,
  mockUserFindUnique,
  mockRecordAuditLog,
  mockNotifyCustomerProcurementAssigned,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockAssertSameOrigin: vi.fn(),
  mockRateLimit: vi.fn(),
  mockAuditLogFindFirst: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockRecordAuditLog: vi.fn(),
  mockNotifyCustomerProcurementAssigned: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/origin", () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mockRateLimit }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: mockRecordAuditLog }));
vi.mock("@/lib/b2b-procurement-notifications", () => ({
  notifyCustomerProcurementAssigned: mockNotifyCustomerProcurementAssigned,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: { findFirst: mockAuditLogFindFirst },
    user: { findUnique: mockUserFindUnique },
  },
}));

import { POST } from "./route";

const ADMIN_SESSION = { user: { id: "u1", role: "ADMIN" } };
const STAFF_SESSION = { user: { id: "u2", role: "STAFF" } };
const ACCOUNTANT_SESSION = { user: { id: "u3", role: "ACCOUNTANT" } };

function makeSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    customerId: "cust-1",
    requestType: "QUOTE",
    status: "SUBMITTED",
    clinicName: "Test Clinic",
    contactName: "Kofi",
    contactPhone: null,
    contactEmail: null,
    notes: null,
    poDocumentUrl: null,
    templateId: null,
    itemsText: null,
    accountManagerId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeAuditLogEntry(snapshot: Record<string, unknown>) {
  return { meta: JSON.stringify({ snapshot }) };
}

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/admin/b2b/procurement/requests/req-1/assign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
  mockAssertSameOrigin.mockReturnValue(true);
  mockRateLimit.mockResolvedValue({ ok: true });
  mockRecordAuditLog.mockResolvedValue(undefined);
  mockNotifyCustomerProcurementAssigned.mockResolvedValue({ ok: true, channel: "email", attempted: true });
  mockUserFindUnique.mockResolvedValue({ id: "mgr-1", name: "Ama Owusu", email: "ama@nora.gh", role: "STAFF" });
  mockAuditLogFindFirst.mockResolvedValue(makeAuditLogEntry(makeSnapshot()));
});

describe("POST /assign — auth", () => {
  it("rejects unauthenticated", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await POST(makeRequest({ accountManagerId: "mgr-1" }), { params: { id: "req-1" } });
    expect(res.status).toBe(401);
  });

  it("rejects ACCOUNTANT role", async () => {
    mockGetServerSession.mockResolvedValue(ACCOUNTANT_SESSION);
    const res = await POST(makeRequest({ accountManagerId: "mgr-1" }), { params: { id: "req-1" } });
    expect(res.status).toBe(401);
  });

  it("allows STAFF role", async () => {
    mockGetServerSession.mockResolvedValue(STAFF_SESSION);
    const res = await POST(makeRequest({ accountManagerId: "mgr-1" }), { params: { id: "req-1" } });
    expect(res.status).toBe(200);
  });
});

describe("POST /assign — validation", () => {
  it("returns 400 for missing accountManagerId", async () => {
    const res = await POST(makeRequest({}), { params: { id: "req-1" } });
    expect(res.status).toBe(400);
  });

  it("returns 404 when request not found", async () => {
    mockAuditLogFindFirst.mockResolvedValue(null);
    const res = await POST(makeRequest({ accountManagerId: "mgr-1" }), { params: { id: "req-999" } });
    expect(res.status).toBe(404);
  });

  it("returns 404 when manager not found", async () => {
    mockUserFindUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      if (where.id === "mgr-1") return Promise.resolve(null); // manager not found
      return Promise.resolve({ id: "u1", name: "Actor", email: "actor@nora.gh" });
    });
    const res = await POST(makeRequest({ accountManagerId: "mgr-1" }), { params: { id: "req-1" } });
    expect(res.status).toBe(404);
  });

  it("rejects assignment on REJECTED request", async () => {
    mockAuditLogFindFirst.mockResolvedValue(makeAuditLogEntry(makeSnapshot({ status: "REJECTED" })));
    const res = await POST(makeRequest({ accountManagerId: "mgr-1" }), { params: { id: "req-1" } });
    expect(res.status).toBe(409);
  });

  it("rejects assignment on CLOSED request", async () => {
    mockAuditLogFindFirst.mockResolvedValue(makeAuditLogEntry(makeSnapshot({ status: "CLOSED" })));
    const res = await POST(makeRequest({ accountManagerId: "mgr-1" }), { params: { id: "req-1" } });
    expect(res.status).toBe(409);
  });
});

describe("POST /assign — auto-promotion", () => {
  it("auto-promotes SUBMITTED to IN_REVIEW and signals autoPromoted=true", async () => {
    mockAuditLogFindFirst.mockResolvedValue(makeAuditLogEntry(makeSnapshot({ status: "SUBMITTED" })));
    const res = await POST(makeRequest({ accountManagerId: "mgr-1" }), { params: { id: "req-1" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.autoPromoted).toBe(true);
    expect(body.previousStatus).toBe("SUBMITTED");
    expect(body.snapshot.status).toBe("IN_REVIEW");
  });

  it("does NOT auto-promote when already IN_REVIEW", async () => {
    mockAuditLogFindFirst.mockResolvedValue(makeAuditLogEntry(makeSnapshot({ status: "IN_REVIEW" })));
    const res = await POST(makeRequest({ accountManagerId: "mgr-1" }), { params: { id: "req-1" } });
    const body = await res.json();
    expect(body.autoPromoted).toBe(false);
    expect(body.snapshot.status).toBe("IN_REVIEW");
  });
});

describe("POST /assign — audit logging", () => {
  it("calls recordAuditLog with correct metadata on success", async () => {
    await POST(makeRequest({ accountManagerId: "mgr-1", note: "Assigning Ama" }), { params: { id: "req-1" } });
    expect(mockRecordAuditLog).toHaveBeenCalledOnce();
    const call = mockRecordAuditLog.mock.calls[0][0];
    expect(call.action).toBe("B2B_PROCUREMENT_REQUEST_ASSIGNED");
    expect(call.entityType).toBe("B2B_PROCUREMENT_REQUEST");
    expect(call.entityId).toBe("req-1");
    expect(call.outcome).toBe("SUCCESS");
    expect(call.meta.sourcePage).toBe("admin/b2b/procurement");
    expect(call.meta.after.accountManagerId).toBe("mgr-1");
    expect(call.meta.note).toBe("Assigning Ama");
    expect(call.meta.notification).toBeDefined();
  });

  it("includes autoPromoted in audit meta", async () => {
    mockAuditLogFindFirst.mockResolvedValue(makeAuditLogEntry(makeSnapshot({ status: "SUBMITTED" })));
    await POST(makeRequest({ accountManagerId: "mgr-1" }), { params: { id: "req-1" } });
    const call = mockRecordAuditLog.mock.calls[0][0];
    expect(call.meta.autoPromoted).toBe(true);
  });
});

describe("POST /assign — notification handling", () => {
  it("still succeeds when notification throws", async () => {
    mockNotifyCustomerProcurementAssigned.mockRejectedValue(new Error("SMTP down"));
    const res = await POST(makeRequest({ accountManagerId: "mgr-1" }), { params: { id: "req-1" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.notification.ok).toBe(false);
    expect(body.notification.detail).toContain("SMTP down");
  });
});
