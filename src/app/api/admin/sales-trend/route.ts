import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { eachDayOfInterval, parseISO, startOfDay } from "date-fns";

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const rangeParam = Number(searchParams.get("range") || 7);
    const startParam = searchParams.get("start");
    const endParam = searchParams.get("end");

    const endDate = endParam
      ? startOfDay(parseISO(endParam))
      : startOfDay(new Date());
    const startDate = startParam
      ? startOfDay(parseISO(startParam))
      : new Date(endDate.getTime() - (rangeParam - 1) * 24 * 60 * 60 * 1000);

    const days = eachDayOfInterval({ start: startDate, end: endDate });

    const results = await Promise.all(
      days.map(async (day: Date) => {
        const nextDay = new Date(day);
        nextDay.setDate(day.getDate() + 1);
        const total = await prisma.order.aggregate({
          _sum: { total: true },
          where: { createdAt: { gte: day, lt: nextDay } },
        });
        return {
          date: day.toISOString().split("T")[0],
          totalRevenue: Number(total._sum.total ?? 0),
        };
      })
    );

    return NextResponse.json(results);
  } catch (error) {
    console.error("Error fetching sales trend:", error);
    return NextResponse.json(
      { error: "Failed to fetch sales trend" },
      { status: 500 }
    );
  }
}
