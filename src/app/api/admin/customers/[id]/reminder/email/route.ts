import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";

const normalizeBalance = (value: number) => (Math.abs(value) < 0.01 ? 0 : value);

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> | { id: string } },
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
  const limited = await rateLimit(req, "admin-reminder-email", 60_000, 20);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const url = new URL(req.url);
  const queryId = (url.searchParams.get("id") || "").trim();
  const params = await context.params;
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

  const orders = await prisma.order.findMany({
    where: { userId: customerId, status: { not: "CANCELLED" } },
    select: { total: true, amountPaid: true },
  });
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
  if (balance <= 0) {
    return NextResponse.json(
      { error: "Customer has no outstanding balance." },
      { status: 400 },
    );
  }

  const subject = "Payment reminder — Noralls Medical Supplies";
  const lines = [
    customer.name ? `Hi ${customer.name},` : "Hi,",
    "",
    "This is a friendly reminder that an outstanding balance remains on your account.",
    "",
    `Outstanding balance: ${balance.toFixed(2)}`,
    "",
    "Please contact our team if you need an updated statement or payment assistance.",
    "",
    "Thank you.",
  ];
  const text = lines.join("\n");

  const res = await sendEmail(to, subject, text);
  if (!res.ok) {
    try {
      await recordAuditLog({
        actorId: user?.id,
        action: "CUSTOMER_REMINDER_EMAIL_FAILED",
        entityType: "USER",
        entityId: customerId,
        request: req,
        outcome: "FAILED",
        meta: {
          customerEmail: to,
          customerName: customer.name ?? null,
          outstandingBalance: balance,
          error: res.error || "Failed to send reminder",
          sourcePage: "admin/customers",
        },
      });
    } catch { /* best-effort */ }
    return NextResponse.json(
      { error: res.error || "Failed to send reminder" },
      { status: 502 },
    );
  }

  try {
    await recordAuditLog({
      actorId: user?.id,
      action: "CUSTOMER_REMINDER_EMAIL_SENT",
      entityType: "USER",
      entityId: customerId,
      request: req,
      outcome: "SUCCESS",
      meta: {
        customerEmail: to,
        customerName: customer.name ?? null,
        outstandingBalance: balance,
        simulated: (res as { simulated?: boolean }).simulated === true,
        sourcePage: "admin/customers",
      },
    });
  } catch { /* best-effort */ }

  return NextResponse.json({
    ok: true,
    simulated: (res as { simulated?: boolean }).simulated === true,
  });
}
