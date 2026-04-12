import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { recordAuditLog } from "@/lib/audit-log";
import { assertSameOrigin } from "@/lib/origin";

const payloadSchema = z.object({
  movementId: z.string().min(1).max(191),
  productId: z.string().min(1).max(191),
  productName: z.string().min(1).max(200),
  productSku: z.string().max(120).nullable().optional(),
  reason: z.string().min(1).max(120),
  delta: z.number().int(),
  createdAt: z.string().min(1).max(64),
  lotCode: z.string().max(120).nullable().optional(),
  expiryDate: z.string().max(64).nullable().optional(),
  supplier: z.string().max(200).nullable().optional(),
  hasNote: z.boolean(),
  hasUnitCost: z.boolean(),
  filters: z.object({
    start: z.string().max(40).optional().default(""),
    end: z.string().max(40).optional().default(""),
    product: z.string().max(191).optional().default(""),
    reason: z.string().max(120).optional().default(""),
    lotId: z.string().max(191).optional().default(""),
  }).optional().default({ start: "", end: "", product: "", reason: "", lotId: "" }),
  page: z.number().int().min(1).max(100000).optional().default(1),
  pageSize: z.number().int().min(1).max(100).optional().default(50),
  totalRows: z.number().int().min(0).optional().default(0),
  sortBy: z.enum(["createdAt", "productName", "delta", "reason", "expiryDate"]).optional().default("createdAt"),
  sortDir: z.enum(["asc", "desc"]).optional().default("desc"),
});

async function requireMovementAuditUser() {
  const session = await getServerSession(authOptions);
  if (!session) return null;
  const user = session.user as AuthenticatedUser;
  if (!["ADMIN", "ACCOUNTANT", "STAFF"].includes(user.role)) return null;
  return user;
}

export async function POST(req: Request) {
  const user = await requireMovementAuditUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const parsed = payloadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  const data = parsed.data;
  await recordAuditLog({
    actorId: user.id,
    action: "INVENTORY_MOVEMENT_VIEW_DETAIL",
    entityType: "InventoryMovement",
    entityId: data.movementId,
    meta: {
      actor: {
        id: user.id,
        role: user.role,
        email: user.email ?? null,
        name: user.name ?? null,
      },
      sourcePage: "admin/movements",
      section: "movement-detail",
      operation: "view_movement_detail",
      status: "SUCCESS",
      resultSummary: `Viewed movement detail for ${data.productName}.`,
      movement: {
        id: data.movementId,
        productId: data.productId,
        productName: data.productName,
        productSku: data.productSku ?? null,
        reason: data.reason,
        delta: data.delta,
        createdAt: data.createdAt,
        lotCode: data.lotCode ?? null,
        expiryDate: data.expiryDate ?? null,
        supplier: data.supplier ?? null,
      },
      sensitiveFieldsViewed: {
        note: data.hasNote,
        supplier: Boolean(data.supplier),
        unitCost: data.hasUnitCost,
        lot: Boolean(data.lotCode),
        expiry: Boolean(data.expiryDate),
      },
      filters: data.filters,
      pagination: {
        page: data.page,
        pageSize: data.pageSize,
        totalRows: data.totalRows,
      },
      sorting: {
        sortBy: data.sortBy,
        sortDir: data.sortDir,
      },
    },
    request: req,
    outcome: "SUCCESS",
  });

  return NextResponse.json({ ok: true });
}
