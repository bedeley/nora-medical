import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const url = new URL(request.url);
    const mode = url.searchParams.get("mode") || "recent";

    // Show last 5 for dashboard, or last 100 for CSV export
    const limit = mode === "full" ? 100 : 5;

    const payments = await prisma.payment.findMany({
      take: limit,
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
      { status: 500 }
    );
  }
}
