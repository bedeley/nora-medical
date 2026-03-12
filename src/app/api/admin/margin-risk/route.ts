import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/permissions";

type MarginRiskRow = {
  productId: string;
  name: string;
  sku: string;
  price: number;
  cost: number;
  marginPct: number;
  minMarginPct: number;
  shortfall: number;
};

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const canView = hasPermission(user?.role, "export.data");
  if (!session || !canView) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const limit = Math.max(1, Math.min(50, Number(searchParams.get("limit") || 10)));

  const products = await prisma.product.findMany({
    where: {
      archived: false,
      deletedAt: null,
      minMarginPct: { not: null },
      price: { gt: 0 },
    },
    select: {
      id: true,
      name: true,
      sku: true,
      price: true,
      cost: true,
      minMarginPct: true,
    },
  });

  const rows: MarginRiskRow[] = products
    .map((p) => {
      const price = Number(p.price || 0);
      const cost = Number(p.cost || 0);
      const minMargin = p.minMarginPct != null ? Number(p.minMarginPct) : 0;
      const marginPct = price > 0 ? ((price - cost) / price) * 100 : 0;
      const shortfall = minMargin - marginPct;
      return {
        productId: p.id,
        name: p.name,
        sku: p.sku || "",
        price,
        cost,
        marginPct,
        minMarginPct: minMargin,
        shortfall,
      };
    })
    .filter((row) => Number.isFinite(row.shortfall) && row.shortfall > 0)
    .sort((a, b) => b.shortfall - a.shortfall)
    .slice(0, limit);

  return NextResponse.json({ rows, total: rows.length });
}
