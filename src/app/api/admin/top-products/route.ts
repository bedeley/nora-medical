import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { parseISO, isValid, startOfDay, endOfDay } from "date-fns";

type ProductSummary = {
  id: string;
  name: string;
  totalSold: number;
  revenue: number;
};

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  const isAccountant = role === "ACCOUNTANT";
  if (!session || (!isAdmin && !isStaff && !isAccountant)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const mode = searchParams.get("mode") || "quantity";
    const start = searchParams.get("start");
    const end = searchParams.get("end");

    const dateFilter: { gte?: Date; lte?: Date } = {};
    if (start && isValid(parseISO(start))) dateFilter.gte = startOfDay(parseISO(start));
    if (end && isValid(parseISO(end))) dateFilter.lte = endOfDay(parseISO(end));

    const orderWhere = {
      NOT: { status: { in: ["CANCELLED", "CANCELED"] } },
      ...(Object.keys(dateFilter).length ? { createdAt: dateFilter } : {}),
    };

    const grouped = await prisma.orderItem.groupBy({
      by: ["productId"],
      where: { order: orderWhere },
      _sum: { quantity: true },
      orderBy: { _sum: { quantity: "desc" } },
      take: 10,
    });

    const productIds = grouped.map((g) => g.productId);
    const productRows = await prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, name: true, price: true },
    });
    const productMap = new Map(productRows.map((p) => [p.id, p]));

    const products: ProductSummary[] = grouped.map((g: { productId: string; _sum: { quantity: number | null } }) => {
      const product = productMap.get(g.productId);
      const totalSold = g._sum.quantity ?? 0;
      const revenue = totalSold * Number(product?.price ?? 0);
      return {
        id: g.productId,
        name: product?.name || "Unknown",
        totalSold,
        revenue,
      };
    });

    const sorted =
      mode === "revenue"
        ? products.sort((a: ProductSummary, b: ProductSummary) => b.revenue - a.revenue)
        : products.sort((a: ProductSummary, b: ProductSummary) => b.totalSold - a.totalSold);

    return NextResponse.json(sorted);
  } catch (error) {
    console.error("Error fetching top-selling products:", error);
    return NextResponse.json(
      { error: "Failed to fetch top-selling products" },
      { status: 500 }
    );
  }
}
