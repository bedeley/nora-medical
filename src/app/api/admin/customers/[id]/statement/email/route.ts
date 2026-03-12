import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";

const normalizeBalance = (value: number) => (Math.abs(value) < 0.01 ? 0 : value);

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isAccountant = role === "ACCOUNTANT";
  if (!session || (!isAdmin && !isAccountant)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limited = await rateLimit(req, "admin-statement-email", 60_000, 20);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const url = new URL(req.url);
  const queryId = (url.searchParams.get("id") || "").trim();
  let customerId = (params?.id || "").trim();
  if (!customerId) customerId = queryId;
  if (!customerId) {
    try {
      const body = (await req.json().catch(() => ({}))) as { userId?: string; id?: string };
      customerId = String(body.userId || body.id || "").trim();
    } catch {
      customerId = "";
    }
  }
  if (!customerId) {
    return NextResponse.json({ error: "Missing customer id" }, { status: 400 });
  }

  const customer = await prisma.user.findUnique({
    where: { id: customerId },
    select: { email: true, name: true },
  });
  if (!customer) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }
  const to = customer.email;
  if (!to) {
    return NextResponse.json(
      { error: "Customer has no email address on file." },
      { status: 400 },
    );
  }

  const [orders, payments] = await Promise.all([
    prisma.order.findMany({
      where: { userId: customerId },
      select: { total: true, amountPaid: true },
    }),
    prisma.payment.findMany({
      where: { userId: customerId },
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
  const rawBalance = Math.max(0, totalDue - totalPaid);
  const balance = normalizeBalance(rawBalance);
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

  const subject = "Your account statement with Noralls Medical Supplies";
  const lines = [
    customer.name ? `Hi ${customer.name},` : "Hi,",
    "",
    "Here is a summary of your account with Noralls Medical Supplies:",
    "",
    `Total value of orders: ${totalDue.toFixed(2)}`,
    `Total paid:            ${totalPaid.toFixed(2)}`,
    `Outstanding balance:   ${balance.toFixed(2)}`,
    `Store credit:          ${credit.toFixed(2)}`,
    "",
    "If you need a detailed statement, please contact our team or log into your customer portal.",
    "",
    "Thank you.",
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
