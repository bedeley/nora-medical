import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { assertSameOrigin } from "@/lib/origin";

export async function POST(req: Request) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = session.user as AuthenticatedUser;
  const userId = user.id;

  const me = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, name: true },
  });
  const to = me?.email || user.email;
  if (!to) {
    return NextResponse.json(
      { error: "No email address on file for this account." },
      { status: 400 },
    );
  }

  const [orders, payments] = await Promise.all([
    prisma.order.findMany({
      where: { userId },
      select: { total: true, amountPaid: true },
    }),
    prisma.payment.findMany({
      where: { userId },
      select: { amount: true, status: true, refundDisposition: true, note: true },
    }),
  ]);

  const totalDue = orders.reduce(
    (s, o) => s + Number(o.total || 0),
    0,
  );
  const totalPaid = orders.reduce(
    (s, o) => s + Number(o.amountPaid || 0),
    0,
  );
  const balance = Math.max(0, totalDue - totalPaid);
  // Store credit ledger: credits issued (NORMAL + CREDIT),
  // minus AUTO_APPLY applications and cash payouts of credit.
  let credit = 0;
  for (const p of payments as Array<{
    amount: unknown;
    status: string | null;
    refundDisposition: string | null;
    note: string | null;
  }>) {
    const amount = Number(p.amount || 0);
    const note = p.note || "";
    const isAutoApply = note.includes("\"reference\":\"AUTO_APPLY\"");
    const isCreditIssued =
      p.status === "NORMAL" &&
      p.refundDisposition === "CREDIT" &&
      amount > 0;
    const isCreditCashPayout =
      p.status === "REFUND" &&
      p.refundDisposition === "CASH" &&
      note.includes("\"location\":\"admin/customers:credit-payout\"");

    if (isCreditIssued) {
      credit += amount;
    } else if (isAutoApply) {
      credit -= amount;
    } else if (isCreditCashPayout) {
      // amount is negative; this reduces credit
      credit += amount;
    }
  }
  credit = Math.max(0, credit);

  const subject = "Your Noralls Medical Supplies account statement";
  const lines = [
    me?.name ? `Hi ${me.name},` : "Hi,",
    "",
    "Here is a summary of your account with Noralls Medical Supplies:",
    "",
    `Total value of orders: ${totalDue.toFixed(2)}`,
    `Total paid:            ${totalPaid.toFixed(2)}`,
    `Outstanding balance:   ${balance.toFixed(2)}`,
    `Store credit:          ${credit.toFixed(2)}`,
    "",
    "For a detailed breakdown, you can also download a full statement from your account page.",
    "",
    "Thank you for your business.",
  ];
  const text = lines.join("\n");

  const res = await sendEmail(to, subject, text);
  if (!res.ok) {
    return NextResponse.json(
      { error: res.error || "Failed to email statement" },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    simulated: (res as { simulated?: boolean }).simulated === true,
  });
}
