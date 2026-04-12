import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockRateLimit,
  mockTransaction,
  mockPurchaseUpdate,
  mockRecordAuditLog,
  mockHasPermission,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockAssertSameOrigin: vi.fn(),
  mockRateLimit: vi.fn(),
  mockTransaction: vi.fn(),
  mockPurchaseUpdate: vi.fn(),
  mockRecordAuditLog: vi.fn(),
  mockHasPermission: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/origin", () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mockRateLimit }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: mockRecordAuditLog }));
vi.mock("@/lib/permissions", () => ({ hasPermission: mockHasPermission }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mockTransaction,
  },
}));

import { POST } from "./route";

const ADMIN_SESSION = { user: { id: "u1", role: "ADMIN" } };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
  mockAssertSameOrigin.mockReturnValue(true);
  mockRateLimit.mockResolvedValue({ ok: true });
  mockHasPermission.mockReturnValue(true);
  mockTransaction.mockImplementation(async (callback: (tx: { purchase: { update: typeof mockPurchaseUpdate } }) => Promise<unknown>) =>
    callback({ purchase: { update: mockPurchaseUpdate } }),
  );
  mockPurchaseUpdate.mockResolvedValue(undefined);
});

describe("POST /api/admin/purchases/bulk-supplier/undo", () => {
  it("records enriched audit metadata on success", async () => {
    const rows = [
      { id: "purchase-1", supplierId: "sup-1", supplier: "MedSupply Ltd" },
      { id: "purchase-2", supplierId: null, supplier: null },
    ];
    const req = new Request("http://localhost:3000/api/admin/purchases/bulk-supplier/undo", {
      method: "POST",
      headers: { "Content-Type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ rows }),
    });

    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockPurchaseUpdate).toHaveBeenCalledTimes(2);
    expect(mockRecordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "PURCHASE_BULK_SUPPLIER_ASSIGN_UNDO",
        entityId: "BULK",
        meta: expect.objectContaining({
          restoredCount: 2,
          rowIds: ["purchase-1", "purchase-2"],
          restoredRows: [
            { id: "purchase-1", supplierId: "sup-1", supplierName: "MedSupply Ltd" },
            { id: "purchase-2", supplierId: null, supplierName: null },
          ],
          source: "PURCHASE_BULK_SUPPLIER_ASSIGN_UNDO",
        }),
      }),
    );
  });
});
