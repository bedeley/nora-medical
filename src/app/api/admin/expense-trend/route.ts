import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";

/**
 * Returns total expenses grouped by day for the last 30 days.
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const since = new Date();
    since.setDate(since.getDate() - 30);

    const results = await prisma.expense.groupBy({
      by: ["createdAt"],
      _sum: { amount: true },
      where: { createdAt: { gte: since } },
    });

    // Normalize by date string (YYYY-MM-DD)
    const daily = results.reduce(
      (acc: Record<string, number>, row: { createdAt: Date; _sum: { amount: unknown } }) => {
        const dateKey = new Date(row.createdAt).toISOString().slice(0, 10);
        acc[dateKey] = (acc[dateKey] ?? 0) + Number(row._sum.amount ?? 0);
        return acc;
      },
      {}
    );

    // Fill in missing dates with 0
    const now = new Date();
    const data = Array.from({ length: 30 }).map((_, i: number) => {
      const d = new Date();
      d.setDate(now.getDate() - (29 - i));
      const dateKey = d.toISOString().slice(0, 10);
      return {
        date: dateKey,
        expense: daily[dateKey] ?? 0,
      };
    });

    return NextResponse.json(data);
  } catch (err) {
    console.error("Error fetching expense trend:", err);
    return NextResponse.json(
      { error: "Failed to load expense trend" },
      { status: 500 }
    );
  }
}
