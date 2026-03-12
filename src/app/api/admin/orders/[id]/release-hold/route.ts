import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";
import { isCreditLimitExceeded } from "@/lib/credit";
import { z } from "zod";

type TxClient = Parameters<typeof prisma.$transaction>[0] extends (arg: infer A) => unknown ? A : never;

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> | { id: string } },
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  if (!session || role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-order-release-hold", 60_000, 30);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const params = await context.params;
  const orderId = params.id;

  const body = await req.json().catch(() => ({}));
  const parsed = z
    .object({
      force: z.boolean().optional(),
      note: z.string().max(400).optional(),
    })
    .safeParse(body);
  const force = parsed.success ? !!parsed.data.force : false;
  const note = parsed.success ? (parsed.data.note || "").trim() : "";

  try {
    const result = await prisma.$transaction(async (tx: TxClient) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          userId: true,
          status: true,
          total: true,
          amountPaid: true,
          balance: true,
        },
      });
      if (!order) {
        throw new Error("Order not found");
      }
      if (String(order.status || "").toUpperCase() !== "ON_HOLD_CREDIT") {
        throw new Error("Order is not on credit hold");
      }
      if (!order.userId) {
        throw new Error("Only registered customers can be released from credit hold");
      }

      const { exceeded, creditLimit, outstanding } = await isCreditLimitExceeded(tx, order.userId);
      if (exceeded && !force) {
        return {
          ok: false,
          creditLimit,
          outstanding,
        };
      }

      const amountPaid = Number(order.amountPaid ?? 0);
      const total = Number(order.total ?? 0);
      const balance = Number(order.balance ?? Math.max(0, total - amountPaid));
      const newStatus = balance <= 0 ? "PAID" : amountPaid > 0 ? "PARTIALLY_PAID" : "UNPAID";

      const updated = await tx.order.update({
        where: { id: order.id },
        data: { status: newStatus },
        select: { id: true, status: true },
      });

      return { ok: true, updated, forced: force, creditLimit, outstanding };
    });

    if (!result.ok) {
      return NextResponse.json(
        {
          error: "Outstanding balance still exceeds credit limit.",
          creditLimit: result.creditLimit,
          outstanding: result.outstanding,
        },
        { status: 409 },
      );
    }

    try {
      await recordAuditLog({
        actorId: user?.id,
        action: "ORDER_RELEASE_CREDIT_HOLD",
        entityType: "ORDER",
        entityId: orderId,
        meta: {
          status: result.updated?.status,
          forced: result.forced || false,
          note: note || null,
          creditLimit: result.creditLimit,
          outstanding: result.outstanding,
        },
      });
    } catch {
      // best-effort
    }

    return NextResponse.json({ success: true, status: result.updated?.status });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to release hold";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
