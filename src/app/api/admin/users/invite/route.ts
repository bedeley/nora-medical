import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const invites = await prisma.userOtp.findMany({
    where: {
      purpose: "employee_invite",
      expiresAt: { gt: now },
    },
    include: {
      user: {
        select: { id: true, name: true, email: true, phone: true, role: true },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return NextResponse.json({
    rows: invites.map((invite) => ({
      id: invite.id,
      userId: invite.userId,
      createdAt: invite.createdAt.toISOString(),
      expiresAt: invite.expiresAt.toISOString(),
      user: invite.user,
    })),
  });
}
