import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";

const patchSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  leadTimeDays: z.number().int().min(1).max(365).optional(),
  leadTimeMinDays: z.number().int().min(1).max(365).optional().nullable(),
  leadTimeMaxDays: z.number().int().min(1).max(365).optional().nullable(),
  status: z.enum(["ACTIVE", "INACTIVE", "ON_HOLD"]).optional(),
  restore: z.boolean().optional(),
  contactName: z.string().min(2).max(120).optional().nullable(),
  email: z.string().email().optional().nullable(),
  phone: z.string().min(5).max(40).optional().nullable(),
  address: z.string().min(2).max(200).optional().nullable(),
  website: z.string().url().optional().nullable(),
  paymentTerms: z.string().min(2).max(120).optional().nullable(),
  taxId: z.string().min(2).max(80).optional().nullable(),
  currency: z.string().min(2).max(8).optional().nullable(),
  notes: z.string().min(2).max(1000).optional().nullable(),
  defaultMinOrderQty: z.number().int().min(1).max(100000).optional(),
  defaultPackSize: z.number().int().min(1).max(100000).optional(),
});

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const resolvedParams = await params;
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-suppliers-update", 60_000, 30);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  try {
    const body = await req.json();
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }
    if (
      parsed.data.leadTimeMinDays != null &&
      parsed.data.leadTimeMaxDays != null &&
      parsed.data.leadTimeMinDays > parsed.data.leadTimeMaxDays
    ) {
      return NextResponse.json({ error: "Lead time min cannot exceed max." }, { status: 400 });
    }

    const supplier = await prisma.supplier.update({
      where: { id: resolvedParams.id },
      data: parsed.data.restore
        ? {
            deletedAt: null,
            status: "ACTIVE",
          }
        : parsed.data,
    });

    try {
      await recordAuditLog({
        actorId: (session.user as AuthenticatedUser).id,
        action: parsed.data.restore ? "SUPPLIER_RESTORE" : "SUPPLIER_UPDATE",
        entityType: "SUPPLIER",
        entityId: supplier.id,
        meta: {
          name: supplier.name,
          leadTimeDays: supplier.leadTimeDays,
          leadTimeMinDays: supplier.leadTimeMinDays,
          leadTimeMaxDays: supplier.leadTimeMaxDays,
          status: supplier.status,
        },
      });
    } catch {
      // best-effort
    }

    return NextResponse.json(supplier);
  } catch (error) {
    console.error("Supplier update error:", error);
    return NextResponse.json({ error: "Failed to update supplier" }, { status: 500 });
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const resolvedParams = await params;
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-suppliers-delete", 60_000, 20);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  try {
    const supplier = await prisma.supplier.update({
      where: { id: resolvedParams.id },
      data: {
        deletedAt: new Date(),
        status: "INACTIVE",
      },
    });

    try {
      await recordAuditLog({
        actorId: (session.user as AuthenticatedUser).id,
        action: "SUPPLIER_SOFT_DELETE",
        entityType: "SUPPLIER",
        entityId: supplier.id,
        meta: { name: supplier.name, leadTimeDays: supplier.leadTimeDays },
      });
    } catch {
      // best-effort
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Supplier delete error:", error);
    return NextResponse.json({ error: "Failed to delete supplier" }, { status: 500 });
  }
}
