import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockRecordAuditLog,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockAssertSameOrigin: vi.fn(),
  mockRecordAuditLog: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/origin", () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: mockRecordAuditLog }));

import { POST } from "./route";

const adminSession = {
  user: { id: "admin-1", role: "ADMIN", email: "admin@example.com", name: "Admin User" },
};

function makeRequest(body: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/admin/movements/detail-view", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      origin: "http://localhost",
      "user-agent": "vitest",
      "x-request-id": "req-1",
    },
    body: JSON.stringify({
      movementId: "mov-1",
      productId: "prod-1",
      productName: "Amoxicillin",
      productSku: "AMX-10",
      reason: "PURCHASE",
      delta: 12,
      createdAt: "2026-04-08T12:00:00.000Z",
      lotCode: "LOT-123",
      expiryDate: "2027-01-01T00:00:00.000Z",
      supplier: "Med Supply",
      hasNote: true,
      hasUnitCost: true,
      filters: { start: "2026-04-01", end: "2026-04-08", product: "prod-1", reason: "PURCHASE", lotId: "lot-1" },
      page: 2,
      pageSize: 50,
      totalRows: 83,
      sortBy: "productName",
      sortDir: "asc",
      ...body,
    }),
  });
}

describe("POST /api/admin/movements/detail-view", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetServerSession.mockResolvedValue(adminSession);
    mockAssertSameOrigin.mockReturnValue(true);
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetServerSession.mockResolvedValue(null);

    const res = await POST(makeRequest());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("returns 403 when origin validation fails", async () => {
    mockAssertSameOrigin.mockReturnValue(false);

    const res = await POST(makeRequest());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Bad origin" });
  });

  it("records enriched audit metadata for detail views", async () => {
    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockRecordAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      actorId: "admin-1",
      action: "INVENTORY_MOVEMENT_VIEW_DETAIL",
      entityType: "InventoryMovement",
      entityId: "mov-1",
      outcome: "SUCCESS",
      meta: expect.objectContaining({
        sourcePage: "admin/movements",
        section: "movement-detail",
        operation: "view_movement_detail",
        resultSummary: "Viewed movement detail for Amoxicillin.",
        movement: expect.objectContaining({
          id: "mov-1",
          productId: "prod-1",
          productName: "Amoxicillin",
          reason: "PURCHASE",
          delta: 12,
          supplier: "Med Supply",
        }),
        sensitiveFieldsViewed: {
          note: true,
          supplier: true,
          unitCost: true,
          lot: true,
          expiry: true,
        },
        filters: {
          start: "2026-04-01",
          end: "2026-04-08",
          product: "prod-1",
          reason: "PURCHASE",
          lotId: "lot-1",
        },
        pagination: {
          page: 2,
          pageSize: 50,
          totalRows: 83,
        },
        sorting: {
          sortBy: "productName",
          sortDir: "asc",
        },
      }),
      request: expect.any(Request),
    }));
  });
});
