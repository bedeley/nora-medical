import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { postPaymentEntry } from "@/lib/accounting-posting";

const cancelSchema = z.object({
  reason: z.string().max(240).optional(),
});

function parseMeta(note: string | null) {
  if (!note) return null;
  try {
    return JSON.parse(note) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> | { id: string } },
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = String(user?.role || "");
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  const isAccountant = role === "ACCOUNTANT";
  if (!session || (!isAdmin && !isStaff && !isAccountant)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-momo-cancel", 60_000, 60);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const parsed = cancelSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const params = await context.params;
  const payment = await prisma.payment.findUnique({ where: { id: params.id } });
  if (!payment) return NextResponse.json({ error: "Payment not found" }, { status: 404 });

  const meta = parseMeta(payment.note);
  const method = String(meta?.method || "").toLowerCase();
  const providerRef = String(meta?.providerRef || "").trim();
  const momoStatus = String(meta?.status || "").toUpperCase();
  if (method !== "momo" || !providerRef) {
    return NextResponse.json({ error: "Only provider-linked MoMo requests can be canceled." }, { status: 400 });
  }
  if (momoStatus === "SUCCESS" || momoStatus === "SUCCESSFUL") {
    return NextResponse.json({ error: "Cannot cancel a successful MoMo payment." }, { status: 409 });
  }
  if (momoStatus !== "PENDING" && momoStatus !== "CANCELLED_BY_STAFF") {
    return NextResponse.json(
      { error: `Only pending MoMo requests can be canceled (current: ${momoStatus || "UNKNOWN"}).` },
      { status: 409 },
    );
  }
  if (momoStatus === "CANCELLED_BY_STAFF") {
    return NextResponse.json({ ok: true, alreadyCanceled: true });
  }

  const updatedMeta = {
    ...(meta || {}),
    status: "cancelled_by_staff",
    cancelReason: String(parsed.data.reason || "").trim() || "Canceled by admin/staff",
    canceledAt: new Date().toISOString(),
    canceledBy: {
      id: user?.id || null,
      name: user?.name || null,
      role: user?.role || null,
    },
  };

  await prisma.payment.update({
    where: { id: payment.id },
    data: { note: JSON.stringify(updatedMeta) },
  });

  await prisma.auditLog.create({
    data: {
      actorId: user?.id || null,
      action: "MOMO_PAYMENT_CANCELED",
      entityType: "PAYMENT",
      entityId: payment.id,
      meta: JSON.stringify({
        reason: updatedMeta.cancelReason,
        providerRef,
        orderId: payment.orderId || null,
      }),
    },
  });
  try {
    await postPaymentEntry({ paymentId: payment.id });
  } catch (e) {
    console.warn("Accounting canceled MoMo posting skipped:", e);
  }

  return NextResponse.json({ ok: true });
}
