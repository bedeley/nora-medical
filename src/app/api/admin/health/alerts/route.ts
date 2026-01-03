import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { rateLimit } from "@/lib/rate-limit";

function num(v: unknown) {
  return Number(v || 0);
}

function todayKey() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export async function POST(req: Request) {
  const cronSecret = process.env.CRON_SECRET || "";
  const authHeader = String((req.headers.get("authorization") || "").trim());
  const bearer = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : "";
  const hasCronAccess = cronSecret && bearer === cronSecret;

  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const hasAdminAccess = !!session && user?.role === "ADMIN";

  if (!hasAdminAccess && !hasCronAccess) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limited = await rateLimit(req, "admin-health-alerts", 60_000, 10);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const key = `daily-${todayKey()}`;
  const existing = await prisma.auditLog.findFirst({
    where: { action: "HEALTH_ALERT_SENT", entityType: "HEALTH_ALERT", entityId: key },
  });
  if (existing) {
    return NextResponse.json({ ok: true, skipped: true });
  }

  const orders = await prisma.order.findMany({
    select: { id: true, total: true, amountPaid: true, balance: true, status: true },
  });
  const activeOrders = orders.filter((o) => o.status !== "CANCELLED");
  const orderBalanceMismatches = activeOrders.filter((o) => {
    const expected = Math.max(0, num(o.total) - num(o.amountPaid));
    return Math.abs(num(o.balance) - expected) > 0.01;
  }).length;

  const orderPayments = await prisma.payment.groupBy({
    by: ["orderId", "status"],
    where: { orderId: { not: null } },
    _sum: { amount: true },
  });
  const orderPaymentsMap = new Map<string, number>();
  for (const row of orderPayments) {
    if (!row.orderId) continue;
    if (row.status === "VOID") continue;
    const signed =
      row.status === "REFUND" ? -num(row._sum.amount) : num(row._sum.amount);
    orderPaymentsMap.set(
      row.orderId,
      (orderPaymentsMap.get(row.orderId) ?? 0) + signed
    );
  }
  const paymentMismatches = activeOrders.filter((o) => {
    const paidFromPayments = orderPaymentsMap.get(o.id) ?? 0;
    return Math.abs(num(o.amountPaid) - paidFromPayments) > 0.01;
  }).length;

  const products = await prisma.product.findMany({
    select: { id: true, stock: true },
  });
  const movements = await prisma.inventoryMovement.groupBy({
    by: ["productId"],
    _sum: { delta: true },
  });
  const movementMap = new Map(movements.map((m) => [m.productId, num(m._sum.delta)]));
  const stockMismatches = products.filter(
    (p) => num(p.stock) !== (movementMap.get(p.id) ?? 0)
  ).length;
  const legacyAutoApply = await prisma.payment.count({
    where: { orderId: null, note: { contains: "\"reference\":\"AUTO_APPLY\"" } },
  });

  const hasIssues =
    paymentMismatches > 0 ||
    orderBalanceMismatches > 0 ||
    stockMismatches > 0 ||
    legacyAutoApply > 0;

  if (!hasIssues) {
    return NextResponse.json({ ok: true, skipped: true });
  }

  const admins = await prisma.user.findMany({
    where: { role: "ADMIN", archived: false, email: { not: null } },
    select: { email: true, name: true },
  });
  const toList = admins.map((a) => a.email).filter(Boolean) as string[];
  if (!toList.length) {
    return NextResponse.json({ ok: true, skipped: true, reason: "No admin emails" });
  }

  const base =
    process.env.NEXT_PUBLIC_BASE_URL ||
    process.env.NEXTAUTH_URL ||
    "http://localhost:3000";
  const subject = "Health Check Alert — mismatches detected";
  const body = [
    "The health check found data mismatches:",
    `- Payment mismatches: ${paymentMismatches}`,
    `- Order balance mismatches: ${orderBalanceMismatches}`,
    `- Stock mismatches: ${stockMismatches}`,
    `- Legacy AUTO_APPLY rows: ${legacyAutoApply}`,
    "",
    `Review: ${base}/admin/health`,
  ].join("\n");

  for (const email of toList) {
    await sendEmail(email, subject, body);
  }

  await prisma.auditLog.create({
    data: {
      action: "HEALTH_ALERT_SENT",
      entityType: "HEALTH_ALERT",
      entityId: key,
      meta: JSON.stringify({
        paymentMismatches,
        orderBalanceMismatches,
        stockMismatches,
        legacyAutoApply,
      }),
    },
  });

  return NextResponse.json({ ok: true, sent: toList.length });
}
