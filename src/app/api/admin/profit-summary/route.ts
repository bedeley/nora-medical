import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/**
 * ✅ Admin Profit Summary API
 * Returns revenue, expenses, profit, and breakdown.
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isAccountant = role === "ACCOUNTANT";
  if (!session || (!isAdmin && !isAccountant)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // 🧮 1. Calculate total revenue (sum of all payments)
    const totalRevenueData = await prisma.payment.aggregate({
      _sum: { amount: true },
    });
    const totalRevenue = Number(totalRevenueData._sum.amount || 0);

    // 💸 2. Calculate total expenses
    const totalExpenseData = await prisma.expense.aggregate({
      _sum: { amount: true },
    });
    const totalExpense = Number(totalExpenseData._sum.amount || 0);

    // 💰 3. Compute net profit and margin
    const profit = totalRevenue - totalExpense;
    const margin = totalRevenue > 0 ? (profit / totalRevenue) * 100 : 0;

    // 📊 4. Expense breakdown by category
    const expenseBreakdown = await prisma.expense.groupBy({
      by: ["category"],
      _sum: { amount: true },
      orderBy: { _sum: { amount: "desc" } },
    });

    // ✅ Return summary payload
    return NextResponse.json({
      totalRevenue,
      totalExpense,
      profit,
      margin,
      expenseBreakdown,
    });
  } catch (err) {
    console.error("Error computing profit summary:", err);
    return NextResponse.json(
      { error: "Failed to load profit summary" },
      { status: 500 }
    );
  }
}
