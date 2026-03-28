import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getCustomerProfileType } from "@/lib/customer-profile";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const userId = (session.user as AuthenticatedUser).id;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      phone: true,
      phoneVerifiedAt: true,
      createdAt: true,
      lastLoginAt: true,
      employeeProfile: {
        select: {
          id: true,
        },
      },
    },
  });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
  const customerProfile = await getCustomerProfileType(userId);
  return NextResponse.json({
    ...user,
    customerProfile,
    isB2B: customerProfile === "B2B",
    employeeId: user.employeeProfile?.id ?? null,
    hasEmployeePortal: Boolean(user.employeeProfile?.id),
  });
}
