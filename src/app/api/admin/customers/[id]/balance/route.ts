import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PaymentStatus, RefundDestination } from "@/lib/prisma-enums";

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> | { id: string } }
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  const isAccountant = role === "ACCOUNTANT";
  if (!session || (!isAdmin && !isStaff && !isAccountant)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = await context.params;
  const userId = params.id;

  try {
    const [orders, payments, balanceRow] = await Promise.all([
      prisma.order.findMany({
        where: { userId, status: { not: "CANCELLED" } },
        select: { total: true, amountPaid: true },
      }),
      prisma.payment.findMany({
        where: {
          userId,
        },
        select: { amount: true, status: true, refundDisposition: true, note: true },
      }),
      prisma.balance.findUnique({
        where: { userId },
        select: { creditLimit: true },
      }),
    ]);

    const ordersTotal = orders.reduce(
      (sum: number, o: { total: unknown }) => sum + Number(o.total || 0),
      0,
    );
    const paidTotal = orders.reduce(
      (sum: number, o: { amountPaid: unknown }) =>
        sum + Number(o.amountPaid || 0),
      0,
    );
    const paymentsTotal = payments.reduce(
      (sum: number, p: { amount: unknown }) => sum + Number(p.amount || 0),
      0,
    );

    const balance = Math.max(0, ordersTotal - paidTotal);
    const cashRefunds = payments
      .filter(
        (p: {
          status: unknown;
          refundDisposition: unknown;
          amount: unknown;
        }) =>
          p.status === PaymentStatus.REFUND &&
          p.refundDisposition === RefundDestination.CASH,
      )
      .reduce(
        (sum: number, p: { amount: unknown }) =>
          sum + Math.abs(Number(p.amount || 0)),
        0,
      );

    // Explicit store credit ledger: credits from returns/adjustments,
    // minus amounts applied to orders and cash payouts of credit.
    let storeCredit = 0;
    for (const p of payments as Array<{
      amount: unknown;
      status: unknown;
      refundDisposition: unknown;
      note: string | null;
    }>) {
      const amount = Number(p.amount || 0);
      const note = p.note || "";
      let meta: {
        reference?: string;
        location?: string;
        refundDisposition?: string;
        method?: string;
      } = {};
      try {
        meta = note ? (JSON.parse(note) as typeof meta) : {};
      } catch {
        // ignore malformed meta
      }
      const isAutoApply =
        meta.reference === "AUTO_APPLY" ||
        note.includes("\"reference\":\"AUTO_APPLY\"");
      const topLevelDisposition =
        typeof p.refundDisposition === "string"
          ? (p.refundDisposition as string).toUpperCase()
          : null;
      const metaDisposition = meta.refundDisposition
        ? meta.refundDisposition.toUpperCase()
        : null;
      const isCreditDestination =
        topLevelDisposition === RefundDestination.CREDIT ||
        metaDisposition === "CREDIT";
      const isCashDestination =
        topLevelDisposition === RefundDestination.CASH ||
        metaDisposition === "CASH";
      const isAdjustment =
        (meta.method || "").toLowerCase() === "adjustment";
      const isCreditIssued =
        p.status === PaymentStatus.NORMAL &&
        amount > 0 &&
        (isCreditDestination || (isAdjustment && !isAutoApply));
      const isCreditCashPayout =
        p.status === PaymentStatus.REFUND &&
        isCashDestination &&
        (meta.location === "admin/customers:credit-payout" ||
          note.includes("\"location\":\"admin/customers:credit-payout\""));

      if (isCreditIssued) {
        storeCredit += amount;
      } else if (isAutoApply) {
        storeCredit -= amount;
      } else if (isCreditCashPayout) {
        storeCredit += amount;
      }
    }
    storeCredit = Math.max(0, storeCredit);

    return NextResponse.json({
      ordersTotal,
      paidTotal,
      paymentsTotal,
      balance,
      storeCredit,
      cashRefunds,
      creditLimit: Number(balanceRow?.creditLimit ?? 0),
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error("Admin customer balance error:", e);
    return NextResponse.json(
      { error: "Failed to load customer balance" },
      { status: 500 },
    );
  }
}
