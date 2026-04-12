import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockRateLimit,
  mockRecordAuditLog,
  mockProductFindUnique,
  mockSupplierFindUnique,
  mockProductSupplierFindUnique,
  mockProductSupplierFindMany,
  mockProductSupplierUpsert,
  mockProductSupplierUpdateMany,
  mockProductSupplierDelete,
  mockProductUpdate,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockAssertSameOrigin: vi.fn(),
  mockRateLimit: vi.fn(),
  mockRecordAuditLog: vi.fn(),
  mockProductFindUnique: vi.fn(),
  mockSupplierFindUnique: vi.fn(),
  mockProductSupplierFindUnique: vi.fn(),
  mockProductSupplierFindMany: vi.fn(),
  mockProductSupplierUpsert: vi.fn(),
  mockProductSupplierUpdateMany: vi.fn(),
  mockProductSupplierDelete: vi.fn(),
  mockProductUpdate: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/origin", () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mockRateLimit }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: mockRecordAuditLog }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    product: {
      findUnique: mockProductFindUnique,
      update: mockProductUpdate,
    },
    supplier: {
      findUnique: mockSupplierFindUnique,
    },
    productSupplier: {
      findUnique: mockProductSupplierFindUnique,
      findMany: mockProductSupplierFindMany,
      upsert: mockProductSupplierUpsert,
      updateMany: mockProductSupplierUpdateMany,
      delete: mockProductSupplierDelete,
    },
  },
}));

import { DELETE, POST } from "./route";

const ADMIN_SESSION = { user: { id: "admin-1", role: "ADMIN" } };

describe("POST /api/admin/products/[id]/suppliers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockAssertSameOrigin.mockReturnValue(true);
    mockRateLimit.mockResolvedValue({ ok: true });
    mockProductFindUnique.mockResolvedValue({
      id: "prod-1",
      name: "Sterile Gloves",
      sku: "MED-001",
      supplierId: "sup-old",
    });
    mockSupplierFindUnique.mockResolvedValue({
      id: "sup-1",
      name: "MedSupply Co",
    });
    mockProductSupplierFindUnique.mockResolvedValue(null);
    mockProductSupplierUpsert.mockResolvedValue({
      supplierId: "sup-1",
      isPrimary: true,
      leadTimeDays: 14,
      minOrderQty: 10,
      packSize: 20,
    });
    mockProductSupplierUpdateMany.mockResolvedValue({ count: 1 });
    mockProductUpdate.mockResolvedValue({});
    mockRecordAuditLog.mockResolvedValue(undefined);
  });

  it("records audit metadata when a supplier link is created", async () => {
    const res = await POST(
      new Request("http://localhost:3000/api/admin/products/prod-1/suppliers", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          origin: "http://localhost:3000",
        },
        body: JSON.stringify({
          supplierId: "sup-1",
          isPrimary: true,
          leadTimeDays: 14,
          minOrderQty: 10,
          packSize: 20,
        }),
      }),
      { params: Promise.resolve({ id: "prod-1" }) },
    );

    expect(res.status).toBe(200);
    expect(mockRecordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "PRODUCT_SUPPLIER_LINK_CREATE",
        entityId: "prod-1",
        meta: expect.objectContaining({
          productName: "Sterile Gloves",
          productSku: "MED-001",
          supplierId: "sup-1",
          supplierName: "MedSupply Co",
          after: expect.objectContaining({
            isPrimary: true,
            leadTimeDays: 14,
            minOrderQty: 10,
            packSize: 20,
          }),
        }),
      }),
    );
  });
});

describe("DELETE /api/admin/products/[id]/suppliers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockAssertSameOrigin.mockReturnValue(true);
    mockRateLimit.mockResolvedValue({ ok: true });
    mockProductFindUnique.mockResolvedValue({
      id: "prod-1",
      name: "Sterile Gloves",
      sku: "MED-001",
      supplierId: "sup-1",
    });
    mockProductSupplierFindUnique.mockResolvedValue({
      supplierId: "sup-1",
      isPrimary: false,
      leadTimeDays: 14,
      minOrderQty: 10,
      packSize: 20,
      supplier: {
        id: "sup-1",
        name: "MedSupply Co",
      },
    });
    mockProductSupplierDelete.mockResolvedValue({});
    mockRecordAuditLog.mockResolvedValue(undefined);
  });

  it("records audit metadata when a supplier link is removed", async () => {
    const res = await DELETE(
      new Request("http://localhost:3000/api/admin/products/prod-1/suppliers", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          origin: "http://localhost:3000",
        },
        body: JSON.stringify({ supplierId: "sup-1" }),
      }),
      { params: Promise.resolve({ id: "prod-1" }) },
    );

    expect(res.status).toBe(200);
    expect(mockRecordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "PRODUCT_SUPPLIER_LINK_DELETE",
        entityId: "prod-1",
        meta: expect.objectContaining({
          productName: "Sterile Gloves",
          productSku: "MED-001",
          supplierId: "sup-1",
          supplierName: "MedSupply Co",
          wasPrimary: false,
          removedLink: expect.objectContaining({
            leadTimeDays: 14,
            minOrderQty: 10,
            packSize: 20,
          }),
        }),
      }),
    );
  });
});
