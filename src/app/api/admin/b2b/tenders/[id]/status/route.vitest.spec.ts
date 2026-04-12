/**
 * Vitest unit tests for POST /api/admin/b2b/tenders/[id]/status
 *
 * Tests cover: auth, allowed-transitions enforcement, terminal status guard,
 * DB updates, version creation, and audit log sourcePage/metadata.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockRateLimit,
  mockPrismaTenderFindUnique,
  mockPrismaTenderUpdate,
  mockPrismaTenderVersionCreate,
  mockPrismaAuditLogCreate,
  mockGetLatestTenderSnapshot,
} = vi.hoisted(() => ({
  mockGetServerSession:           vi.fn(),
  mockAssertSameOrigin:           vi.fn(() => true),
  mockRateLimit:                  vi.fn(() => ({ ok: true })),
  mockPrismaTenderFindUnique:     vi.fn(),
  mockPrismaTenderUpdate:         vi.fn(),
  mockPrismaTenderVersionCreate:  vi.fn(),
  mockPrismaAuditLogCreate:       vi.fn(),
  mockGetLatestTenderSnapshot:    vi.fn(),
}));

vi.mock("next-auth",        () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/origin",     () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mockRateLimit }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tender:        { findUnique: mockPrismaTenderFindUnique, update: mockPrismaTenderUpdate },
    tenderVersion: { create: mockPrismaTenderVersionCreate },
    auditLog:      { create: mockPrismaAuditLogCreate },
  },
}));
vi.mock("@/lib/b2b-tender", () => ({
  getLatestTenderSnapshot: mockGetLatestTenderSnapshot,
  mapTenderStatusFromUi:   (s: string) => s.toUpperCase(),
}));

import { POST } from "./route";

const ADMIN_SESSION = { user: { id: "u1", role: "ADMIN", email: "admin@nora.gh", name: "Admin" } };
const STAFF_SESSION = { user: { id: "u2", role: "STAFF" } };

function makeContext(id = "tender-1") {
  return { params: { id } };
}

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/admin/b2b/tenders/tender-1/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeTender(status: string, versionCount = 1) {
  return { id: "tender-1", status, _count: { versions: versionCount } };
}

function makeSnapshot(overrides = {}) {
  return {
    id: "tender-1",
    tenderNumber: "TND-2026-0001",
    buyerName: "Accra Clinic",
    status: "SENT",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
  mockAssertSameOrigin.mockReturnValue(true);
  mockRateLimit.mockResolvedValue({ ok: true });
  mockPrismaTenderUpdate.mockResolvedValue({});
  mockPrismaTenderVersionCreate.mockResolvedValue({});
  mockPrismaAuditLogCreate.mockResolvedValue({});
});

// ─── Auth ─────────────────────────────────────────────────────────────────────

describe("POST /api/admin/b2b/tenders/[id]/status — auth", () => {
  it("rejects unauthenticated requests", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await POST(makeRequest({ status: "SENT" }), makeContext());
    expect(res.status).toBe(401);
  });

  it("rejects bad origin", async () => {
    mockAssertSameOrigin.mockReturnValue(false);
    mockPrismaTenderFindUnique.mockResolvedValue(makeTender("DRAFT"));
    const res = await POST(makeRequest({ status: "SUBMITTED" }), makeContext());
    expect(res.status).toBe(403);
  });

  it("allows STAFF role", async () => {
    mockGetServerSession.mockResolvedValue(STAFF_SESSION);
    mockPrismaTenderFindUnique.mockResolvedValue(makeTender("DRAFT"));
    mockGetLatestTenderSnapshot.mockResolvedValue(makeSnapshot({ status: "SUBMITTED" }));
    const res = await POST(makeRequest({ status: "SUBMITTED" }), makeContext());
    expect(res.status).toBe(200);
  });
});

// ─── Validation ───────────────────────────────────────────────────────────────

describe("POST /api/admin/b2b/tenders/[id]/status — validation", () => {
  it("returns 400 for invalid status value", async () => {
    mockPrismaTenderFindUnique.mockResolvedValue(makeTender("DRAFT"));
    const res = await POST(makeRequest({ status: "FLYING" }), makeContext());
    expect(res.status).toBe(400);
  });

  it("returns 404 when tender not found", async () => {
    mockPrismaTenderFindUnique.mockResolvedValue(null);
    const res = await POST(makeRequest({ status: "SUBMITTED" }), makeContext());
    expect(res.status).toBe(404);
  });
});

// ─── Transition enforcement ───────────────────────────────────────────────────

describe("POST /api/admin/b2b/tenders/[id]/status — transitions", () => {
  it.each([
    ["DRAFT",     "SUBMITTED", true],
    ["DRAFT",     "CANCELLED", true],
    ["DRAFT",     "WON",       false],
    ["SUBMITTED", "SENT",      true],
    ["SUBMITTED", "LOST",      true],
    ["SENT",      "WON",       true],
    ["SENT",      "LOST",      true],
    ["WON",       "DRAFT",     false],
    ["WON",       "CANCELLED", false],
    ["LOST",      "DRAFT",     false],
    ["CANCELLED", "DRAFT",     false],
  ])("from %s → %s allowed=%s", async (from, to, allowed) => {
    mockPrismaTenderFindUnique.mockResolvedValue(makeTender(from));
    if (allowed) {
      mockGetLatestTenderSnapshot.mockResolvedValue(makeSnapshot({ status: to }));
    }
    const res = await POST(makeRequest({ status: to }), makeContext());
    if (allowed) {
      expect(res.status).toBe(200);
    } else {
      expect([409, 400]).toContain(res.status);
    }
  });

  it("returns ok:true + unchanged:true when status already matches", async () => {
    mockPrismaTenderFindUnique.mockResolvedValue(makeTender("SENT"));
    mockGetLatestTenderSnapshot.mockResolvedValue(makeSnapshot({ status: "SENT" }));
    const res  = await POST(makeRequest({ status: "SENT" }), makeContext());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.unchanged).toBe(true);
    expect(mockPrismaTenderUpdate).not.toHaveBeenCalled();
  });
});

// ─── Audit log ────────────────────────────────────────────────────────────────

describe("POST /api/admin/b2b/tenders/[id]/status — audit log", () => {
  it("writes audit log with sourcePage and before/after on successful update", async () => {
    mockPrismaTenderFindUnique.mockResolvedValue(makeTender("DRAFT", 1));
    mockGetLatestTenderSnapshot.mockResolvedValue(makeSnapshot({ status: "SUBMITTED" }));

    await POST(makeRequest({ status: "SUBMITTED", note: "Internal review complete" }), makeContext());

    expect(mockPrismaAuditLogCreate).toHaveBeenCalledOnce();
    const auditData = mockPrismaAuditLogCreate.mock.calls[0][0].data;
    const meta = JSON.parse(auditData.meta);

    expect(auditData.action).toBe("B2B_TENDER_STATUS_UPDATED");
    expect(auditData.entityType).toBe("B2B_TENDER");
    expect(auditData.outcome).toBe("SUCCESS");
    expect(meta.sourcePage).toBe("admin/b2b/tenders");
    expect(meta.before.status).toBe("DRAFT");
    expect(meta.after.status).toBe("SUBMITTED");
    expect(meta.note).toBe("Internal review complete");
    expect(meta.actor.id).toBe("u1");
  });

  it("creates a new tenderVersion on successful update", async () => {
    mockPrismaTenderFindUnique.mockResolvedValue(makeTender("DRAFT", 2));
    mockGetLatestTenderSnapshot.mockResolvedValue(makeSnapshot({ status: "SUBMITTED" }));

    await POST(makeRequest({ status: "SUBMITTED" }), makeContext());

    expect(mockPrismaTenderVersionCreate).toHaveBeenCalledOnce();
    const versionData = mockPrismaTenderVersionCreate.mock.calls[0][0].data;
    expect(versionData.versionNo).toBe(3);
    expect(versionData.status).toBe("SUBMITTED");
  });
});
