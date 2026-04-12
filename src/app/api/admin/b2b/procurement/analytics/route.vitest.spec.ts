import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetServerSession,
  mockAuditLogFindMany,
  mockAuditLogCreate,
  mockUserFindMany,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockAuditLogFindMany: vi.fn(),
  mockAuditLogCreate: vi.fn(),
  mockUserFindMany: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: {
      findMany: mockAuditLogFindMany,
      create: mockAuditLogCreate,
    },
    user: { findMany: mockUserFindMany },
  },
}));

import { GET } from "./route";

const ADMIN_SESSION = { user: { id: "u1", role: "ADMIN", email: "admin@nora.gh", name: "Admin" } };
const STAFF_SESSION = { user: { id: "u2", role: "STAFF", email: "staff@nora.gh", name: "Staff" } };
const CUSTOMER_SESSION = { user: { id: "u4", role: "CUSTOMER" } };

// ── Log factory helpers ──────────────────────────────────────────────────────

function baseSnapshot(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    customerId: "cust-1",
    requestType: "QUOTE",
    status: "SUBMITTED",
    clinicName: `Clinic ${id}`,
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

function makeCreatedLog(
  entityId: string,
  snapshot: Record<string, unknown>,
  createdAt = new Date(),
) {
  return {
    entityId,
    action: "B2B_PROCUREMENT_REQUEST_CREATED",
    createdAt,
    meta: JSON.stringify({ snapshot }),
  };
}

function makeAssignLog(
  entityId: string,
  managerId = "mgr-1",
  createdAt = new Date(),
) {
  return {
    entityId,
    action: "B2B_PROCUREMENT_REQUEST_ASSIGNED",
    createdAt,
    meta: JSON.stringify({
      snapshot: {
        id: entityId,
        status: "IN_REVIEW",
        accountManagerId: managerId,
        requestType: "QUOTE",
        clinicName: `Clinic ${entityId}`,
        createdAt: new Date().toISOString(),
      },
    }),
  };
}

function makeDraftLog(entityId: string, createdAt = new Date()) {
  return {
    entityId,
    action: "B2B_PROCUREMENT_REQUEST_DRAFT_ORDER_PREPARED",
    createdAt,
    meta: JSON.stringify({ snapshot: baseSnapshot(entityId) }),
  };
}

function makeRequest(url = "http://localhost/api/admin/b2b/procurement/analytics") {
  return new Request(url);
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
  mockAuditLogFindMany.mockResolvedValue([]);
  mockAuditLogCreate.mockResolvedValue({ id: "log-1" });
  mockUserFindMany.mockResolvedValue([]);
});

// ── Auth ─────────────────────────────────────────────────────────────────────

describe("GET /analytics — auth", () => {
  it("rejects unauthenticated requests", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it("rejects CUSTOMER role", async () => {
    mockGetServerSession.mockResolvedValue(CUSTOMER_SESSION);
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it("allows ADMIN, STAFF, ACCOUNTANT roles", async () => {
    for (const role of ["ADMIN", "STAFF", "ACCOUNTANT"]) {
      mockGetServerSession.mockResolvedValue({ user: { id: "u1", role } });
      const res = await GET(makeRequest());
      expect(res.status).toBe(200);
    }
  });
});

// ── Audit log recording ───────────────────────────────────────────────────────

describe("GET /analytics — audit logging", () => {
  it("records a B2B_PROCUREMENT_ANALYTICS_VIEWED audit log entry on successful response", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect(mockAuditLogCreate).toHaveBeenCalledOnce();
    const callArg = mockAuditLogCreate.mock.calls[0][0];
    const meta = JSON.parse(callArg.data.meta);
    expect(callArg.data.action).toBe("B2B_PROCUREMENT_ANALYTICS_VIEWED");
    expect(callArg.data.entityType).toBe("B2B_PROCUREMENT_ANALYTICS");
    expect(meta.sourcePage).toBe("admin/b2b/procurement/analytics");
    expect(meta.operation).toBe("VIEW");
    expect(meta.actor.id).toBe("u1");
    expect(callArg.data.outcome).toBe("SUCCESS");
  });

  it("records active date filters in audit meta", async () => {
    const res = await GET(
      makeRequest(
        "http://localhost/api/admin/b2b/procurement/analytics?start=2026-01-01&end=2026-03-31",
      ),
    );
    expect(res.status).toBe(200);
    const callArg = mockAuditLogCreate.mock.calls[0][0];
    const meta = JSON.parse(callArg.data.meta);
    expect(meta.filters.start).toBe("2026-01-01");
    expect(meta.filters.end).toBe("2026-03-31");
  });

  it("includes result summary counts in audit meta", async () => {
    const logs = [
      makeCreatedLog("req-1", baseSnapshot("req-1")),
      makeCreatedLog("req-2", baseSnapshot("req-2", { status: "IN_REVIEW" })),
    ];
    mockAuditLogFindMany.mockResolvedValue(logs);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const callArg = mockAuditLogCreate.mock.calls[0][0];
    const meta = JSON.parse(callArg.data.meta);
    expect(meta.resultSummary.totalRequests).toBe(2);
  });
});

// ── Truncated flag ────────────────────────────────────────────────────────────

describe("GET /analytics — truncation", () => {
  it("returns truncated:false when fewer than 10000 rows returned", async () => {
    mockAuditLogFindMany.mockResolvedValue([makeCreatedLog("req-1", baseSnapshot("req-1"))]);
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.truncated).toBe(false);
  });

  it("returns truncated:true when exactly 10000 rows are returned (hit the cap)", async () => {
    const logs = Array.from({ length: 10000 }, (_, i) =>
      makeCreatedLog(`req-${i}`, baseSnapshot(`req-${i}`)),
    );
    mockAuditLogFindMany.mockResolvedValue(logs);
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.truncated).toBe(true);
  });

  it("sets truncated:true in audit meta when cap is hit", async () => {
    const logs = Array.from({ length: 10000 }, (_, i) =>
      makeCreatedLog(`req-${i}`, baseSnapshot(`req-${i}`)),
    );
    mockAuditLogFindMany.mockResolvedValue(logs);
    await GET(makeRequest());
    const callArg = mockAuditLogCreate.mock.calls[0][0];
    const meta = JSON.parse(callArg.data.meta);
    expect(meta.resultSummary.truncated).toBe(true);
  });
});

// ── Unassigned open count fix ─────────────────────────────────────────────────

describe("GET /analytics — unassignedOpenCount", () => {
  it("counts as unassigned when latest snapshot has no accountManagerId", async () => {
    const createdLog = makeCreatedLog(
      "req-1",
      baseSnapshot("req-1", { status: "IN_REVIEW", accountManagerId: null }),
    );
    const assignLog = makeAssignLog("req-1");
    // Simulate a cleared assignment in the latest event
    const clearLog = {
      entityId: "req-1",
      action: "B2B_PROCUREMENT_REQUEST_STATUS_UPDATED",
      createdAt: new Date(),
      meta: JSON.stringify({
        snapshot: baseSnapshot("req-1", { status: "IN_REVIEW", accountManagerId: null }),
      }),
    };
    mockAuditLogFindMany.mockResolvedValue([createdLog, assignLog, clearLog]);
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.summary.unassignedOpenCount).toBe(1);
    expect(body.summary.openCount).toBe(1);
  });

  it("does NOT count as unassigned when latest snapshot has accountManagerId", async () => {
    const createdLog = makeCreatedLog("req-1", baseSnapshot("req-1", { status: "SUBMITTED" }));
    const assignLog = {
      ...makeAssignLog("req-1"),
      meta: JSON.stringify({
        snapshot: baseSnapshot("req-1", {
          status: "IN_REVIEW",
          accountManagerId: "mgr-1",
        }),
      }),
    };
    mockAuditLogFindMany.mockResolvedValue([createdLog, assignLog]);
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.summary.unassignedOpenCount).toBe(0);
  });
});

// ── Date range filter ─────────────────────────────────────────────────────────

describe("GET /analytics — date range filter", () => {
  it("filters requests by createdAt within range", async () => {
    const oldLog = makeCreatedLog(
      "req-old",
      baseSnapshot("req-old", { createdAt: "2025-01-01T00:00:00.000Z" }),
      new Date("2025-01-01"),
    );
    const newLog = makeCreatedLog(
      "req-new",
      baseSnapshot("req-new", { createdAt: "2026-06-01T00:00:00.000Z" }),
      new Date("2026-06-01"),
    );
    mockAuditLogFindMany.mockResolvedValue([oldLog, newLog]);
    const res = await GET(
      makeRequest(
        "http://localhost/api/admin/b2b/procurement/analytics?start=2026-01-01",
      ),
    );
    const body = await res.json();
    expect(body.summary.totalRequests).toBe(1);
  });

  it("returns all requests when no date filter applied", async () => {
    const log1 = makeCreatedLog(
      "req-1",
      baseSnapshot("req-1", { createdAt: "2025-01-01T00:00:00.000Z" }),
      new Date("2025-01-01"),
    );
    const log2 = makeCreatedLog(
      "req-2",
      baseSnapshot("req-2", { createdAt: "2026-06-01T00:00:00.000Z" }),
      new Date("2026-06-01"),
    );
    mockAuditLogFindMany.mockResolvedValue([log1, log2]);
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.summary.totalRequests).toBe(2);
  });

  it("filters with both start and end bounds", async () => {
    const inRange = makeCreatedLog(
      "req-in",
      baseSnapshot("req-in", { createdAt: "2026-02-15T00:00:00.000Z" }),
    );
    const tooEarly = makeCreatedLog(
      "req-early",
      baseSnapshot("req-early", { createdAt: "2025-12-01T00:00:00.000Z" }),
    );
    const tooLate = makeCreatedLog(
      "req-late",
      baseSnapshot("req-late", { createdAt: "2026-04-01T00:00:00.000Z" }),
    );
    mockAuditLogFindMany.mockResolvedValue([inRange, tooEarly, tooLate]);
    const res = await GET(
      makeRequest(
        "http://localhost/api/admin/b2b/procurement/analytics?start=2026-01-01&end=2026-03-31",
      ),
    );
    const body = await res.json();
    expect(body.summary.totalRequests).toBe(1);
  });
});

// ── Summary calculations ──────────────────────────────────────────────────────

describe("GET /analytics — summary calculations", () => {
  it("returns correct requestTypeCounts", async () => {
    const logs = [
      makeCreatedLog("req-1", baseSnapshot("req-1", { requestType: "QUOTE" })),
      makeCreatedLog("req-2", baseSnapshot("req-2", { requestType: "QUOTE" })),
      makeCreatedLog("req-3", baseSnapshot("req-3", { requestType: "PO_UPLOAD" })),
    ];
    mockAuditLogFindMany.mockResolvedValue(logs);
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.summary.requestTypeCounts.QUOTE).toBe(2);
    expect(body.summary.requestTypeCounts.PO_UPLOAD).toBe(1);
  });

  it("calculates convertedToDraftRatePct: 1 of 2 = 50%", async () => {
    const logs = [
      makeCreatedLog("req-1", baseSnapshot("req-1")),
      makeDraftLog("req-1"),
      makeCreatedLog("req-2", baseSnapshot("req-2", { status: "QUOTED", accountManagerId: "mgr-1" })),
    ];
    mockAuditLogFindMany.mockResolvedValue(logs);
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.summary.convertedToDraftRatePct).toBe(50);
    expect(body.summary.convertedToDraftCount).toBe(1);
    expect(body.summary.draftEligibleCount).toBe(2);
  });

  it("returns topRequested items with itemRef and count", async () => {
    const log = makeCreatedLog(
      "req-1",
      baseSnapshot("req-1", { itemsText: "Gloves x 10\nSyringes x 5" }),
    );
    mockAuditLogFindMany.mockResolvedValue([log]);
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.topRequested.length).toBeGreaterThan(0);
    expect(body.topRequested[0]).toHaveProperty("itemRef");
    expect(body.topRequested[0]).toHaveProperty("count");
  });

  it("returns oldestOpen sorted by ageDays desc", async () => {
    const old = makeCreatedLog(
      "req-old",
      baseSnapshot("req-old", {
        status: "IN_REVIEW",
        createdAt: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
      }),
    );
    const fresh = makeCreatedLog(
      "req-fresh",
      baseSnapshot("req-fresh", {
        status: "SUBMITTED",
        createdAt: new Date(Date.now() - 1 * 24 * 3600 * 1000).toISOString(),
      }),
    );
    mockAuditLogFindMany.mockResolvedValue([old, fresh]);
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.oldestOpen[0].id).toBe("req-old");
    expect(body.oldestOpen[0].ageDays).toBeGreaterThan(body.oldestOpen[1].ageDays);
  });

  it("excludes CLOSED and REJECTED from oldestOpen", async () => {
    const closed = makeCreatedLog("req-closed", baseSnapshot("req-closed", { status: "CLOSED" }));
    const open = makeCreatedLog("req-open", baseSnapshot("req-open", { status: "IN_REVIEW" }));
    mockAuditLogFindMany.mockResolvedValue([closed, open]);
    const res = await GET(makeRequest());
    const body = await res.json();
    const ids = body.oldestOpen.map((r: { id: string }) => r.id);
    expect(ids).not.toContain("req-closed");
    expect(ids).toContain("req-open");
  });

  it("computes avgHoursToAssignment from first assignment event", async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
    const oneHourAgo = new Date(Date.now() - 1 * 3600 * 1000);
    const created = makeCreatedLog("req-1", baseSnapshot("req-1"), twoHoursAgo);
    const assigned = makeAssignLog("req-1", "mgr-1", oneHourAgo);
    mockAuditLogFindMany.mockResolvedValue([created, assigned]);
    const res = await GET(makeRequest());
    const body = await res.json();
    // 1 hour between created and assigned
    expect(body.summary.avgHoursToAssignment).toBeCloseTo(1, 0);
  });

  it("returns null avgHoursToAssignment when no assignments exist", async () => {
    mockAuditLogFindMany.mockResolvedValue([makeCreatedLog("req-1", baseSnapshot("req-1"))]);
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.summary.avgHoursToAssignment).toBeNull();
  });
});

// ── Manager workload ──────────────────────────────────────────────────────────

describe("GET /analytics — managerWorkload", () => {
  it("returns managerWorkload array in response", async () => {
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(Array.isArray(body.managerWorkload)).toBe(true);
  });

  it("counts open requests per manager from latest snapshot", async () => {
    const createdMgr1 = makeCreatedLog(
      "req-1",
      baseSnapshot("req-1", { status: "IN_REVIEW", accountManagerId: "mgr-1" }),
    );
    const createdMgr2 = makeCreatedLog(
      "req-2",
      baseSnapshot("req-2", { status: "IN_REVIEW", accountManagerId: "mgr-2" }),
    );
    const createdMgr1b = makeCreatedLog(
      "req-3",
      baseSnapshot("req-3", { status: "QUOTED", accountManagerId: "mgr-1" }),
    );
    mockAuditLogFindMany.mockResolvedValue([createdMgr1, createdMgr2, createdMgr1b]);
    mockUserFindMany.mockResolvedValue([
      { id: "mgr-1", name: "Ama Owusu", email: "ama@nora.gh" },
      { id: "mgr-2", name: "Kofi Asante", email: "kofi@nora.gh" },
    ]);

    const res = await GET(makeRequest());
    const body = await res.json();
    const mgr1Row = body.managerWorkload.find(
      (r: { managerId: string }) => r.managerId === "mgr-1",
    );
    expect(mgr1Row).toBeDefined();
    expect(mgr1Row.openCount).toBe(2);
    expect(mgr1Row.quotedCount).toBe(1);
    expect(mgr1Row.managerName).toBe("Ama Owusu");
  });

  it("groups unassigned open requests under __unassigned__ with label 'Unassigned'", async () => {
    const unassigned = makeCreatedLog(
      "req-unassigned",
      baseSnapshot("req-unassigned", { status: "SUBMITTED", accountManagerId: null }),
    );
    mockAuditLogFindMany.mockResolvedValue([unassigned]);

    const res = await GET(makeRequest());
    const body = await res.json();
    const unassignedRow = body.managerWorkload.find(
      (r: { managerId: string }) => r.managerId === "__unassigned__",
    );
    expect(unassignedRow).toBeDefined();
    expect(unassignedRow.managerName).toBe("Unassigned");
    expect(unassignedRow.openCount).toBe(1);
  });

  it("excludes REJECTED and CLOSED requests from manager workload", async () => {
    const rejected = makeCreatedLog(
      "req-rej",
      baseSnapshot("req-rej", { status: "REJECTED", accountManagerId: "mgr-1" }),
    );
    const closed = makeCreatedLog(
      "req-closed",
      baseSnapshot("req-closed", { status: "CLOSED", accountManagerId: "mgr-1" }),
    );
    mockAuditLogFindMany.mockResolvedValue([rejected, closed]);
    mockUserFindMany.mockResolvedValue([{ id: "mgr-1", name: "Ama", email: null }]);

    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.managerWorkload).toHaveLength(0);
  });

  it("sorts managerWorkload by openCount descending", async () => {
    const logs = [
      makeCreatedLog("req-1", baseSnapshot("req-1", { status: "IN_REVIEW", accountManagerId: "mgr-a" })),
      makeCreatedLog("req-2", baseSnapshot("req-2", { status: "IN_REVIEW", accountManagerId: "mgr-b" })),
      makeCreatedLog("req-3", baseSnapshot("req-3", { status: "IN_REVIEW", accountManagerId: "mgr-b" })),
    ];
    mockAuditLogFindMany.mockResolvedValue(logs);
    mockUserFindMany.mockResolvedValue([
      { id: "mgr-a", name: "A", email: null },
      { id: "mgr-b", name: "B", email: null },
    ]);

    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.managerWorkload[0].managerId).toBe("mgr-b");
    expect(body.managerWorkload[0].openCount).toBe(2);
  });

  it("falls back to managerId string when user not found in DB", async () => {
    const log = makeCreatedLog(
      "req-1",
      baseSnapshot("req-1", { status: "IN_REVIEW", accountManagerId: "ghost-mgr" }),
    );
    mockAuditLogFindMany.mockResolvedValue([log]);
    mockUserFindMany.mockResolvedValue([]); // user not found

    const res = await GET(makeRequest());
    const body = await res.json();
    const row = body.managerWorkload.find(
      (r: { managerId: string }) => r.managerId === "ghost-mgr",
    );
    expect(row).toBeDefined();
    expect(row.managerName).toBe("ghost-mgr");
  });
});

// ── Monthly trend ─────────────────────────────────────────────────────────────

describe("GET /analytics — trend", () => {
  it("returns trend array in response", async () => {
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(Array.isArray(body.trend)).toBe(true);
  });

  it("groups requests by YYYY-MM and counts submitted, approved, rejected", async () => {
    const jan = makeCreatedLog(
      "req-jan",
      baseSnapshot("req-jan", {
        status: "APPROVED",
        createdAt: "2026-01-15T10:00:00.000Z",
      }),
    );
    const janRej = makeCreatedLog(
      "req-jan-rej",
      baseSnapshot("req-jan-rej", {
        status: "REJECTED",
        createdAt: "2026-01-20T10:00:00.000Z",
      }),
    );
    const feb = makeCreatedLog(
      "req-feb",
      baseSnapshot("req-feb", {
        status: "SUBMITTED",
        createdAt: "2026-02-05T10:00:00.000Z",
      }),
    );
    mockAuditLogFindMany.mockResolvedValue([jan, janRej, feb]);

    const res = await GET(makeRequest());
    const body = await res.json();
    const janRow = body.trend.find((r: { month: string }) => r.month === "2026-01");
    const febRow = body.trend.find((r: { month: string }) => r.month === "2026-02");

    expect(janRow).toBeDefined();
    expect(janRow.submitted).toBe(2);
    expect(janRow.approved).toBe(1);
    expect(janRow.rejected).toBe(1);

    expect(febRow).toBeDefined();
    expect(febRow.submitted).toBe(1);
    expect(febRow.approved).toBe(0);
  });

  it("returns trend sorted chronologically", async () => {
    const logs = [
      makeCreatedLog(
        "req-mar",
        baseSnapshot("req-mar", { createdAt: "2026-03-01T00:00:00.000Z" }),
      ),
      makeCreatedLog(
        "req-jan",
        baseSnapshot("req-jan", { createdAt: "2026-01-01T00:00:00.000Z" }),
      ),
      makeCreatedLog(
        "req-feb",
        baseSnapshot("req-feb", { createdAt: "2026-02-01T00:00:00.000Z" }),
      ),
    ];
    mockAuditLogFindMany.mockResolvedValue(logs);

    const res = await GET(makeRequest());
    const body = await res.json();
    const months = body.trend.map((r: { month: string }) => r.month);
    expect(months).toEqual([...months].sort());
  });

  it("limits trend to at most 12 months", async () => {
    // Create 14 months of data
    const logs = Array.from({ length: 14 }, (_, i) => {
      const year = 2025 + Math.floor(i / 12);
      const month = String((i % 12) + 1).padStart(2, "0");
      return makeCreatedLog(
        `req-${i}`,
        baseSnapshot(`req-${i}`, { createdAt: `${year}-${month}-15T00:00:00.000Z` }),
      );
    });
    mockAuditLogFindMany.mockResolvedValue(logs);

    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.trend.length).toBeLessThanOrEqual(12);
  });
});

// ── Response shape ────────────────────────────────────────────────────────────

describe("GET /analytics — response shape", () => {
  it("returns all expected top-level keys", async () => {
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body).toHaveProperty("summary");
    expect(body).toHaveProperty("topRequested");
    expect(body).toHaveProperty("oldestOpen");
    expect(body).toHaveProperty("managerWorkload");
    expect(body).toHaveProperty("trend");
    expect(body).toHaveProperty("truncated");
  });

  it("returns all expected summary sub-keys", async () => {
    const res = await GET(makeRequest());
    const body = await res.json();
    const s = body.summary;
    for (const key of [
      "totalRequests",
      "openCount",
      "unassignedOpenCount",
      "draftEligibleCount",
      "convertedToDraftCount",
      "convertedToDraftRatePct",
      "avgHoursToAssignment",
      "avgHoursToQuoted",
      "avgHoursToApproved",
      "statusCounts",
      "requestTypeCounts",
    ]) {
      expect(s).toHaveProperty(key);
    }
  });

  it("STAFF role still triggers audit log recording", async () => {
    mockGetServerSession.mockResolvedValue(STAFF_SESSION);
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect(mockAuditLogCreate).toHaveBeenCalledOnce();
    const callArg = mockAuditLogCreate.mock.calls[0][0];
    expect(JSON.parse(callArg.data.meta).actor.role).toBe("STAFF");
  });
});
