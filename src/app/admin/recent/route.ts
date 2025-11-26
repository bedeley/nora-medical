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

  try {
    // Fetch recent payments (limit 5)
    const payments = await prisma.payment.findMany({
      take: 5,
      orderBy: { createdAt: "desc" },
      include: {
        user: { select: { name: true, email: true } },
        order: { select: { id: true, total: true, status: true } },
      },
    });

    return NextResponse.json(payments);
  } catch (error) {
    console.error("Error fetching recent payments:", error);
    return NextResponse.json(
      { error: "Failed to fetch recent payments" },
      { status: 500 },
    );
  }
}
