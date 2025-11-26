import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { startOfDay, endOfDay, parseISO, isValid } from "date-fns";

/**
 * ✅ Returns raw transactions (payments + expenses)
 * Supports ?start, ?end, ?customer, ?category filters
 */
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;

  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const start = searchParams.get("start");
    const end = searchParams.get("end");
    const customer = searchParams.get("customer");
    const category = searchParams.get("category");

    const createdAt: { gte?: Date; lte?: Date } = {};
    if (start && isValid(parseISO(start))) {
      createdAt.gte = startOfDay(parseISO(start));
    }
    if (end && isValid(parseISO(end))) {
      createdAt.lte = endOfDay(parseISO(end));
    }

    const createdAtFilter =
      Object.keys(createdAt).length > 0 ? { createdAt } : {};

    // 💵 Payments (revenue inflows)
    const payments = await prisma.payment.findMany({
      where: {
        ...createdAtFilter,
        ...(customer
          ? {
              user: {
                name: { contains: customer, mode: "insensitive" },
              },
            }
          : {}),
      },
      include: { user: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
    });

    // 💸 Expenses (cash outflows)
    const expenses = await prisma.expense.findMany({
      where: {
        ...createdAtFilter,
        ...(category
          ? {
              category: { contains: category, mode: "insensitive" },
            }
          : {}),
      },
      orderBy: { createdAt: "desc" },
    });

    // 🧾 Merge + normalize
    const records = [
      ...payments.map((p: { id: string; createdAt: Date; amount: unknown; user?: { name?: string | null } | null }) => ({
        id: p.id,
        createdAt: p.createdAt,
        type: "payment" as const,
        name: p.user?.name || "Unknown",
        amount: Number(p.amount),
      })),
      ...expenses.map((e: { id: string; createdAt: Date; category: string; amount: unknown }) => ({
        id: e.id,
        createdAt: e.createdAt,
        type: "expense" as const,
        category: e.category,
        amount: Number(e.amount),
      })),
    ].sort(
      (
        a: { createdAt: Date },
        b: { createdAt: Date },
      ) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    return NextResponse.json({ records });
  } catch (error) {
    console.error("❌ Error fetching full report:", error);
    return NextResponse.json(
      { error: "Failed to fetch full report" },
      { status: 500 }
    );
  }
}
