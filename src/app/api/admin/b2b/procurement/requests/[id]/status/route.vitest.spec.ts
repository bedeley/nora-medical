import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockRateLimit,
  mockAuditLogFindFirst,
  mockUserFindUnique,
  mockRecordAuditLog,
  mockNotifyCustomerProcurementStatusUpdated,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockAssertSameOrigin: vi.fn(),
  mockRateLimit: vi.fn(),
  mockAuditLogFindFirst: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockRecordAuditLog: vi.fn(),
  mockNotifyCustomerProcurementStatusUpdated: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/origin", () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mockRateLimit }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: mockRecordAuditLog }));
vi.mock("@/lib/b2b-procurement-notifications", () => ({
  notifyCustomerProcurementStatusUpdated: mockNotifyCustomerProcurementStatusUpdated,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: { findFirst: mockAuditLogFindFirst },
    user: { findUnique: mockUserFindUnique },
  },
}));

import { POST } from "./route";

const ADMIN_SESSION = { user: { id: "u1", role: "ADMIN" } };

function makeSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    customerId: "cust-1",
    requestType: "QUOTE",
    status: "IN_REVIEW",
    clinicName: "Test Clinic",
    contactName: "Kofi",
    contactPhone: null,
    contactEmail: null,
    notes: null,
    poDocumentUrl: null,
    templateId: null,
    itemsText: null,
    accountManagerId: "mgr-1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeAuditLogEntry(snapshot: Record<string, unknown>) {
  return { meta: JSON.stringify({ snapshot }) };
}

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/admin/b2b/procurement/requests/req-1/status", {
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
  mockNotifyCustomerProcurementStatusUpdated.mockResolvedValue({ ok: true, channel: "email", attempted: true });
  mockUserFindUnique.mockResolvedValue({ id: "u1", name: "Admin", email: "admin@nora.gh" });
  mockAuditLogFindFirst.mockResolvedValue(makeAuditLogEntry(makeSnapshot()));
});

describe("POST /status — schema validation", () => {
  it("rejects invalid status (SUBMITTED not allowed as target)", async () => {
    const res = await POST(makeRequest({ status: "SUBMITTED" }), { params: { id: "req-1" } });
    expect(res.status).toBe(400);
  });

  it("accepts IN_REVIEW as valid status", async () => {
    // IN_REVIEW allowed from SUBMITTED
    mockAuditLogFindFirst.mockResolvedValue(makeAuditLogEntry(makeSnapshot({ status: "SUBMITTED", accountManagerId: "mgr-1" })));
    const res = await POST(makeRequest({ status: "IN_REVIEW" }), { params: { id: "req-1" } });
    expect(res.status).toBe(200);
  });

  it("rejects missing status field", async () => {
    const res = await POST(makeRequest({}), { params: { id: "req-1" } });
    expect(res.status).toBe(400);
  });
});

describe("POST /status — business rules", () => {
  it("rejects downgrading QUOTED to IN_REVIEW", async () => {
    mockAuditLogFindFirst.mockResolvedValue(makeAuditLogEntry(makeSnapshot({ status: "QUOTED" })));
    const res = await POST(makeRequest({ status: "IN_REVIEW" }), { params: { id: "req-1" } });
    expect(res.status).toBe(409);
  });

  it("rejects downgrading APPROVED to IN_REVIEW", async () => {
    mockAuditLogFindFirst.mockResolvedValue(makeAuditLogEntry(makeSnapshot({ status: "APPROVED" })));
    const res = await POST(makeRequest({ status: "IN_REVIEW" }), { params: { id: "req-1" } });
    expect(res.status).toBe(409);
  });

  it("rejects QUOTED without an account manager", async () => {
    mockAuditLogFindFirst.mockResolvedValue(makeAuditLogEntry(makeSnapshot({ status: "IN_REVIEW", accountManagerId: null })));
    const res = await POST(makeRequest({ status: "QUOTED" }), { params: { id: "req-1" } });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/account manager/i);
  });

  it("rejects APPROVED without an account manager", async () => {
    mockAuditLogFindFirst.mockResolvedValue(makeAuditLogEntry(makeSnapshot({ status: "IN_REVIEW", accountManagerId: null })));
    const res = await POST(makeRequest({ status: "APPROVED" }), { params: { id: "req-1" } });
    expect(res.status).toBe(409);
  });

  it("rejects status update on terminal request without reopen flag", async () => {
    mockAuditLogFindFirst.mockResolvedValue(makeAuditLogEntry(makeSnapshot({ status: "REJECTED" })));
    const res = await POST(makeRequest({ status: "QUOTED" }), { params: { id: "req-1" } });
    expect(res.status).toBe(409);
  });
});

describe("POST /status — reopen flow", () => {
  it("allows reopen from REJECTED with note and reopen flag", async () => {
    mockAuditLogFindFirst.mockResolvedValue(makeAuditLogEntry(makeSnapshot({ status: "REJECTED" })));
    const res = await POST(
      makeRequest({ status: "IN_REVIEW", reopen: true, note: "Customer revised scope" }),
      { params: { id: "req-1" } },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.snapshot.status).toBe("IN_REVIEW");
  });

  it("rejects reopen without a note", async () => {
    mockAuditLogFindFirst.mockResolvedValue(makeAuditLogEntry(makeSnapshot({ status: "REJECTED" })));
    const res = await POST(
      makeRequest({ status: "IN_REVIEW", reopen: true }),
      { params: { id: "req-1" } },
    );
    expect(res.status).toBe(400);
  });

  it("rejects reopen with empty note", async () => {
    mockAuditLogFindFirst.mockResolvedValue(makeAuditLogEntry(makeSnapshot({ status: "CLOSED" })));
    const res = await POST(
      makeRequest({ status: "IN_REVIEW", reopen: true, note: "   " }),
      { params: { id: "req-1" } },
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /status — audit logging", () => {
  it("logs with correct metadata and sourcePage", async () => {
    await POST(makeRequest({ status: "QUOTED", note: "Ready to quote" }), { params: { id: "req-1" } });
    expect(mockRecordAuditLog).toHaveBeenCalledOnce();
    const call = mockRecordAuditLog.mock.calls[0][0];
    expect(call.action).toBe("B2B_PROCUREMENT_REQUEST_STATUS_UPDATED");
    expect(call.entityType).toBe("B2B_PROCUREMENT_REQUEST");
    expect(call.entityId).toBe("req-1");
    expect(call.outcome).toBe("SUCCESS");
    expect(call.meta.sourcePage).toBe("admin/b2b/procurement");
    expect(call.meta.before.status).toBe("IN_REVIEW");
    expect(call.meta.after.status).toBe("QUOTED");
    expect(call.meta.note).toBe("Ready to quote");
    expect(call.meta.isReopen).toBe(false);
  });

  it("logs operation=reopen_request when reopening", async () => {
    mockAuditLogFindFirst.mockResolvedValue(makeAuditLogEntry(makeSnapshot({ status: "REJECTED" })));
    await POST(
      makeRequest({ status: "IN_REVIEW", reopen: true, note: "Reopening" }),
      { params: { id: "req-1" } },
    );
    const call = mockRecordAuditLog.mock.calls[0][0];
    expect(call.meta.operation).toBe("reopen_request");
    expect(call.meta.isReopen).toBe(true);
  });
});

describe("POST /status — notification handling", () => {
  it("succeeds even when notification throws", async () => {
    mockNotifyCustomerProcurementStatusUpdated.mockRejectedValue(new Error("Email error"));
    const res = await POST(makeRequest({ status: "APPROVED" }), { params: { id: "req-1" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.notification.ok).toBe(false);
  });
});
