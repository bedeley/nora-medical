import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetServerSession,
  mockAuditLogFindMany,
  mockUserFindMany,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockAuditLogFindMany: vi.fn(),
  mockUserFindMany: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: { findMany: mockAuditLogFindMany },
    user: { findMany: mockUserFindMany },
  },
}));

import { GET } from "./route";

const ADMIN_SESSION = { user: { id: "u1", role: "ADMIN" } };
const STAFF_SESSION = { user: { id: "u2", role: "STAFF" } };
const ACCOUNTANT_SESSION = { user: { id: "u3", role: "ACCOUNTANT" } };
const CUSTOMER_SESSION = { user: { id: "u4", role: "CUSTOMER" } };

function makeSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    customerId: "cust-1",
    requestType: "QUOTE",
    status: "SUBMITTED",
    clinicName: "Accra Medical Centre",
    contactName: "Kofi Mensah",
    contactPhone: "+233501234567",
    contactEmail: "kofi@accramedical.gh",
    notes: null,
    poDocumentUrl: null,
    templateId: null,
    itemsText: null,
    accountManagerId: null,
    createdAt: new Date("2026-01-01T10:00:00Z").toISOString(),
    updatedAt: new Date("2026-01-01T10:00:00Z").toISOString(),
    ...overrides,
  };
}

function makeAuditLog(entityId: string, status: string, overrides: Record<string, unknown> = {}) {
  return {
    entityId,
    action: "B2B_PROCUREMENT_REQUEST_CREATED",
    meta: JSON.stringify({ snapshot: makeSnapshot({ id: entityId, status, ...overrides }) }),
  };
}

function makeRequest(url: string) {
  return new Request(`http://localhost${url}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
  mockAuditLogFindMany.mockResolvedValue([]);
  mockUserFindMany.mockResolvedValue([]);
});

describe("GET /api/admin/b2b/procurement/requests — auth", () => {
  it("rejects unauthenticated requests", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await GET(makeRequest("/api/admin/b2b/procurement/requests?statusGroup=open"));
    expect(res.status).toBe(401);
  });

  it("rejects CUSTOMER role", async () => {
    mockGetServerSession.mockResolvedValue(CUSTOMER_SESSION);
    const res = await GET(makeRequest("/api/admin/b2b/procurement/requests?statusGroup=open"));
    expect(res.status).toBe(401);
  });

  it("allows ADMIN role", async () => {
    const res = await GET(makeRequest("/api/admin/b2b/procurement/requests?statusGroup=open"));
    expect(res.status).toBe(200);
  });

  it("allows STAFF role", async () => {
    mockGetServerSession.mockResolvedValue(STAFF_SESSION);
    const res = await GET(makeRequest("/api/admin/b2b/procurement/requests?statusGroup=open"));
    expect(res.status).toBe(200);
  });

  it("allows ACCOUNTANT role", async () => {
    mockGetServerSession.mockResolvedValue(ACCOUNTANT_SESSION);
    const res = await GET(makeRequest("/api/admin/b2b/procurement/requests?statusGroup=open"));
    expect(res.status).toBe(200);
  });
});

describe("GET /api/admin/b2b/procurement/requests — statusGroup filtering", () => {
  beforeEach(() => {
    mockAuditLogFindMany.mockResolvedValue([
      makeAuditLog("req-open", "IN_REVIEW"),
      makeAuditLog("req-submitted", "SUBMITTED"),
      makeAuditLog("req-closed", "CLOSED", {
        updatedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(), // 60 days ago
      }),
      makeAuditLog("req-rejected", "REJECTED", {
        updatedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(), // 5 days ago — not archived
      }),
    ]);
  });

  it("open queue returns only open statuses that are not archived", async () => {
    const res = await GET(makeRequest("/api/admin/b2b/procurement/requests?statusGroup=open&archiveAfterDays=30"));
    const body = await res.json();
    const ids = body.items.map((r: { id: string }) => r.id);
    expect(ids).toContain("req-open");
    expect(ids).toContain("req-submitted");
    expect(ids).not.toContain("req-closed"); // terminal
    expect(ids).not.toContain("req-rejected");
  });

  it("closed queue returns terminal non-archived items", async () => {
    const res = await GET(makeRequest("/api/admin/b2b/procurement/requests?statusGroup=closed&archiveAfterDays=30"));
    const body = await res.json();
    const ids = body.items.map((r: { id: string }) => r.id);
    expect(ids).toContain("req-rejected");
    expect(ids).not.toContain("req-open");
    expect(ids).not.toContain("req-closed"); // archived (60 days > 30 day threshold)
  });

  it("archived queue returns only auto-archived items", async () => {
    const res = await GET(makeRequest("/api/admin/b2b/procurement/requests?statusGroup=archived&archiveAfterDays=30"));
    const body = await res.json();
    const ids = body.items.map((r: { id: string }) => r.id);
    expect(ids).toContain("req-closed");
    expect(ids).not.toContain("req-open");
  });

  it("all queue returns everything", async () => {
    const res = await GET(makeRequest("/api/admin/b2b/procurement/requests?statusGroup=all&archiveAfterDays=30"));
    const body = await res.json();
    expect(body.items.length).toBe(4);
  });
});

describe("GET /api/admin/b2b/procurement/requests — new filters", () => {
  beforeEach(() => {
    mockAuditLogFindMany.mockResolvedValue([
      makeAuditLog("req-quote", "SUBMITTED", { requestType: "QUOTE", accountManagerId: "mgr-1" }),
      makeAuditLog("req-po", "IN_REVIEW", { requestType: "PO_UPLOAD", accountManagerId: null }),
      makeAuditLog("req-reorder", "QUOTED", { requestType: "RECURRING_REORDER", accountManagerId: "mgr-2" }),
    ]);
    mockUserFindMany.mockResolvedValue([]);
  });

  it("filters by requestType", async () => {
    const res = await GET(makeRequest("/api/admin/b2b/procurement/requests?statusGroup=all&requestType=PO_UPLOAD"));
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe("req-po");
  });

  it("filters by assignedManagerId (specific manager)", async () => {
    const res = await GET(makeRequest("/api/admin/b2b/procurement/requests?statusGroup=all&assignedManagerId=mgr-1"));
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe("req-quote");
  });

  it("filters by assignedManagerId=__unassigned__", async () => {
    const res = await GET(makeRequest("/api/admin/b2b/procurement/requests?statusGroup=all&assignedManagerId=__unassigned__"));
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe("req-po");
  });

  it("filters by date range (start)", async () => {
    // req-quote createdAt is 2026-01-01, req-po is now
    mockAuditLogFindMany.mockResolvedValue([
      makeAuditLog("req-old", "SUBMITTED", { createdAt: "2025-01-01T00:00:00Z" }),
      makeAuditLog("req-new", "SUBMITTED", { createdAt: "2026-06-01T00:00:00Z" }),
    ]);
    const res = await GET(makeRequest("/api/admin/b2b/procurement/requests?statusGroup=all&start=2026-01-01"));
    const body = await res.json();
    const ids = body.items.map((r: { id: string }) => r.id);
    expect(ids).toContain("req-new");
    expect(ids).not.toContain("req-old");
  });

  it("returns managerOptions in response", async () => {
    mockAuditLogFindMany.mockResolvedValue([
      makeAuditLog("req-1", "QUOTED", { accountManagerId: "mgr-1" }),
    ]);
    mockUserFindMany.mockResolvedValue([
      { id: "mgr-1", name: "Ama Owusu", email: "ama@nora.gh", role: "STAFF" },
    ]);
    const res = await GET(makeRequest("/api/admin/b2b/procurement/requests?statusGroup=all"));
    const body = await res.json();
    expect(body.managerOptions).toBeDefined();
  });
});

describe("GET /api/admin/b2b/procurement/requests — pagination", () => {
  it("paginates correctly", async () => {
    const logs = Array.from({ length: 30 }, (_, i) =>
      makeAuditLog(`req-${i}`, "SUBMITTED", { id: `req-${i}` }),
    );
    mockAuditLogFindMany.mockResolvedValue(logs);
    const res = await GET(makeRequest("/api/admin/b2b/procurement/requests?statusGroup=open&page=2&pageSize=10"));
    const body = await res.json();
    expect(body.items).toHaveLength(10);
    expect(body.page).toBe(2);
    expect(body.totalPages).toBe(3);
    expect(body.total).toBe(30);
  });
});

describe("GET /api/admin/b2b/procurement/requests — search", () => {
  it("filters by clinic name search", async () => {
    mockAuditLogFindMany.mockResolvedValue([
      makeAuditLog("req-a", "SUBMITTED", { clinicName: "Kumasi Clinic" }),
      makeAuditLog("req-b", "SUBMITTED", { clinicName: "Accra Hospital" }),
    ]);
    const res = await GET(makeRequest("/api/admin/b2b/procurement/requests?statusGroup=all&q=kumasi"));
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe("req-a");
  });
});
