import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { startOfMonth, startOfYear, subMonths } from "date-fns";

export async function GET() {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;

  // 🔒 Only allow admins
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const now = new Date();
    const monthStart = startOfMonth(now);
    const yearStart = startOfYear(now);
    const lastMonthStart = startOfMonth(subMonths(now, 1));

    // 🧮 Aggregate totals
    const [monthTotal, lastMonthTotal, yearTotal] = await Promise.all([
      prisma.order.aggregate({
        _sum: { total: true },
        where: { createdAt: { gte: monthStart } },
      }),
      prisma.order.aggregate({
        _sum: { total: true },
        where: {
          createdAt: {
            gte: lastMonthStart,
            lt: monthStart,
          },
        },
      }),
      prisma.order.aggregate({
        _sum: { total: true },
        where: { createdAt: { gte: yearStart } },
      }),
    ]);

    // ✅ Convert Prisma Decimals to numbers safely
    const monthRevenue = monthTotal._sum.total
      ? monthTotal._sum.total.toNumber()
      : 0;
    const lastMonthRevenue = lastMonthTotal._sum.total
      ? lastMonthTotal._sum.total.toNumber()
      : 0;
    const yearRevenue = yearTotal._sum.total
      ? yearTotal._sum.total.toNumber()
      : 0;

    // 📆 Compute days since start of year
    const daysPassed = Math.max(
      1,
      Math.ceil((now.getTime() - yearStart.getTime()) / (1000 * 60 * 60 * 24))
    );

    const avgDailyRevenue = yearRevenue / daysPassed;

    // 📈 Compute growth percent safely
    const growthPercent =
      lastMonthRevenue > 0 ? (monthRevenue / lastMonthRevenue - 1) * 100 : null;

    return NextResponse.json({
      monthRevenue: Number(monthRevenue.toFixed(2)),
      yearRevenue: Number(yearRevenue.toFixed(2)),
      avgDailyRevenue: Number(avgDailyRevenue.toFixed(2)),
      growthPercent: growthPercent ? Number(growthPercent.toFixed(1)) : null,
    });
  } catch (error) {
    console.error("Error fetching revenue summary:", error);
    return NextResponse.json(
      { error: "Failed to fetch revenue summary" },
      { status: 500 }
    );
  }
}
