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
    const { searchParams } = new URL(request.url);
    const mode = searchParams.get("mode") || "quantity";

    // Aggregate quantities and fetch product data
    const grouped = await prisma.orderItem.groupBy({
      by: ["productId"],
      _sum: { quantity: true },
      orderBy: { _sum: { quantity: "desc" } },
      take: 10,
    });

    const products = await Promise.all(
      grouped.map(async (g) => {
        const product = await prisma.product.findUnique({
          where: { id: g.productId },
          select: { name: true, price: true },
        });
        const totalSold = g._sum.quantity ?? 0;
        const revenue = totalSold * Number(product?.price ?? 0);
        return {
          id: g.productId,
          name: product?.name || "Unknown",
          totalSold,
          revenue,
        };
      })
    );

    const sorted =
      mode === "revenue"
        ? products.sort((a, b) => b.revenue - a.revenue)
        : products.sort((a, b) => b.totalSold - a.totalSold);

    return NextResponse.json(sorted);
  } catch (error) {
    console.error("Error fetching top-selling products:", error);
    return NextResponse.json(
      { error: "Failed to fetch top-selling products" },
      { status: 500 }
    );
  }
}
