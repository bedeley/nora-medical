import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";

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
  await prisma.productSupplier.delete({
    where: { productId_supplierId: { productId: id, supplierId } },
  });
  return NextResponse.json({ ok: true });
}
