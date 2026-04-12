import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { getCustomerProfileType, setCustomerProfileType, type CustomerProfileType } from "@/lib/customer-profile";
import { recordAuditLog } from "@/lib/audit-log";
import { buildCustomerActorTargetMeta } from "@/lib/customer-account-policy";

const schema = z.object({
  profile: z.enum(["B2B", "B2C"]),
});

function hasAdminCustomerAccess(role?: string | null) {
  return role === "ADMIN" || role === "STAFF" || role === "ACCOUNTANT";
}

function canManageCustomerProfile(role?: string | null) {
  return role === "ADMIN" || role === "STAFF";
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> | { id: string } },
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !hasAdminCustomerAccess(user?.role || null)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = await context.params;
  const targetUser = await prisma.user.findUnique({
    where: { id: params.id },
    select: {
      id: true,
      role: true,
      email: true,
      name: true,
      phone: true,
      archived: true,
      deletedAt: true,
      createdAt: true,
      lastLoginAt: true,
    },
  });
  if (!targetUser) return NextResponse.json({ error: "Customer not found" }, { status: 404 });

  const profile = await getCustomerProfileType(params.id);
  return NextResponse.json({
    userId: params.id,
    profile,
    name: targetUser.name ?? null,
    email: targetUser.email ?? null,
    role: targetUser.role,
    phone: targetUser.phone ?? null,
    archived: Boolean(targetUser.archived),
    deletedAt: targetUser.deletedAt ? targetUser.deletedAt.toISOString() : null,
    createdAt: targetUser.createdAt ? targetUser.createdAt.toISOString() : null,
    lastLoginAt: targetUser.lastLoginAt ? targetUser.lastLoginAt.toISOString() : null,
    isEmployeeCustomer: targetUser.role !== "CUSTOMER",
  });
}

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> | { id: string } },
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !canManageCustomerProfile(user?.role || null)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(req, "admin-customer-profile-update", 60_000, 60);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  const params = await context.params;
  const targetUser = await prisma.user.findUnique({
    where: { id: params.id },
    select: { id: true, role: true, email: true, name: true },
  });
  if (!targetUser) return NextResponse.json({ error: "Customer not found" }, { status: 404 });

  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  const profile = parsed.data.profile as CustomerProfileType;
  await setCustomerProfileType(params.id, profile);
  await recordAuditLog({
    actorId: user?.id || null,
    action: "CUSTOMER_PROFILE_UPDATED",
    entityType: "USER",
    entityId: params.id,
    request: req,
    outcome: "SUCCESS",
    meta: {
      sourcePage: "admin/customers",
      sourceRoute: `/api/admin/customers/${params.id}/profile`,
      ...buildCustomerActorTargetMeta({
        actorId: user?.id,
        actorRole: user?.role,
        targetId: params.id,
        targetRole: targetUser.role,
      }),
      changedByName: user?.name || user?.email || null,
      changedByRole: user?.role || null,
      target: {
        id: params.id,
        name: targetUser.name || null,
        email: targetUser.email || null,
        role: targetUser.role || null,
      },
      profile,
    },
  });

  return NextResponse.json({ ok: true, userId: params.id, profile });
}
