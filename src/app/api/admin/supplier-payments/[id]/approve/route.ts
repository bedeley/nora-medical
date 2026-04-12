import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { hasPermission } from "@/lib/permissions";
import { postSupplierPaymentEntry } from "@/lib/accounting-posting";
import { recordAuditLog } from "@/lib/audit-log";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const canManageSupplierPayments = hasPermission(role, "supplierPayments.manage");
  if (!session || !canManageSupplierPayments) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limited = await rateLimit(req, "supplier-payment-approve", 60_000, 30);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }
  const sourcePage =
    new URL(req.url).searchParams.get("sourcePage")?.trim() || "admin/supplier-payments";

  const { id: rawId } = await params;
  const id = String(rawId || "").trim();
  if (!id) {
    return NextResponse.json({ error: "Missing payment id" }, { status: 400 });
  }

  const payment = await prisma.supplierPayment.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      approvedAt: true,
      paidAt: true,
      purchaseId: true,
      supplierId: true,
      amount: true,
      method: true,
      reference: true,
      note: true,
    },
  });
  if (!payment) {
    return NextResponse.json({ error: "Supplier payment not found" }, { status: 404 });
  }
  if (payment.status !== "PENDING_APPROVAL") {
    return NextResponse.json({ error: "Payment is not pending approval" }, { status: 400 });
  }
  if (payment.approvedAt) {
    return NextResponse.json({ error: "Payment is already approved" }, { status: 400 });
  }

  const approvedPayment = await prisma.supplierPayment.update({
    where: { id },
    data: {
      status: "NORMAL",
      approvedById: user?.id,
      approvedAt: new Date(),
      paidAt: payment.paidAt || new Date(),
    },
  });
  try {
    await recordAuditLog({
      actorId: user?.id,
      action: "SUPPLIER_PAYMENT_APPROVE",
      entityType: "SUPPLIER_PAYMENT",
      entityId: id,
      request: req,
      meta: {
        sourcePage,
        section: "pending-payment-approvals",
        operation: "approve_supplier_payment",
        previousStatus: payment.status,
        status: approvedPayment.status,
        purchaseId: payment.purchaseId || null,
        supplierId: payment.supplierId || null,
        amount: Number(payment.amount || 0),
        method: payment.method || null,
        reference: payment.reference || null,
        note: payment.note || null,
        approvedAt: approvedPayment.approvedAt ? approvedPayment.approvedAt.toISOString() : null,
        resultSummary: `Approved supplier payment of ${Number(payment.amount || 0).toFixed(2)}.`,
      },
    });
  } catch {
    // best-effort
  }
  try {
    await postSupplierPaymentEntry({ supplierPaymentId: id });
  } catch (e) {
    console.warn("Accounting supplier payment posting skipped:", e);
  }

  return NextResponse.json({ ok: true });
}
