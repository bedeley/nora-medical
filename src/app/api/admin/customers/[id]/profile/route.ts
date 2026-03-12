import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { getCustomerProfileType, setCustomerProfileType, type CustomerProfileType } from "@/lib/customer-profile";

const schema = z.object({
  profile: z.enum(["B2B", "B2C"]),
});

function hasAdminCustomerAccess(role?: string | null) {
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
    select: { id: true, role: true, email: true, name: true },
  });
  if (!targetUser) return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  if (targetUser.role !== "CUSTOMER") {
    return NextResponse.json({ error: "Only CUSTOMER accounts can use customer profile type." }, { status: 400 });
  }

  const profile = await getCustomerProfileType(params.id);
  return NextResponse.json({ userId: params.id, profile });
}

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> | { id: string } },
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !hasAdminCustomerAccess(user?.role || null)) {
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
  if (targetUser.role !== "CUSTOMER") {
    return NextResponse.json({ error: "Only CUSTOMER accounts can use customer profile type." }, { status: 400 });
  }

  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  const profile = parsed.data.profile as CustomerProfileType;
  await setCustomerProfileType(params.id, profile);
  await prisma.auditLog.create({
    data: {
      actorId: user?.id || null,
      action: "CUSTOMER_PROFILE_UPDATED",
      entityType: "USER",
      entityId: params.id,
      meta: JSON.stringify({
        profile,
        target: {
          id: params.id,
          name: targetUser.name || null,
          email: targetUser.email || null,
        },
      }),
    },
  });

  return NextResponse.json({ ok: true, userId: params.id, profile });
}

