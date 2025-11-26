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
    const lowStockProducts = await prisma.product.findMany({
      where: { stock: { lt: 10 } },
      orderBy: { stock: "asc" },
      select: {
        id: true,
        name: true,
        price: true,
        stock: true,
        updatedAt: true,
      },
    });

    return NextResponse.json(lowStockProducts);
  } catch (err) {
    console.error("Error fetching inventory alerts:", err);
    return NextResponse.json(
      { error: "Failed to fetch inventory alerts" },
      { status: 500 },
    );
  }
}
