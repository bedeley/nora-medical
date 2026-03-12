import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";

const createSchema = z.object({
  name: z.string().min(2).max(120),
  leadTimeDays: z.number().int().min(1).max(365),
  leadTimeMinDays: z.number().int().min(1).max(365).optional(),
  leadTimeMaxDays: z.number().int().min(1).max(365).optional(),
  status: z.enum(["ACTIVE", "INACTIVE", "ON_HOLD"]).optional(),
  contactName: z.string().min(2).max(120).optional(),
  email: z.string().email().optional(),
  phone: z.string().min(5).max(40).optional(),
  address: z.string().min(2).max(200).optional(),
  website: z.string().url().optional(),
  paymentTerms: z.string().min(2).max(120).optional(),
  taxId: z.string().min(2).max(80).optional(),
  currency: z.string().min(2).max(8).optional(),
  notes: z.string().min(2).max(1000).optional(),
  defaultMinOrderQty: z.number().int().min(1).max(100000).optional(),
  defaultPackSize: z.number().int().min(1).max(100000).optional(),
});

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { searchParams } = new URL(req.url);
  const includeDeleted = searchParams.get("includeDeleted") === "1";
  const limited = await rateLimit(req, "admin-suppliers-list", 60_000, 60);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const suppliers = await prisma.supplier.findMany({
    where: includeDeleted ? undefined : { deletedAt: null },
    orderBy: { name: "asc" },
  });
  return NextResponse.json({ rows: suppliers });
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-suppliers-create", 60_000, 30);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  try {
    const body = await req.json();
    const parsed = createSchema.safeParse(body);
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

    const supplier = await prisma.supplier.create({
      data: {
        name: parsed.data.name.trim(),
        leadTimeDays: parsed.data.leadTimeDays,
        leadTimeMinDays: parsed.data.leadTimeMinDays,
        leadTimeMaxDays: parsed.data.leadTimeMaxDays,
        status: parsed.data.status,
        contactName: parsed.data.contactName?.trim(),
        email: parsed.data.email?.trim(),
        phone: parsed.data.phone?.trim(),
        address: parsed.data.address?.trim(),
        website: parsed.data.website?.trim(),
        paymentTerms: parsed.data.paymentTerms?.trim(),
        taxId: parsed.data.taxId?.trim(),
        currency: parsed.data.currency?.trim(),
        notes: parsed.data.notes?.trim(),
        defaultMinOrderQty: parsed.data.defaultMinOrderQty,
        defaultPackSize: parsed.data.defaultPackSize,
      },
    });

    try {
      await recordAuditLog({
        actorId: (session.user as AuthenticatedUser).id,
        action: "SUPPLIER_CREATE",
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

    return NextResponse.json(supplier, { status: 201 });
  } catch (error) {
    console.error("Supplier create error:", error);
    return NextResponse.json({ error: "Failed to create supplier" }, { status: 500 });
  }
}
