import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockRateLimit,
  mockAuditLogFindFirst,
  mockUserFindUnique,
  mockRecordAuditLog,
  mockNotifyAssigned,
  mockNotifyStatusUpdated,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockAssertSameOrigin: vi.fn(),
  mockRateLimit: vi.fn(),
  mockAuditLogFindFirst: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockRecordAuditLog: vi.fn(),
  mockNotifyAssigned: vi.fn(),
  mockNotifyStatusUpdated: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/origin", () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mockRateLimit }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: mockRecordAuditLog }));
vi.mock("@/lib/b2b-procurement-notifications", () => ({
  notifyCustomerProcurementAssigned: mockNotifyAssigned,
  notifyCustomerProcurementStatusUpdated: mockNotifyStatusUpdated,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: { findFirst: mockAuditLogFindFirst },
    user: { findUnique: mockUserFindUnique },
  },
}));

import { POST } from "./route";

const ADMIN_SESSION = { user: { id: "u1", role: "ADMIN" } };
const CUSTOMER_SESSION = { user: { id: "u4", role: "CUSTOMER" } };
type AuditCall = [{
  action: string;
  entityId: string;
  meta: Record<string, unknown>;
  outcome?: string;
}];

function makeSnapshot(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    customerId: "cust-1",
    requestType: "QUOTE",
    status: "IN_REVIEW",
    clinicName: `Clinic ${id}`,
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

function makeAuditEntry(id: string, overrides: Record<string, unknown> = {}) {
  return { meta: JSON.stringify({ snapshot: makeSnapshot(id, overrides) }) };
}

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/admin/b2b/procurement/bulk", {
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
  mockNotifyAssigned.mockResolvedValue({ ok: true, channel: "email", attempted: true });
  mockNotifyStatusUpdated.mockResolvedValue({ ok: true, channel: "email", attempted: true });
  mockUserFindUnique.mockResolvedValue({ id: "mgr-1", name: "Ama Owusu", email: "ama@nora.gh", role: "STAFF" });
  mockAuditLogFindFirst.mockImplementation(({ where }: { where: { entityId: string } }) =>
    Promise.resolve(makeAuditEntry(where.entityId)),
  );
});

describe("POST /bulk — auth", () => {
  it("rejects unauthenticated", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await POST(makeRequest({ action: "assign", ids: ["req-1"], accountManagerId: "mgr-1" }));
    expect(res.status).toBe(401);
  });

  it("rejects CUSTOMER role", async () => {
    mockGetServerSession.mockResolvedValue(CUSTOMER_SESSION);
    const res = await POST(makeRequest({ action: "assign", ids: ["req-1"], accountManagerId: "mgr-1" }));
    expect(res.status).toBe(401);
  });
});

describe("POST /bulk — validation", () => {
  it("rejects empty ids array", async () => {
    const res = await POST(makeRequest({ action: "assign", ids: [], accountManagerId: "mgr-1" }));
    expect(res.status).toBe(400);
  });

  it("rejects invalid action", async () => {
    const res = await POST(makeRequest({ action: "delete", ids: ["req-1"] }));
    expect(res.status).toBe(400);
  });

  it("rejects assign action without accountManagerId", async () => {
    const res = await POST(makeRequest({ action: "assign", ids: ["req-1"] }));
    expect(res.status).toBe(400);
  });

  it("rejects status action without status", async () => {
    const res = await POST(makeRequest({ action: "status", ids: ["req-1"] }));
    expect(res.status).toBe(400);
  });

  it("rejects more than 100 ids", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `req-${i}`);
    const res = await POST(makeRequest({ action: "assign", ids, accountManagerId: "mgr-1" }));
    expect(res.status).toBe(400);
  });
});

describe("POST /bulk — assign action", () => {
  it("assigns manager to multiple requests", async () => {
    const res = await POST(
      makeRequest({ action: "assign", ids: ["req-1", "req-2"], accountManagerId: "mgr-1" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.successCount).toBe(2);
    expect(body.failCount).toBe(0);
  });

  it("skips terminal requests and counts as failures", async () => {
    mockAuditLogFindFirst.mockImplementation(({ where }: { where: { entityId: string } }) => {
      if (where.entityId === "req-rejected") {
        return Promise.resolve(makeAuditEntry("req-rejected", { status: "REJECTED" }));
      }
      return Promise.resolve(makeAuditEntry(where.entityId));
    });
    const res = await POST(
      makeRequest({ action: "assign", ids: ["req-1", "req-rejected"], accountManagerId: "mgr-1" }),
    );
    const body = await res.json();
    expect(body.successCount).toBe(1);
    expect(body.failCount).toBe(1);
    const rejected = body.results.find((r: { id: string }) => r.id === "req-rejected");
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toMatch(/REJECTED/);
  });

  it("returns 404 when manager not found", async () => {
    mockUserFindUnique.mockResolvedValue(null);
    const res = await POST(
      makeRequest({ action: "assign", ids: ["req-1"], accountManagerId: "nonexistent" }),
    );
    expect(res.status).toBe(404);
  });

  it("sets autoPromoted=true for SUBMITTED requests", async () => {
    mockAuditLogFindFirst.mockResolvedValue(makeAuditEntry("req-1", { status: "SUBMITTED", accountManagerId: null }));
    const res = await POST(makeRequest({ action: "assign", ids: ["req-1"], accountManagerId: "mgr-1" }));
    const body = await res.json();
    expect(body.results[0].autoPromoted).toBe(true);
  });
});

describe("POST /bulk — status action", () => {
  it("updates status for multiple requests", async () => {
    const res = await POST(
      makeRequest({ action: "status", ids: ["req-1", "req-2"], status: "QUOTED" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.successCount).toBe(2);
    expect(body.failCount).toBe(0);
  });

  it("blocks IN_REVIEW on QUOTED/APPROVED requests", async () => {
    mockAuditLogFindFirst.mockResolvedValue(makeAuditEntry("req-1", { status: "QUOTED" }));
    const res = await POST(makeRequest({ action: "status", ids: ["req-1"], status: "IN_REVIEW" }));
    const body = await res.json();
    expect(body.failCount).toBe(1);
    expect(body.results[0].error).toMatch(/IN_REVIEW/);
  });

  it("blocks QUOTED when no manager assigned", async () => {
    mockAuditLogFindFirst.mockResolvedValue(makeAuditEntry("req-1", { status: "IN_REVIEW", accountManagerId: null }));
    const res = await POST(makeRequest({ action: "status", ids: ["req-1"], status: "QUOTED" }));
    const body = await res.json();
    expect(body.failCount).toBe(1);
    expect(body.results[0].error).toMatch(/manager/i);
  });
});

describe("POST /bulk — audit logging", () => {
  it("writes per-request audit logs for assign", async () => {
    await POST(makeRequest({ action: "assign", ids: ["req-1", "req-2"], accountManagerId: "mgr-1" }));
    // 2 per-item logs + 1 summary log = 3 total calls
    expect(mockRecordAuditLog).toHaveBeenCalledTimes(3);
    const auditCalls = mockRecordAuditLog.mock.calls as AuditCall[];
    const itemCalls = auditCalls.filter(
      ([call]) => call.action === "B2B_PROCUREMENT_REQUEST_ASSIGNED" && call.entityId !== "bulk",
    );
    expect(itemCalls).toHaveLength(2);
    expect(itemCalls[0][0].meta.sourcePage).toBe("admin/b2b/procurement");
    expect(itemCalls[0][0].meta.operation).toBe("bulk_assign_manager");
  });

  it("writes summary audit log with correct counts", async () => {
    mockAuditLogFindFirst.mockImplementation(({ where }: { where: { entityId: string } }) => {
      if (where.entityId === "req-bad") return Promise.resolve(makeAuditEntry("req-bad", { status: "REJECTED" }));
      return Promise.resolve(makeAuditEntry(where.entityId));
    });
    await POST(makeRequest({ action: "assign", ids: ["req-1", "req-bad"], accountManagerId: "mgr-1" }));
    const auditCalls = mockRecordAuditLog.mock.calls as AuditCall[];
    const summaryCall = auditCalls.find(([call]) => call.entityId === "bulk");
    expect(summaryCall).toBeDefined();
    expect(summaryCall?.[0].meta.successCount).toBe(1);
    expect(summaryCall?.[0].meta.failCount).toBe(1);
    expect(summaryCall?.[0].outcome).toBe("PARTIAL");
  });
});
