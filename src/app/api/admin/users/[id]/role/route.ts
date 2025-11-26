import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Role } from "@prisma/client";
import { assertSameOrigin } from "@/lib/origin";

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
  // Feature flag: disable role management unless explicitly enabled
  if ((process.env.ADMIN_ROLE_MANAGEMENT_ENABLED || "").trim() !== "1") {
    return NextResponse.json(
      { error: "Role management is temporarily disabled." },
      { status: 403 }
    );
  }

  const session = await getServerSession(authOptions);
  const sessionUser = session?.user as AuthenticatedUser | undefined;
  if (!session || sessionUser?.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const id = params.id;
  try {
    const body = (await req.json().catch(() => ({}))) as {
      role?: string;
    };
    const roleRaw = String(body?.role || "").toUpperCase();
    if (!roleRaw || !["ADMIN", "CUSTOMER"].includes(roleRaw)) {
      return NextResponse.json(
        { error: "Role must be ADMIN or CUSTOMER" },
        { status: 400 }
      );
    }

    const targetRole = roleRaw as keyof typeof Role;

    // Prevent demoting yourself out of ADMIN
    const currentUserId = sessionUser.id;
    if (currentUserId === id && targetRole !== "ADMIN") {
      return NextResponse.json(
        { error: "You cannot remove your own admin access." },
        { status: 400 }
      );
    }

    const user = await prisma.user.update({
      where: { id },
      data: { role: Role[targetRole] },
      select: { id: true, email: true, role: true },
    });

    return NextResponse.json({ user });
  } catch (e: unknown) {
    const message =
      e instanceof Error ? e.message : "Failed to update role";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
