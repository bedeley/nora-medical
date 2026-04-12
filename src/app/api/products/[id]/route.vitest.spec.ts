import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetServerSession,
  mockAssertSameOrigin,
  mockRateLimit,
  mockNotifyBackInStock,
  mockRecordAuditLog,
  mockGetMarginGuardError,
  mockPrismaProductFindUnique,
  mockPrismaProductUpdate,
  mockPrismaSupplierFindUnique,
  mockPrismaSupplierUpsert,
  mockPrismaInventoryMovementCreate,
  mockPrismaProductSupplierUpdateMany,
  mockPrismaProductSupplierUpsert,
  mockPrismaTransaction,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockAssertSameOrigin: vi.fn(),
  mockRateLimit: vi.fn(),
  mockNotifyBackInStock: vi.fn(),
  mockRecordAuditLog: vi.fn(),
  mockGetMarginGuardError: vi.fn(),
  mockPrismaProductFindUnique: vi.fn(),
  mockPrismaProductUpdate: vi.fn(),
  mockPrismaSupplierFindUnique: vi.fn(),
  mockPrismaSupplierUpsert: vi.fn(),
  mockPrismaInventoryMovementCreate: vi.fn(),
  mockPrismaProductSupplierUpdateMany: vi.fn(),
  mockPrismaProductSupplierUpsert: vi.fn(),
  mockPrismaTransaction: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("../route", async () => {
  const { z } = await import("zod");
  return {
    productSchema: z.object({
      name: z.string(),
      description: z.string(),
      imageUrl: z.string(),
      category: z.string(),
      brand: z.string(),
      supplier: z.string().optional(),
      supplierId: z.string().nullable().optional(),
      marginOverrideReason: z.string().optional(),
      minMarginPct: z.number().nullable().optional(),
      price: z.number(),
      cost: z.number(),
      stock: z.number(),
      receiveNow: z.boolean().optional(),
      paidOnReceipt: z.boolean().optional(),
      paymentMethod: z.enum(["cash", "transfer", "bank", "credit"]).optional(),
      lotCode: z.string().optional(),
      expiryDate: z.string().optional(),
      requiresLotTracking: z.boolean().optional(),
      requiresExpiryDate: z.boolean().optional(),
    }),
  };
});
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/origin", () => ({ assertSameOrigin: mockAssertSameOrigin }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mockRateLimit }));
vi.mock("@/lib/stock-alerts", () => ({ notifyBackInStock: mockNotifyBackInStock }));
vi.mock("@/lib/audit-log", () => ({ recordAuditLog: mockRecordAuditLog }));
vi.mock("@/lib/margin-guard", () => ({ getMarginGuardError: mockGetMarginGuardError }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    product: {
      findUnique: mockPrismaProductFindUnique,
      update: mockPrismaProductUpdate,
    },
    supplier: {
      findUnique: mockPrismaSupplierFindUnique,
      upsert: mockPrismaSupplierUpsert,
    },
    inventoryMovement: {
      create: mockPrismaInventoryMovementCreate,
    },
    productSupplier: {
      updateMany: mockPrismaProductSupplierUpdateMany,
      upsert: mockPrismaProductSupplierUpsert,
    },
    $transaction: mockPrismaTransaction,
  },
}));

import { PATCH } from "./route";
import { DELETE } from "./route";

const ADMIN_SESSION = { user: { id: "admin-1", role: "ADMIN" } };

const existingProduct = {
  id: "prod-1",
  stock: 0,
  archived: false,
  name: "Sterile Gloves",
  description: "Powder-free sterile gloves",
  imageUrl: "/images/gloves.png",
  price: 20,
  cost: 10,
  minMarginPct: 5,
  category: "ppe",
  brand: "Noralls",
  supplier: "MedSupply Co",
  supplierId: "sup-1",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  requiresLotTracking: false,
  requiresExpiryDate: false,
};

function makeRequest(body: unknown, origin = "http://localhost:3000") {
  return new Request(`${origin}/api/products/prod-1`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      origin,
    },
    body: JSON.stringify(body),
  });
}

function makeDeleteRequest(body: unknown, origin = "http://localhost:3000") {
  return new Request(`${origin}/api/products/prod-1`, {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      origin,
    },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/products/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockAssertSameOrigin.mockReturnValue(true);
    mockRateLimit.mockResolvedValue({ ok: true });
    mockGetMarginGuardError.mockReturnValue(null);
    mockPrismaProductFindUnique.mockResolvedValue(existingProduct);
    mockPrismaProductUpdate.mockResolvedValue({
      ...existingProduct,
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    });
    mockPrismaSupplierFindUnique.mockResolvedValue(null);
    mockPrismaSupplierUpsert.mockResolvedValue({ id: "sup-1" });
    mockPrismaInventoryMovementCreate.mockResolvedValue({});
    mockPrismaProductSupplierUpdateMany.mockResolvedValue({});
    mockPrismaProductSupplierUpsert.mockResolvedValue({});
    mockPrismaTransaction.mockResolvedValue(undefined);
    mockNotifyBackInStock.mockResolvedValue(undefined);
    mockRecordAuditLog.mockResolvedValue(undefined);
  });

  it("requires an edit reason when changing the minimum margin", async () => {
    const res = await PATCH(makeRequest({ minMarginPct: 12 }), {
      params: Promise.resolve({ id: "prod-1" }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "Please add a brief reason for this change.",
    });
    expect(mockPrismaProductUpdate).not.toHaveBeenCalled();
  });

  it("requires an edit reason when archiving a product", async () => {
    const res = await PATCH(makeRequest({ archived: true }), {
      params: Promise.resolve({ id: "prod-1" }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "Please add a brief reason for this change.",
    });
    expect(mockPrismaProductUpdate).not.toHaveBeenCalled();
  });

  it("audits minimum margin changes when the request is valid", async () => {
    mockPrismaProductUpdate.mockResolvedValue({
      ...existingProduct,
      minMarginPct: 12,
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    });

    const res = await PATCH(
      makeRequest({ minMarginPct: 12, editReason: "Quarterly pricing review" }),
      { params: Promise.resolve({ id: "prod-1" }) },
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ success: true });
    expect(mockPrismaProductUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "prod-1" },
        data: expect.objectContaining({ minMarginPct: 12 }),
      }),
    );
    expect(mockRecordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "PRODUCT_UPDATE",
        entityId: "prod-1",
        meta: expect.objectContaining({
          reason: "Quarterly pricing review",
          changes: expect.objectContaining({
            minMarginPct: { from: 5, to: 12 },
          }),
        }),
      }),
    );
  });

  it("requires a delete reason when removing a product", async () => {
    const res = await DELETE(makeDeleteRequest({}), {
      params: Promise.resolve({ id: "prod-1" }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "Please provide a brief delete reason.",
    });
  });

  it("records delete audit metadata when removing a product", async () => {
    mockPrismaTransaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({
      cartItem: { deleteMany: vi.fn().mockResolvedValue({ count: 2 }) },
      stockAlert: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      orderItem: { count: vi.fn().mockResolvedValue(0) },
      purchase: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      inventoryMovement: { create: vi.fn().mockResolvedValue({}) },
      product: { update: vi.fn().mockResolvedValue({}) },
    }));

    const res = await DELETE(makeDeleteRequest({ reason: "Duplicate catalog entry" }), {
      params: Promise.resolve({ id: "prod-1" }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ success: true, deletedId: "prod-1" });
    expect(mockRecordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "PRODUCT_DELETE",
        entityId: "prod-1",
        meta: expect.objectContaining({
          name: "Sterile Gloves",
          sku: null,
          supplierId: "sup-1",
          deleteReason: "Duplicate catalog entry",
          removedCartItems: 2,
          updatedStockAlerts: 1,
          orderHistoryCount: 0,
        }),
      }),
    );
  });
});
