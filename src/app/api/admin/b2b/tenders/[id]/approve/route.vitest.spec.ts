/**
 * Vitest unit tests for POST /api/admin/b2b/tenders/[id]/approve
 *
 * Tests cover: auth, maker-checker enforcement, protected admin bypass,
 * audit log sourcePage/metadata, and happy-path approval.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockRateLimit,
  mockPrismaTenderVersionFindFirst,
  mockPrismaAuditLogCreate,
} = vi.hoisted(() => ({
  mockGetServerSession:           vi.fn(),
  mockAssertSameOrigin:           vi.fn(() => true),
  mockRateLimit:                  vi.fn(() => ({ ok: true })),
  mockPrismaTenderVersionFindFirst: vi.fn(),
  mockPrismaAuditLogCreate:       vi.fn(),
}));

vi.mock("next-auth",        () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/origin",     () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mockRateLimit }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenderVersion: { findFirst: mockPrismaTenderVersionFindFirst },
    auditLog:      { create: mockPrismaAuditLogCreate },
  },
}));

import { POST } from "./route";

const ADMIN_SESSION = { user: { id: "u1", role: "ADMIN", email: "admin@nora.gh", name: "Admin" } };
const STAFF_SESSION = { user: { id: "u2", role: "STAFF", email: "staff@nora.gh" } };
const OTHER_USER    = { user: { id: "u3", role: "ADMIN", email: "other@nora.gh" } };

function makeContext(id = "tender-1") {
  return { params: { id } };
}

function makeRequest(body: unknown = {}) {
  return new Request("http://localhost/api/admin/b2b/tenders/tender-1/approve", {
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
  mockPrismaAuditLogCreate.mockResolvedValue({});
  process.env.B2B_TENDER_APPROVAL_MAKER_CHECKER = "1";
  process.env.PROTECTED_ADMIN_EMAILS = "";
  // Default: last version was created by a different user
  mockPrismaTenderVersionFindFirst.mockResolvedValue({
    versionNo: 3,
    createdById: "u99",   // different from u1
    createdAt: new Date("2026-01-01"),
  });
});

// ─── Auth ─────────────────────────────────────────────────────────────────────

describe("POST /api/admin/b2b/tenders/[id]/approve — auth", () => {
  it("rejects unauthenticated requests", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(401);
  });

  it("allows STAFF role", async () => {
    mockGetServerSession.mockResolvedValue(STAFF_SESSION);
    mockPrismaTenderVersionFindFirst.mockResolvedValue({ versionNo: 1, createdById: "u99", createdAt: new Date() });
    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(200);
  });
});

// ─── Version required ─────────────────────────────────────────────────────────

describe("POST /api/admin/b2b/tenders/[id]/approve — version check", () => {
  it("returns 409 when no tender version exists", async () => {
    mockPrismaTenderVersionFindFirst.mockResolvedValue(null);
    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/No tender version/i);
  });
});

// ─── Maker-checker ────────────────────────────────────────────────────────────

describe("POST /api/admin/b2b/tenders/[id]/approve — maker-checker rule", () => {
  it("rejects when actor is the same as last editor (maker-checker on)", async () => {
    // Last version created by u1 = same as session actor
    mockPrismaTenderVersionFindFirst.mockResolvedValue({ versionNo: 2, createdById: "u1", createdAt: new Date() });
    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/Maker-checker/i);
  });

  it("allows when actor is different from last editor", async () => {
    mockGetServerSession.mockResolvedValue(OTHER_USER);
    // Last version created by u1, OTHER_USER = u3 approves
    mockPrismaTenderVersionFindFirst.mockResolvedValue({ versionNo: 2, createdById: "u1", createdAt: new Date() });
    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(200);
  });

  it("ignores maker-checker when it is disabled via env", async () => {
    process.env.B2B_TENDER_APPROVAL_MAKER_CHECKER = "0";
    // Last version created by u1 = actor, but maker-checker is off
    mockPrismaTenderVersionFindFirst.mockResolvedValue({ versionNo: 1, createdById: "u1", createdAt: new Date() });
    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(200);
  });

  it("allows protected admin to self-approve even with maker-checker on", async () => {
    process.env.PROTECTED_ADMIN_EMAILS = "admin@nora.gh";
    // Last version created by u1 = actor, but actor is protected admin
    mockPrismaTenderVersionFindFirst.mockResolvedValue({ versionNo: 1, createdById: "u1", createdAt: new Date() });
    const res = await POST(makeRequest(), makeContext());
    expect(res.status).toBe(200);
  });
});

// ─── Audit log ────────────────────────────────────────────────────────────────

describe("POST /api/admin/b2b/tenders/[id]/approve — audit log", () => {
  it("writes audit log with sourcePage and correct metadata", async () => {
    await POST(makeRequest({ note: "Approved after price check" }), makeContext());

    expect(mockPrismaAuditLogCreate).toHaveBeenCalledOnce();
    const auditData = mockPrismaAuditLogCreate.mock.calls[0][0].data;
    const meta = JSON.parse(auditData.meta);

    expect(auditData.action).toBe("B2B_TENDER_APPROVED");
    expect(auditData.entityType).toBe("B2B_TENDER");
    expect(auditData.outcome).toBe("SUCCESS");
    expect(meta.sourcePage).toBe("admin/b2b/tenders");
    expect(meta.operation).toBe("approve_for_send");
    expect(meta.approvedVersionNo).toBe(3);
    expect(meta.note).toBe("Approved after price check");
    expect(meta.actor.id).toBe("u1");
  });

  it("returns approved version number in response", async () => {
    const res  = await POST(makeRequest(), makeContext());
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.approvedVersionNo).toBe(3);
    expect(body.approvedAt).toBeDefined();
  });
});
