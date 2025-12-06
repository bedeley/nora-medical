import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  const isAccountant = role === "ACCOUNTANT";
  if (!session || (!isAdmin && !isStaff && !isAccountant)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const userId = segments[segments.length - 2];
  if (!userId) {
    return NextResponse.json({ error: "Missing user ID" }, { status: 400 });
  }

  try {
    const orders = await prisma.order.findMany({
      where: { userId },
      select: {
        id: true,
        deliveryStatus: true,
        total: true,
        amountPaid: true,
        balance: true,
        status: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return NextResponse.json({ orders });
  } catch (error) {
    console.error("Admin list orders error:", error);
    return NextResponse.json({ error: "Failed to load orders" }, { status: 500 });
  }
}
