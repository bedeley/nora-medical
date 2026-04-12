/**
 * Vitest unit tests for POST /api/admin/b2b/tenders/[id]/email
 *
 * Tests cover: auth, approval gate, CC-failure-degrades-to-warning (BUG-2 fix),
 * recipient DB record creation, version creation, audit log metadata/sourcePage.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockRateLimit,
  mockPrismaTenderFindUnique,
  mockPrismaTenderUpdate,
  mockPrismaTenderVersionFindFirst,
  mockPrismaTenderVersionCreate,
  mockPrismaAuditLogFindFirst,
  mockPrismaAuditLogCreate,
  mockGetLatestTenderSnapshot,
  mockGenerateTenderPdf,
  mockSendEmail,
} = vi.hoisted(() => ({
  mockGetServerSession:           vi.fn(),
  mockAssertSameOrigin:           vi.fn(() => true),
  mockRateLimit:                  vi.fn(() => ({ ok: true })),
  mockPrismaTenderFindUnique:     vi.fn(),
  mockPrismaTenderUpdate:         vi.fn(),
  mockPrismaTenderVersionFindFirst: vi.fn(),
  mockPrismaTenderVersionCreate:  vi.fn(),
  mockPrismaAuditLogFindFirst:    vi.fn(async (): Promise<unknown> => null),
  mockPrismaAuditLogCreate:       vi.fn(),
  mockGetLatestTenderSnapshot:    vi.fn(),
  mockGenerateTenderPdf:          vi.fn(() => Buffer.from("pdf")),
  mockSendEmail:                  vi.fn(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true })),
}));

vi.mock("next-auth",        () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/origin",     () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mockRateLimit }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tender:        { findUnique: mockPrismaTenderFindUnique, update: mockPrismaTenderUpdate },
    tenderVersion: { findFirst: mockPrismaTenderVersionFindFirst, create: mockPrismaTenderVersionCreate },
    auditLog:      { findFirst: mockPrismaAuditLogFindFirst, create: mockPrismaAuditLogCreate },
  },
}));
vi.mock("@/lib/b2b-tender", () => ({
  getLatestTenderSnapshot: mockGetLatestTenderSnapshot,
  generateTenderPdf:       mockGenerateTenderPdf,
}));
vi.mock("@/lib/email",          () => ({ sendEmail: mockSendEmail }));
vi.mock("@/lib/tender-sanitization", () => ({ sanitizeFreeText: (v: string) => v }));

import { POST } from "./route";

const ADMIN_SESSION = { user: { id: "u1", role: "ADMIN", email: "admin@nora.gh", name: "Admin" } };
const STAFF_SESSION = { user: { id: "u2", role: "STAFF", email: "staff@nora.gh" } };

function makeContext(id = "tender-1") {
  return { params: { id } };
}

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/admin/b2b/tenders/tender-1/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeSnapshot(overrides = {}) {
  return {
    id: "tender-1",
    tenderNumber: "TND-2026-0001",
    buyerName: "Accra General Hospital",
    tenderRef: "REF-001",
    lotTitle: "LOT 1",
    currency: "GHS",
    total: 300,
    status: "SUBMITTED",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
  mockAssertSameOrigin.mockReturnValue(true);
  mockRateLimit.mockResolvedValue({ ok: true });
  mockPrismaTenderVersionFindFirst.mockResolvedValue({ versionNo: 2 });
  mockPrismaAuditLogFindFirst.mockResolvedValue(null);
  mockGetLatestTenderSnapshot.mockResolvedValue(makeSnapshot());
  mockPrismaTenderFindUnique.mockResolvedValue({
    id: "tender-1",
    status: "SUBMITTED",
    tenderNumber: "TND-2026-0001",
    buyerName: "Accra General Hospital",
    _count: { versions: 2 },
  });
  mockPrismaTenderUpdate.mockResolvedValue({});
  mockPrismaTenderVersionCreate.mockResolvedValue({});
  mockPrismaAuditLogCreate.mockResolvedValue({});
  mockSendEmail.mockResolvedValue({ ok: true });
  mockGenerateTenderPdf.mockResolvedValue(Buffer.from("pdf-data"));
  // Default: approval not required
  process.env.B2B_TENDER_REQUIRE_APPROVAL = "0";
});

// ─── Auth ─────────────────────────────────────────────────────────────────────

describe("POST /api/admin/b2b/tenders/[id]/email — auth", () => {
  it("rejects unauthenticated requests", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await POST(makeRequest({ to: "buyer@clinic.gh" }), makeContext());
    expect(res.status).toBe(401);
  });

  it("allows STAFF role", async () => {
    mockGetServerSession.mockResolvedValue(STAFF_SESSION);
    const res = await POST(makeRequest({ to: "buyer@clinic.gh" }), makeContext());
    expect(res.status).toBe(200);
  });
});

// ─── Validation ───────────────────────────────────────────────────────────────

describe("POST /api/admin/b2b/tenders/[id]/email — validation", () => {
  it("returns 400 for invalid 'to' email", async () => {
    const res = await POST(makeRequest({ to: "not-an-email" }), makeContext());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.details?.fieldErrors?.to).toBeDefined();
  });

  it("returns 400 for invalid 'cc' email", async () => {
    const res = await POST(makeRequest({ to: "buyer@clinic.gh", cc: "bad-email" }), makeContext());
    expect(res.status).toBe(400);
  });

  it("returns 409 when no tender version exists", async () => {
    mockPrismaTenderVersionFindFirst.mockResolvedValue(null);
    const res = await POST(makeRequest({ to: "buyer@clinic.gh" }), makeContext());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/No tender version/i);
  });

  it("returns 409 when a draft tender is sent before submission", async () => {
    mockPrismaTenderFindUnique.mockResolvedValue({
      id: "tender-1",
      status: "DRAFT",
      tenderNumber: "TND-2026-0001",
      buyerName: "Accra General Hospital",
      _count: { versions: 2 },
    });
    const res = await POST(makeRequest({ to: "buyer@clinic.gh" }), makeContext());
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error).toMatch(/submit/i);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("returns 409 for terminal statuses", async () => {
    mockPrismaTenderFindUnique.mockResolvedValue({
      id: "tender-1",
      status: "WON",
      tenderNumber: "TND-2026-0001",
      buyerName: "Accra General Hospital",
      _count: { versions: 2 },
    });
    const res = await POST(makeRequest({ to: "buyer@clinic.gh" }), makeContext());
    expect(res.status).toBe(409);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

// ─── Approval gate ────────────────────────────────────────────────────────────

describe("POST /api/admin/b2b/tenders/[id]/email — approval gate", () => {
  beforeEach(() => {
    process.env.B2B_TENDER_REQUIRE_APPROVAL = "1";
    process.env.PROTECTED_ADMIN_EMAILS = "";
  });

  it("returns 409 when approved version is behind latest version", async () => {
    mockPrismaTenderVersionFindFirst.mockResolvedValue({ versionNo: 5 });
    // Approval record for version 3 — stale
    mockPrismaAuditLogFindFirst.mockResolvedValue({
      meta: JSON.stringify({ approvedVersionNo: 3 }),
    });
    const res = await POST(makeRequest({ to: "buyer@clinic.gh" }), makeContext());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/approved.*latest version/i);
  });

  it("allows send when approved version matches latest", async () => {
    mockPrismaTenderVersionFindFirst.mockResolvedValue({ versionNo: 3 });
    mockPrismaAuditLogFindFirst.mockResolvedValue({
      meta: JSON.stringify({ approvedVersionNo: 3 }),
    });
    const res = await POST(makeRequest({ to: "buyer@clinic.gh" }), makeContext());
    expect(res.status).toBe(200);
  });

  it("allows protected admin to bypass approval", async () => {
    process.env.PROTECTED_ADMIN_EMAILS = "admin@nora.gh";
    mockPrismaTenderVersionFindFirst.mockResolvedValue({ versionNo: 5 });
    mockPrismaAuditLogFindFirst.mockResolvedValue(null);  // No approval record
    const res = await POST(makeRequest({ to: "buyer@clinic.gh" }), makeContext());
    expect(res.status).toBe(200);
  });
});

// ─── CC failure degrades to warning (BUG-2 fix) ──────────────────────────────

describe("POST /api/admin/b2b/tenders/[id]/email — CC failure handling (BUG-2 fix)", () => {
  it("returns 200 with ccWarning when TO succeeds but CC fails", async () => {
    mockSendEmail
      .mockResolvedValueOnce({ ok: true })   // primary TO
      .mockResolvedValueOnce({ ok: false, error: "CC mailbox not found" }); // CC

    const res  = await POST(makeRequest({ to: "buyer@clinic.gh", cc: "manager@clinic.gh" }), makeContext());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.ccWarning).toMatch(/CC mailbox not found/);
  });

  it("still updates DB status to SENT even when CC fails", async () => {
    mockSendEmail
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: "timeout" });

    await POST(makeRequest({ to: "buyer@clinic.gh", cc: "cc@clinic.gh" }), makeContext());

    expect(mockPrismaTenderUpdate).toHaveBeenCalledOnce();
    const updateArgs = mockPrismaTenderUpdate.mock.calls[0][0].data;
    expect(updateArgs.status).toBe("SENT");
  });

  it("creates audit log with outcome PARTIAL when CC fails", async () => {
    mockSendEmail
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: "timeout" });

    await POST(makeRequest({ to: "buyer@clinic.gh", cc: "cc@clinic.gh" }), makeContext());

    expect(mockPrismaAuditLogCreate).toHaveBeenCalledOnce();
    const auditData = mockPrismaAuditLogCreate.mock.calls[0][0].data;
    expect(auditData.outcome).toBe("PARTIAL");
    const meta = JSON.parse(auditData.meta);
    expect(meta.delivery.ccWarning).toMatch(/timeout/);
    expect(meta.delivery.toStatus).toBe("SENT");
    expect(meta.delivery.ccStatus).toBe("FAILED");
  });

  it("returns 500 only when the primary TO send fails", async () => {
    mockSendEmail.mockResolvedValue({ ok: false, error: "SMTP server down" });
    const res = await POST(makeRequest({ to: "buyer@clinic.gh" }), makeContext());
    expect(res.status).toBe(500);
    expect(mockPrismaTenderUpdate).not.toHaveBeenCalled();
    expect(mockPrismaAuditLogCreate).toHaveBeenCalledOnce();
    const auditData = mockPrismaAuditLogCreate.mock.calls[0][0].data;
    expect(auditData.action).toBe("B2B_TENDER_SEND_FAILED");
    expect(auditData.outcome).toBe("FAILED");
  });
});

// ─── Happy path ───────────────────────────────────────────────────────────────

describe("POST /api/admin/b2b/tenders/[id]/email — happy path", () => {
  it("sends email, updates tender to SENT, creates version and audit log", async () => {
    const res  = await POST(makeRequest({ to: "buyer@clinic.gh" }), makeContext());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.snapshot.status).toBe("SENT");
    expect(body.ccWarning).toBeUndefined();

    expect(mockSendEmail).toHaveBeenCalledOnce();
    expect(mockPrismaTenderUpdate).toHaveBeenCalledOnce();
    expect(mockPrismaTenderVersionCreate).toHaveBeenCalledOnce();
    expect(mockPrismaAuditLogCreate).toHaveBeenCalledOnce();
  });

  it("audit log includes sourcePage and actor metadata", async () => {
    await POST(makeRequest({ to: "buyer@clinic.gh" }), makeContext());
    const auditData = mockPrismaAuditLogCreate.mock.calls[0][0].data;
    const meta = JSON.parse(auditData.meta);

    expect(meta.sourcePage).toBe("admin/b2b/tenders");
    expect(meta.actor.id).toBe("u1");
    expect(meta.actor.email).toBe("admin@nora.gh");
    expect(auditData.outcome).toBe("SUCCESS");
  });

  it("creates recipient record with recipientType TO", async () => {
    await POST(makeRequest({ to: "buyer@clinic.gh" }), makeContext());
    const updateData = mockPrismaTenderUpdate.mock.calls[0][0].data;
    const recipients = updateData.recipients.create;
    expect(recipients.some((r: { recipientType: string }) => r.recipientType === "TO")).toBe(true);
  });

  it("creates CC recipient record when cc is provided and both succeed", async () => {
    await POST(makeRequest({ to: "buyer@clinic.gh", cc: "cc@clinic.gh" }), makeContext());
    const updateData = mockPrismaTenderUpdate.mock.calls[0][0].data;
    const recipients = updateData.recipients.create;
    expect(recipients.some((r: { recipientType: string }) => r.recipientType === "CC")).toBe(true);
  });

  it("records failed CC recipient as FAILED with lastError", async () => {
    mockSendEmail
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: "timeout" });

    await POST(makeRequest({ to: "buyer@clinic.gh", cc: "cc@clinic.gh" }), makeContext());
    const updateData = mockPrismaTenderUpdate.mock.calls[0][0].data;
    const ccRecipient = updateData.recipients.create.find((r: { recipientType: string }) => r.recipientType === "CC");
    expect(ccRecipient.deliveryStatus).toBe("FAILED");
    expect(ccRecipient.lastError).toBe("timeout");
  });

  it("uses a resend audit action when an already sent tender is emailed again", async () => {
    mockPrismaTenderFindUnique.mockResolvedValue({
      id: "tender-1",
      status: "SENT",
      tenderNumber: "TND-2026-0001",
      buyerName: "Accra General Hospital",
      _count: { versions: 3 },
    });

    await POST(makeRequest({ to: "buyer@clinic.gh" }), makeContext());
    const auditData = mockPrismaAuditLogCreate.mock.calls[0][0].data;
    expect(auditData.action).toBe("B2B_TENDER_RESENT");
    const versionData = mockPrismaTenderVersionCreate.mock.calls[0][0].data;
    expect(versionData.changeNote).toMatch(/resent/i);
  });
});
