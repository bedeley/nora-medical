import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetServerSession,
  mockAuditLogFindMany,
  mockUserFindMany,
  mockRecordAuditLog,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockAuditLogFindMany: vi.fn(),
  mockUserFindMany: vi.fn(),
  mockRecordAuditLog: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: mockRecordAuditLog }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: { findMany: mockAuditLogFindMany },
    user: { findMany: mockUserFindMany },
  },
}));

import { GET } from "./route";

function snapshot(id: string) {
  return {
    id,
    customerId: "cust-1",
    requestType: "QUOTE",
    status: "IN_REVIEW",
    clinicName: "Korle Bu Clinic",
    contactName: "Ama Buyer",
    contactPhone: null,
    contactEmail: "buyer@clinic.gh",
    notes: "Urgent",
    poDocumentUrl: null,
    templateId: null,
    itemsText: "Gloves x 10",
    accountManagerId: "mgr-1",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-02T00:00:00.000Z",
  };
}

function auditLog(id: string) {
  return {
    entityId: id,
    createdAt: new Date("2026-04-02T00:00:00.000Z"),
    meta: JSON.stringify({ snapshot: snapshot(id) }),
  };
}

describe("GET /api/admin/b2b/procurement/export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetServerSession.mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN", email: "admin@nora.gh", name: "Admin" },
    });
    mockAuditLogFindMany.mockResolvedValue([auditLog("req-1")]);
    mockUserFindMany.mockResolvedValue([
      { id: "cust-1", name: "Korle Buyer", email: "buyer@clinic.gh", role: "CUSTOMER" },
      { id: "mgr-1", name: "Ama Manager", email: "ama@nora.gh", role: "STAFF" },
    ]);
    mockRecordAuditLog.mockResolvedValue(undefined);
  });

  it("exports CSV and records scoped audit metadata", async () => {
    const res = await GET(
      new Request("http://localhost/api/admin/b2b/procurement/export?statusGroup=open&requestType=QUOTE&q=Korle"),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(mockRecordAuditLog).toHaveBeenCalledOnce();
    const call = mockRecordAuditLog.mock.calls[0][0];
    expect(call.action).toBe("B2B_PROCUREMENT_REQUEST_EXPORTED");
    expect(call.entityType).toBe("B2B_PROCUREMENT_REQUEST");
    expect(call.entityId).toBe("export");
    expect(call.outcome).toBe("SUCCESS");
    expect(call.meta.sourcePage).toBe("admin/b2b/procurement");
    expect(call.meta.filters.statusGroup).toBe("open");
    expect(call.meta.filters.requestType).toBe("QUOTE");
    expect(call.meta.filters.q).toBe("korle");
    expect(call.meta.rowCount).toBe(1);
  });
});
