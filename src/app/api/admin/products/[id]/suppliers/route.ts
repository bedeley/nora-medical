import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";

const linkSchema = z.object({
  supplierId: z.string().min(1),
  isPrimary: z.boolean().optional(),
  leadTimeDays: z.number().int().min(1).max(365).optional().nullable(),
  minOrderQty: z.number().int().min(1).max(100000).optional().nullable(),
  packSize: z.number().int().min(1).max(100000).optional().nullable(),
});

function canRead(role?: string) {
  return role === "ADMIN" || role === "STAFF" || role === "ACCOUNTANT";
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions);
  const role = (session?.user as AuthenticatedUser | undefined)?.role;
  if (!session || !canRead(role)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const links = await prisma.productSupplier.findMany({
    where: { productId: id },
    include: { supplier: { select: { id: true, name: true, leadTimeDays: true } } },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
  });
  return NextResponse.json({ rows: links });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(req, "admin-product-suppliers", 60_000, 60);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  const { id } = await params;
  const body = await req.json();
  const parsed = linkSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  const [product, supplier, existingLink] = await Promise.all([
    prisma.product.findUnique({
      where: { id },
      select: { id: true, name: true, sku: true, supplierId: true },
    }),
    prisma.supplier.findUnique({
      where: { id: parsed.data.supplierId },
      select: { id: true, name: true },
    }),
    prisma.productSupplier.findUnique({
      where: { productId_supplierId: { productId: id, supplierId: parsed.data.supplierId } },
      select: {
        supplierId: true,
        isPrimary: true,
        leadTimeDays: true,
        minOrderQty: true,
        packSize: true,
      },
    }),
  ]);
  if (!product) {
    return NextResponse.json({ error: "Product not found" }, { status: 404 });
  }
  if (!supplier) {
    return NextResponse.json({ error: "Supplier not found" }, { status: 404 });
  }

  const link = await prisma.productSupplier.upsert({
    where: { productId_supplierId: { productId: id, supplierId: parsed.data.supplierId } },
    create: {
      productId: id,
      supplierId: parsed.data.supplierId,
      isPrimary: Boolean(parsed.data.isPrimary),
      leadTimeDays: parsed.data.leadTimeDays ?? undefined,
      minOrderQty: parsed.data.minOrderQty ?? undefined,
      packSize: parsed.data.packSize ?? undefined,
    },
    update: {
      isPrimary: parsed.data.isPrimary ?? false,
      leadTimeDays: parsed.data.leadTimeDays ?? undefined,
      minOrderQty: parsed.data.minOrderQty ?? undefined,
      packSize: parsed.data.packSize ?? undefined,
    },
  });

  if (parsed.data.isPrimary) {
    await prisma.product.update({
      where: { id },
      data: { supplierId: parsed.data.supplierId },
    });
    await prisma.productSupplier.updateMany({
      where: { productId: id, supplierId: { not: parsed.data.supplierId } },
      data: { isPrimary: false },
    });
  }

  try {
    await recordAuditLog({
      actorId: user?.id,
      action: existingLink ? "PRODUCT_SUPPLIER_LINK_UPDATE" : "PRODUCT_SUPPLIER_LINK_CREATE",
      entityType: "PRODUCT",
      entityId: id,
      request: req,
      meta: {
        productName: product.name,
        productSku: product.sku ?? null,
        supplierId: supplier.id,
        supplierName: supplier.name,
        previousPrimarySupplierId: product.supplierId ?? null,
        before: existingLink
          ? {
              isPrimary: Boolean(existingLink.isPrimary),
              leadTimeDays: existingLink.leadTimeDays ?? null,
              minOrderQty: existingLink.minOrderQty ?? null,
              packSize: existingLink.packSize ?? null,
            }
          : null,
        after: {
          isPrimary: Boolean(link.isPrimary),
          leadTimeDays: link.leadTimeDays ?? null,
          minOrderQty: link.minOrderQty ?? null,
          packSize: link.packSize ?? null,
        },
      },
    });
  } catch {
    // best-effort
  }

  return NextResponse.json({ ok: true, link });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(req, "admin-product-suppliers-delete", 60_000, 60);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const supplierId = String(body.supplierId || "").trim();
  if (!supplierId) {
    return NextResponse.json({ error: "supplierId is required" }, { status: 400 });
  }
  const [product, existingLink] = await Promise.all([
    prisma.product.findUnique({
      where: { id },
      select: { id: true, name: true, sku: true, supplierId: true },
    }),
    prisma.productSupplier.findUnique({
      where: { productId_supplierId: { productId: id, supplierId } },
      include: { supplier: { select: { id: true, name: true } } },
    }),
  ]);
  if (!product) {
    return NextResponse.json({ error: "Product not found" }, { status: 404 });
  }
  if (!existingLink) {
    return NextResponse.json({ error: "Supplier link not found" }, { status: 404 });
  }
  await prisma.productSupplier.delete({
    where: { productId_supplierId: { productId: id, supplierId } },
  });
  try {
    await recordAuditLog({
      actorId: user?.id,
      action: "PRODUCT_SUPPLIER_LINK_DELETE",
      entityType: "PRODUCT",
      entityId: id,
      request: req,
      meta: {
        productName: product.name,
        productSku: product.sku ?? null,
        supplierId: existingLink.supplier.id,
        supplierName: existingLink.supplier.name,
        wasPrimary: Boolean(existingLink.isPrimary),
        removedLink: {
          leadTimeDays: existingLink.leadTimeDays ?? null,
          minOrderQty: existingLink.minOrderQty ?? null,
          packSize: existingLink.packSize ?? null,
        },
      },
    });
  } catch {
    // best-effort
  }
  return NextResponse.json({ ok: true });
}
