/**
 * Vitest unit tests for /api/admin/b2b/tenders (GET list + POST create/update)
 *
 * Tests cover: auth guards, validation, margin enforcement, OOS enforcement,
 * version creation, audit logging with sourcePage, and happy-path CRUD.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockRateLimit,
  mockPrismaTenderCreate,
  mockPrismaTenderUpdate,
  mockPrismaTenderFindUnique,
  mockPrismaProductFindMany,
  mockPrismaTenderVersionCreate,
  mockPrismaAuditLogCreate,
  mockListTenderSnapshotsPage,
  mockBuildTenderPreview,
  mockSanitizeTenderItemsText,
  mockValidateLineOverrideNos,
} = vi.hoisted(() => ({
  mockGetServerSession:         vi.fn(),
  mockAssertSameOrigin:         vi.fn(() => true),
  mockRateLimit:                vi.fn(() => ({ ok: true })),
  mockPrismaTenderCreate:       vi.fn(),
  mockPrismaTenderUpdate:       vi.fn(),
  mockPrismaTenderFindUnique:   vi.fn(),
  mockPrismaProductFindMany:    vi.fn(() => []),
  mockPrismaTenderVersionCreate:vi.fn(),
  mockPrismaAuditLogCreate:     vi.fn(),
  mockListTenderSnapshotsPage:  vi.fn(async (): Promise<{
    items: unknown[];
    totalCount: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }> => ({ items: [], totalCount: 0, page: 1, pageSize: 20, totalPages: 1 })),
  mockBuildTenderPreview:       vi.fn(),
  mockSanitizeTenderItemsText:  vi.fn(),
  mockValidateLineOverrideNos:  vi.fn((): { ok: boolean; error?: string } => ({ ok: true })),
}));

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/origin",     () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mockRateLimit }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tender:        { create: mockPrismaTenderCreate, update: mockPrismaTenderUpdate, findUnique: mockPrismaTenderFindUnique },
    product:       { findMany: mockPrismaProductFindMany },
    tenderVersion: { create: mockPrismaTenderVersionCreate },
    auditLog:      { create: mockPrismaAuditLogCreate },
  },
}));
vi.mock("@/lib/b2b-tender", () => ({
  listTenderSnapshotsPage:   mockListTenderSnapshotsPage,
  buildTenderPreview:        mockBuildTenderPreview,
  mapTenderStatusFromUi:     (s: string) => s.toUpperCase(),
  nextTenderNumber:          () => "TND-2026-0001",
}));
vi.mock("@/lib/tender-sanitization", () => ({
  sanitizeFreeText:          (v: string) => v,
  sanitizeTenderItemsText:   mockSanitizeTenderItemsText,
  validateLineOverrideNos:   mockValidateLineOverrideNos,
}));

import { GET, POST } from "./route";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ADMIN_SESSION = { user: { id: "u1", role: "ADMIN", email: "admin@nora.gh", name: "Admin" } };
const STAFF_SESSION = { user: { id: "u2", role: "STAFF", email: "staff@nora.gh", name: "Staff" } };
const CUSTOMER_SESSION = { user: { id: "u4", role: "CUSTOMER" } };

function makePreview(overrides = {}) {
  return {
    lines: [
      {
        no: 1,
        requestedDescription: "Paracetamol 500mg",
        requestedUnit: "box",
        quantity: 10,
        matchedProductId: "prod-1",
        matchedProductName: "Paracetamol 500mg",
        matchedSku: "PARA-500",
        availableStock: 100,
        baseCost: 2.0,
        marginPct: 50,
        unitPrice: 3.0,
        lineTotal: 30.0,
        matchConfidence: "HIGH",
        bidDisposition: "AVAILABLE",
        note: null,
      },
    ],
    subtotal: 30.0,
    total: 30.0,
    matchedCount: 1,
    unmatchedCount: 0,
    currency: "GHS",
    ...overrides,
  };
}

function makePostBody(overrides = {}) {
  return {
    buyerName: "Accra General Hospital",
    itemsText: "Paracetamol 500mg: 10",
    currency: "GHS",
    validityDays: 14,
    vatRatePct: 0,
    discountAmount: 0,
    freightAmount: 0,
    handlingAmount: 0,
    marginThresholdPct: 0,
    ...overrides,
  };
}

function makeRequest(url: string, body?: unknown) {
  if (!body) return new Request(`http://localhost${url}`);
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
  mockAssertSameOrigin.mockReturnValue(true);
  mockRateLimit.mockResolvedValue({ ok: true });
  mockSanitizeTenderItemsText.mockReturnValue({ text: "Paracetamol 500mg: 10", lineCount: 1 });
  mockValidateLineOverrideNos.mockReturnValue({ ok: true });
  mockBuildTenderPreview.mockResolvedValue(makePreview());
  mockPrismaProductFindMany.mockResolvedValue([]);
  mockPrismaTenderCreate.mockResolvedValue({});
  mockPrismaTenderVersionCreate.mockResolvedValue({});
  mockPrismaAuditLogCreate.mockResolvedValue({});
  mockListTenderSnapshotsPage.mockResolvedValue({ items: [], totalCount: 0, page: 1, pageSize: 20, totalPages: 1 });
});

// ─── GET ──────────────────────────────────────────────────────────────────────

describe("GET /api/admin/b2b/tenders — auth guards", () => {
  it("rejects unauthenticated requests", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("rejects CUSTOMER role", async () => {
    mockGetServerSession.mockResolvedValue(CUSTOMER_SESSION);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("allows ADMIN role", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    const res = await GET();
    expect(res.status).toBe(200);
  });

  it("allows STAFF role", async () => {
    mockGetServerSession.mockResolvedValue(STAFF_SESSION);
    const res = await GET();
    expect(res.status).toBe(200);
  });
});

describe("GET /api/admin/b2b/tenders — response shape", () => {
  it("returns pageable items from listTenderSnapshotsPage", async () => {
    const tenders = [{ id: "t1", tenderNumber: "TND-2026-0001", buyerName: "Clinic A" }];
    mockListTenderSnapshotsPage.mockResolvedValue({ items: tenders, totalCount: 1, page: 1, pageSize: 20, totalPages: 1 });
    const res  = await GET(makeRequest("/api/admin/b2b/tenders?page=1&pageSize=20&search=clinic&status=DRAFT"));
    const body = await res.json();
    expect(body.items).toEqual(tenders);
    expect(body.totalCount).toBe(1);
    expect(mockListTenderSnapshotsPage).toHaveBeenCalledWith({
      page: 1,
      pageSize: 20,
      search: "clinic",
      status: "DRAFT",
    });
  });
});

// ─── POST (create) ────────────────────────────────────────────────────────────

describe("POST /api/admin/b2b/tenders — auth guards", () => {
  it("rejects unauthenticated request", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await POST(makeRequest("/api/admin/b2b/tenders", makePostBody()));
    expect(res.status).toBe(401);
  });

  it("rejects bad origin", async () => {
    mockAssertSameOrigin.mockReturnValue(false);
    const res = await POST(makeRequest("/api/admin/b2b/tenders", makePostBody()));
    expect(res.status).toBe(403);
  });

  it("rejects when rate limited", async () => {
    mockRateLimit.mockResolvedValue({ ok: false });
    const res = await POST(makeRequest("/api/admin/b2b/tenders", makePostBody()));
    expect(res.status).toBe(429);
  });
});

describe("POST /api/admin/b2b/tenders — validation", () => {
  it("rejects missing buyerName", async () => {
    const res = await POST(makeRequest("/api/admin/b2b/tenders", { itemsText: "Para: 10" }));
    expect(res.status).toBe(400);
  });

  it("rejects empty itemsText", async () => {
    const res = await POST(makeRequest("/api/admin/b2b/tenders", { buyerName: "Clinic", itemsText: "" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when sanitizeTenderItemsText yields zero lines", async () => {
    mockSanitizeTenderItemsText.mockReturnValue({ text: "", lineCount: 0 });
    const res = await POST(makeRequest("/api/admin/b2b/tenders", makePostBody()));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/No valid item/i);
  });

  it("returns 400 when lineOverride nos are invalid", async () => {
    mockValidateLineOverrideNos.mockReturnValue({ ok: false, error: "Invalid line numbers" });
    const res = await POST(makeRequest("/api/admin/b2b/tenders", makePostBody({
      lineOverrides: [{ no: 999, unitPrice: 5 }],
    })));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid line/i);
  });
});

describe("POST /api/admin/b2b/tenders — margin enforcement", () => {
  it("returns 400 when a line is below margin threshold", async () => {
    mockBuildTenderPreview.mockResolvedValue(makePreview({
      lines: [{
        no: 1,
        requestedDescription: "Paracetamol 500mg",
        requestedUnit: "box",
        quantity: 10,
        matchedProductId: "prod-1",
        matchedProductName: "Paracetamol 500mg",
        matchedSku: "PARA-500",
        availableStock: 100,
        baseCost: 5.0,   // cost
        marginPct: -40,
        unitPrice: 3.0,  // price < cost → margin violation
        lineTotal: 30.0,
        matchConfidence: "HIGH",
        bidDisposition: "AVAILABLE",
        note: null,
      }],
    }));
    const res = await POST(makeRequest("/api/admin/b2b/tenders", makePostBody({ marginThresholdPct: 10 })));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/margin threshold/i);
    expect(body.marginViolations).toHaveLength(1);
  });

  it("allows a NO_BID line even when price is 0 (margin not checked)", async () => {
    mockBuildTenderPreview.mockResolvedValue(makePreview({
      lines: [{
        no: 1,
        requestedDescription: "Discontinued Item",
        requestedUnit: "box",
        quantity: 5,
        matchedProductId: null,
        matchedProductName: null,
        matchedSku: null,
        availableStock: 0,
        baseCost: 5.0,
        marginPct: null,
        unitPrice: 0,
        lineTotal: 0,
        matchConfidence: "NONE",
        bidDisposition: "NO_BID",
        note: null,
      }],
    }));
    const res = await POST(makeRequest("/api/admin/b2b/tenders", makePostBody({
      marginThresholdPct: 20,
      lineOverrides: [{ no: 1, bidDisposition: "NO_BID", unitPrice: 0 }],
    })));
    // Should NOT return 400 for margin on NO_BID lines
    expect(res.status).not.toBe(400);
  });
});

describe("POST /api/admin/b2b/tenders — OOS enforcement", () => {
  it("returns 400 when OOS line has no lead time + split note", async () => {
    mockBuildTenderPreview.mockResolvedValue(makePreview({
      lines: [{
        no: 1,
        requestedDescription: "Amoxicillin 250mg",
        requestedUnit: "bottle",
        quantity: 20,
        matchedProductId: "prod-2",
        matchedProductName: "Amoxicillin 250mg",
        matchedSku: "AMOX-250",
        availableStock: 5,  // OOS: qty 20 > stock 5
        baseCost: 1.5,
        marginPct: 33,
        unitPrice: 2.0,
        lineTotal: 40.0,
        matchConfidence: "HIGH",
        bidDisposition: "AVAILABLE",
        note: null,
      }],
    }));
    const res = await POST(makeRequest("/api/admin/b2b/tenders", makePostBody()));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/out-of-stock/i);
    expect(body.oosViolations).toHaveLength(1);
  });

  it("accepts OOS line when lead time + split note are provided", async () => {
    mockBuildTenderPreview.mockResolvedValue(makePreview({
      lines: [{
        no: 1,
        requestedDescription: "Amoxicillin 250mg",
        requestedUnit: "bottle",
        quantity: 20,
        matchedProductId: "prod-2",
        matchedProductName: "Amoxicillin 250mg",
        matchedSku: "AMOX-250",
        availableStock: 5,
        baseCost: 1.5,
        marginPct: 33,
        unitPrice: 2.0,
        lineTotal: 40.0,
        matchConfidence: "HIGH",
        bidDisposition: "AVAILABLE",
        note: null,
      }],
    }));
    const res = await POST(makeRequest("/api/admin/b2b/tenders", makePostBody({
      lineOverrides: [{
        no: 1,
        leadTimeDays: 14,
        supplyNote: "5 available now, 15 in 14 days",
        bidDisposition: "AVAILABLE",
      }],
    })));
    expect(res.status).toBe(200);
  });
});

describe("POST /api/admin/b2b/tenders — happy path create", () => {
  it("creates tender, version, and audit log on success", async () => {
    const res  = await POST(makeRequest("/api/admin/b2b/tenders", makePostBody()));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.snapshot).toBeDefined();
    expect(body.snapshot.tenderNumber).toBe("TND-2026-0001");

    expect(mockPrismaTenderCreate).toHaveBeenCalledOnce();
    expect(mockPrismaTenderVersionCreate).toHaveBeenCalledOnce();
    expect(mockPrismaAuditLogCreate).toHaveBeenCalledOnce();
  });

  it("audit log includes sourcePage: admin/b2b/tenders", async () => {
    await POST(makeRequest("/api/admin/b2b/tenders", makePostBody()));
    const auditCall = mockPrismaAuditLogCreate.mock.calls[0][0].data;
    const meta = JSON.parse(auditCall.meta);
    expect(meta.sourcePage).toBe("admin/b2b/tenders");
    expect(meta.actor.id).toBe("u1");
    expect(auditCall.outcome).toBe("SUCCESS");
  });

  it("audit log action is B2B_TENDER_SAVED for new tender", async () => {
    await POST(makeRequest("/api/admin/b2b/tenders", makePostBody()));
    const auditCall = mockPrismaAuditLogCreate.mock.calls[0][0].data;
    expect(auditCall.action).toBe("B2B_TENDER_SAVED");
  });
});

describe("POST /api/admin/b2b/tenders — happy path update", () => {
  it("updates an existing DRAFT tender and uses B2B_TENDER_UPDATED action", async () => {
    mockPrismaTenderFindUnique.mockResolvedValue({
      id: "t-existing",
      tenderNumber: "TND-2026-0001",
      status: "DRAFT",
      _count: { versions: 2 },
    });

    const res = await POST(makeRequest("/api/admin/b2b/tenders", makePostBody({ tenderId: "t-existing" })));
    expect(res.status).toBe(200);
    expect(mockPrismaTenderUpdate).toHaveBeenCalledOnce();

    const auditCall = mockPrismaAuditLogCreate.mock.calls[0][0].data;
    expect(auditCall.action).toBe("B2B_TENDER_UPDATED");
    const meta = JSON.parse(auditCall.meta);
    expect(meta.operation).toBe("update");
    expect(meta.versionNo).toBe(3);
  });

  it("returns 404 when tenderId not found", async () => {
    mockPrismaTenderFindUnique.mockResolvedValue(null);
    const res = await POST(makeRequest("/api/admin/b2b/tenders", makePostBody({ tenderId: "ghost" })));
    expect(res.status).toBe(404);
  });

  it("returns 409 when attempting to edit a non-DRAFT tender", async () => {
    mockPrismaTenderFindUnique.mockResolvedValue({
      id: "t-sent",
      tenderNumber: "TND-2026-0002",
      status: "SENT",
      _count: { versions: 1 },
    });
    const res = await POST(makeRequest("/api/admin/b2b/tenders", makePostBody({ tenderId: "t-sent" })));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/Only DRAFT/i);
  });
});
