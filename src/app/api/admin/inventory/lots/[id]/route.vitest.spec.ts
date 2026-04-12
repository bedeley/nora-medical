import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetServerSession,
  mockInventoryLotFindUnique,
  mockInventoryMovementCount,
  mockInventoryMovementFindMany,
  mockRecordAuditLog,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockInventoryLotFindUnique: vi.fn(),
  mockInventoryMovementCount: vi.fn(),
  mockInventoryMovementFindMany: vi.fn(),
  mockRecordAuditLog: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: mockRecordAuditLog }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    inventoryLot: {
      findUnique: mockInventoryLotFindUnique,
    },
    inventoryMovement: {
      count: mockInventoryMovementCount,
      findMany: mockInventoryMovementFindMany,
    },
  },
}));

import { GET } from "./route";

const accountantSession = {
  user: { id: "acct-1", role: "ACCOUNTANT", email: "acct@example.com", name: "Acct User" },
};

describe("GET /api/admin/inventory/lots/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetServerSession.mockResolvedValue(accountantSession);
    mockRecordAuditLog.mockResolvedValue(undefined);
    mockInventoryLotFindUnique.mockResolvedValue({
      id: "lot-1",
      productId: "prod-1",
      lotCode: "LOT-1",
      expiryDate: new Date("2027-01-01T00:00:00.000Z"),
      receivedAt: new Date("2026-04-01T09:00:00.000Z"),
      quantityReceived: 100,
      quantityRemaining: 45,
      notes: "Primary batch",
      supplier: { id: "sup-1", name: "Med Supply" },
      product: {
        id: "prod-1",
        name: "Amoxicillin",
        sku: "AMX-10",
        requiresLotTracking: true,
        requiresExpiryDate: true,
      },
      purchase: null,
    });
    mockInventoryMovementCount.mockResolvedValue(250);
    mockInventoryMovementFindMany.mockResolvedValue([
      {
        id: "mov-1",
        reason: "PURCHASE",
        reasonCode: "PURCHASE",
        delta: 100,
        note: "Received",
        purchaseId: "pur-1",
        createdAt: new Date("2026-04-01T09:00:00.000Z"),
      },
    ]);
  });

  it("records an audit entry when a lot trace is viewed", async () => {
    const req = new Request("http://localhost/api/admin/inventory/lots/lot-1");

    const res = await GET(req, { params: Promise.resolve({ id: "lot-1" }) });

    expect(res.status).toBe(200);
    expect(mockRecordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "acct-1",
        action: "INVENTORY_LOT_TRACE_VIEWED",
        entityType: "INVENTORY_LOT",
        entityId: "lot-1",
        request: req,
        outcome: "SUCCESS",
        meta: expect.objectContaining({
          sourcePage: "admin/inventory-lots",
          section: "trace",
          operation: "view",
          lotCode: "LOT-1",
          productId: "prod-1",
          movementTotal: 250,
          movementsReturned: 1,
          movementsTruncated: true,
        }),
      }),
    );
  });
});
