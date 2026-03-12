import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getMomoStatus, type MomoProvider } from "@/lib/momo";
import { notifyPaymentEvent } from "@/lib/notifications";
import { postPaymentEntry } from "@/lib/accounting-posting";
import { recordAuditLog } from "@/lib/audit-log";

type TxClient = Parameters<typeof prisma.$transaction>[0] extends (arg: infer A) => unknown ? A : never;
function maskProviderRef(value: string | null | undefined) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (raw.length <= 8) return `${raw.slice(0, 2)}***${raw.slice(-2)}`;
  return `${raw.slice(0, 4)}***${raw.slice(-4)}`;
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> | { id: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = await context.params;

  try {
    const payment = await prisma.payment.findUnique({ where: { id: params.id } });
    if (!payment) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const user = session.user as AuthenticatedUser;
    const isAdmin = user.role === "ADMIN";
    const isOwner = payment.userId && payment.userId === user.id;
    if (!isAdmin && !isOwner) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const paymentCustomer = payment.userId
      ? await prisma.user.findUnique({
          where: { id: payment.userId },
          select: { name: true, email: true, phone: true },
        })
      : null;

    let meta: Record<string, unknown> | null = null;
    if (payment.note) {
      try {
        meta = JSON.parse(payment.note) as Record<string, unknown>;
      } catch {
        meta = null;
      }
    }
    const provider = String((meta?.provider as string | undefined) ?? "mtn") as MomoProvider;
    const ref = String((meta?.providerRef as string | undefined) ?? "");
    if (!ref) return NextResponse.json({ error: "No provider reference" }, { status: 400 });
    const localStatus = String((meta?.status as string | undefined) ?? "").toUpperCase();
    const forcePendingForTest = Boolean((meta as { forcePendingForTest?: unknown } | null)?.forcePendingForTest);
    if (localStatus === "CANCELLED_BY_STAFF") {
      return NextResponse.json({ ok: true, status: "CANCELLED_BY_STAFF" });
    }
    if (forcePendingForTest && localStatus.startsWith("PENDING")) {
      return NextResponse.json({ ok: true, status: "PENDING_FORCED_TEST", forced: true });
    }

    const status = await getMomoStatus(provider, ref);
    if (!status.ok) return NextResponse.json({ error: status.error || "Status error" }, { status: 502 });
    const providerStatus = String(status.status || "").toUpperCase();
    if (providerStatus !== "SUCCESSFUL" && providerStatus !== "PENDING") {
      const fresh = await prisma.payment.findUnique({ where: { id: payment.id } });
      if (fresh?.note) {
        try {
          const currentMeta = JSON.parse(fresh.note) as Record<string, unknown>;
          const currentStatus = String(currentMeta?.status || "").toUpperCase();
          if (currentStatus !== "CANCELLED_BY_STAFF" && currentStatus !== "FAILED") {
            await prisma.payment.update({
              where: { id: payment.id },
              data: {
                note: JSON.stringify({
                  ...currentMeta,
                  status: "failed",
                  providerStatus: providerStatus,
                }),
              },
            });
          }
        } catch {
          // ignore malformed note
        }
      }
      try {
        await postPaymentEntry({ paymentId: payment.id });
      } catch (e) {
        console.warn("Accounting payment posting skipped (momo status non-success):", e);
      }
      try {
        await recordAuditLog({
          actorId: isOwner ? user.id : null,
          action: "PAYMENT_FAILED",
          entityType: "PAYMENT",
          entityId: payment.id,
          meta: {
            actorType: isOwner ? "CUSTOMER" : "SYSTEM",
            source: "MOMO_STATUS_POLL",
            resolvedBy: "POLL",
            customerId: payment.userId || null,
            customerName: paymentCustomer?.name || null,
            customerEmail: paymentCustomer?.email || null,
            customerPhone: paymentCustomer?.phone || null,
            orderId: payment.orderId || null,
            method: "momo",
            provider,
            providerRef: maskProviderRef(ref),
            providerStatus,
          },
        });
      } catch {}
      return NextResponse.json({ ok: true, status: status.status });
    }

    let appliedNow = false;
    if (String(status.status).toUpperCase() === "SUCCESSFUL") {
      // Apply to order balances if not already applied (idempotent)
      await prisma.$transaction(async (tx: TxClient) => {
        const fresh = await tx.payment.findUnique({ where: { id: payment.id } });
        if (!fresh) throw new Error("Payment disappeared");
        let currentMeta: Record<string, unknown> | null = null;
        if (fresh.note) {
          try {
            currentMeta = JSON.parse(fresh.note) as Record<string, unknown>;
          } catch {
            currentMeta = null;
          }
        }
        if ((currentMeta as { status?: string } | null)?.status === "success") return; // already applied
        const currentStatus = String((currentMeta as { status?: string } | null)?.status || "").toUpperCase();
        if (currentStatus === "CANCELLED_BY_STAFF") {
          const withLate = {
            ...(currentMeta ?? {}),
            status: "late_success_after_cancel",
            providerStatus: status.status,
          };
          await tx.payment.update({
            where: { id: payment.id },
            data: { note: JSON.stringify(withLate) },
          });
          return;
        }
        const userId = fresh.userId || undefined;
        const orderId = fresh.orderId || undefined;
        const beforeOrders = userId
          ? await tx.order.findMany({
              where: { userId, NOT: { status: "CANCELLED" } },
              orderBy: { createdAt: "asc" },
              select: { id: true, status: true, total: true, amountPaid: true },
            })
          : [];
        const totalDueBefore = beforeOrders.reduce(
          (s: number, o: { total: unknown }) => s + Number(o.total || 0),
          0
        );
        const totalPaidBefore = beforeOrders.reduce(
          (s: number, o: { amountPaid: unknown }) => s + Number(o.amountPaid || 0),
          0
        );
        const balanceBefore = Math.max(0, totalDueBefore - totalPaidBefore);
        const amount = Number(fresh.amount || 0);
        const applied: Array<{
          orderId: string;
          applied: number;
          newAmountPaid: number;
          newBalance: number;
          newStatus: string;
        }> = [];
        const epsilon = 0.01; // treat very small balances as fully paid
        if (orderId) {
          const o = await tx.order.findUnique({ where: { id: orderId } });
          if (!o) throw new Error("Order not found");
          if (o.status !== "CANCELLED") {
            const paid = Number(o.amountPaid || 0);
            const total = Number(o.total);
            const remaining = Math.max(0, total - paid);
            const applyAmt = Math.min(amount, remaining);
            const newPaid = Math.max(0, paid + applyAmt);
            const rawBalance = total - newPaid;
            const newBalance = rawBalance <= epsilon ? 0 : Math.max(0, rawBalance);
            let newStatus =
              newBalance <= 0 ? "PAID" : newPaid > 0 ? "PARTIALLY_PAID" : "UNPAID";
            if (String(o.status || "").toUpperCase() === "ON_HOLD_CREDIT" && newBalance > 0) {
              newStatus = "ON_HOLD_CREDIT";
            }
            const updated = await tx.order.update({ where: { id: o.id }, data: { amountPaid: newPaid, balance: newBalance, status: newStatus } });
            applied.push({ orderId: updated.id, applied: applyAmt, newAmountPaid: newPaid, newBalance, newStatus });
          }
        } else if (userId) {
          let remainingPayment = amount;
          for (const o of beforeOrders) {
            if (remainingPayment <= 0) break;
            if (o.status === "CANCELLED") continue;
            const paid = Number(o.amountPaid || 0);
            const total = Number(o.total);
            const remaining = Math.max(0, total - paid);
            if (remaining <= 0) continue;
            const applyAmt = Math.min(remainingPayment, remaining);
            const newPaid = paid + applyAmt;
            const rawBalance = total - newPaid;
            const newBalance = rawBalance <= epsilon ? 0 : Math.max(0, rawBalance);
          let newStatus =
            newBalance <= 0 ? "PAID" : newPaid > 0 ? "PARTIALLY_PAID" : "UNPAID";
          if (String(o.status || "").toUpperCase() === "ON_HOLD_CREDIT" && newBalance > 0) {
            newStatus = "ON_HOLD_CREDIT";
          }
          const updated = await tx.order.update({ where: { id: o.id }, data: { amountPaid: newPaid, balance: newBalance, status: newStatus } });
            applied.push({ orderId: updated.id, applied: applyAmt, newAmountPaid: newPaid, newBalance, newStatus });
            remainingPayment -= applyAmt;
          }
        }

        const afterOrders = userId
          ? await tx.order.findMany({
              where: { userId, NOT: { status: "CANCELLED" } },
              select: { total: true, amountPaid: true },
            })
          : [];
        const totalDueAfter = afterOrders.reduce(
          (s: number, o: { total: unknown }) => s + Number(o.total || 0),
          0
        );
        const totalPaidAfter = afterOrders.reduce(
          (s: number, o: { amountPaid: unknown }) => s + Number(o.amountPaid || 0),
          0
        );
        const balanceAfter = Math.max(0, totalDueAfter - totalPaidAfter);
        const newMeta = {
          ...(currentMeta ?? {}),
          status: "success" as const,
          applied,
          ...(userId
            ? {
                preTotals: {
                  totalDue: totalDueBefore,
                  totalPaid: totalPaidBefore,
                  balance: balanceBefore,
                },
                postTotals: {
                  totalDue: totalDueAfter,
                  totalPaid: totalPaidAfter,
                  balance: balanceAfter,
                },
              }
            : {}),
        };
        await tx.payment.update({
          where: { id: payment.id },
          data: { note: JSON.stringify(newMeta) },
        });
        appliedNow = true;
      });
    }

    if (appliedNow) {
      let postingJournalEntryId: string | null = null;
      if (payment.userId) {
        try {
          const purpose = String((meta?.purpose as string | undefined) ?? "");
          const subject =
            purpose === "order_checkout"
              ? "Order Confirmation & Receipt"
              : "Payment received — updated receipt";
          await notifyPaymentEvent({
            kind: "payment_recorded",
            userId: payment.userId,
            amount: Number(payment.amount || 0),
            orderId: payment.orderId || undefined,
            subject,
          });
        } catch (e) {
          console.warn("notifyPaymentEvent (momo status) error:", e);
        }
      }
      try {
        const posted = await postPaymentEntry({ paymentId: payment.id });
        postingJournalEntryId = posted?.id || null;
      } catch (e) {
        console.warn("Accounting payment posting skipped:", e);
      }
      if (!postingJournalEntryId) {
        const existingPosted = await prisma.journalEntry.findFirst({
          where: {
            sourceType: "PAYMENT",
            status: "POSTED",
            OR: [
              { sourceId: payment.id },
              { sourceId: { startsWith: `${payment.id}:` } },
            ],
          },
          select: { id: true },
          orderBy: { createdAt: "desc" },
        });
        postingJournalEntryId = existingPosted?.id || null;
      }
      const orderAfter = payment.orderId
        ? (
            await prisma.order.findUnique({
              where: { id: payment.orderId },
              select: { balance: true, status: true, invoiceNumber: true },
            })
          )
        : null;
      const paymentAfter = await prisma.payment.findUnique({
        where: { id: payment.id },
        select: { note: true },
      });
      const parsedAfter = (() => {
        try {
          return paymentAfter?.note
            ? (JSON.parse(paymentAfter.note) as Record<string, unknown>)
            : null;
        } catch {
          return null;
        }
      })();
      const appliedRaw = Array.isArray(parsedAfter?.applied)
        ? (parsedAfter?.applied as Array<Record<string, unknown>>)
        : [];
      const appliedAllocations = appliedRaw
        .map((row) => {
          const allocOrderId = String(row.orderId || "").trim();
          const allocAmount = Number(row.applied || 0);
          const remainingAfter = Number(row.newBalance);
          if (!allocOrderId || !Number.isFinite(allocAmount) || allocAmount <= 0) return null;
          return {
            orderId: allocOrderId,
            amount: allocAmount,
            remainingAfter: Number.isFinite(remainingAfter) ? remainingAfter : null,
          };
        })
        .filter(
          (row): row is { orderId: string; amount: number; remainingAfter: number | null } =>
            Boolean(row),
        );
      const appliedTotal = appliedAllocations.reduce((s, row) => s + row.amount, 0);
      const preTotals = (parsedAfter?.preTotals as Record<string, unknown> | undefined) || null;
      const postTotals = (parsedAfter?.postTotals as Record<string, unknown> | undefined) || null;
      const allocationScope = String(parsedAfter?.allocationScope || meta?.allocationScope || "").trim();
      try {
        await recordAuditLog({
          actorId: isOwner ? user.id : null,
          action: "PAYMENT_SUCCESS",
          entityType: "PAYMENT",
          entityId: payment.id,
          meta: {
            actorType: isOwner ? "CUSTOMER" : "SYSTEM",
            source: "MOMO_STATUS_POLL",
            resolvedBy: "POLL",
            customerId: payment.userId || null,
            customerName: paymentCustomer?.name || null,
            customerEmail: paymentCustomer?.email || null,
            customerPhone: paymentCustomer?.phone || null,
            orderId: payment.orderId || null,
            paymentId: payment.id,
            amount: Number(payment.amount || 0),
            method: "momo",
            paymentMethodLabel: "MoMo",
            provider,
            providerRef: maskProviderRef(ref),
            providerStatus,
            invoiceNumber: orderAfter?.invoiceNumber || null,
            orderStatusAfter: orderAfter?.status || null,
            allocationScope: allocationScope || (payment.orderId ? "single_order" : "all_open_orders_oldest_first"),
            ordersAffected: appliedAllocations.map((row) => row.orderId),
            orderCount: appliedAllocations.length,
            appliedAllocations,
            appliedTotal,
            remainingBalanceBefore:
              preTotals && Number.isFinite(Number(preTotals.balance))
                ? Number(preTotals.balance)
                : null,
            remainingBalanceAfter:
              postTotals && Number.isFinite(Number(postTotals.balance))
                ? Number(postTotals.balance)
                : null,
            postingStatus: postingJournalEntryId ? "POSTED" : "PENDING",
            journalEntryId: postingJournalEntryId,
            balanceAfter:
              orderAfter?.balance == null ? null : Number(orderAfter.balance),
          },
        });
      } catch {}
    }

    // Self-heal: if provider confirms success but posting was missed earlier,
    // retry posting on status checks so MoMo monitor does not stay "Unposted".
    if (providerStatus === "SUCCESSFUL") {
      const existingPosted = await prisma.journalEntry.findFirst({
        where: {
          sourceType: "PAYMENT",
          status: "POSTED",
          OR: [{ sourceId: payment.id }, { sourceId: { startsWith: `${payment.id}:` } }],
        },
        select: { id: true },
      });
      if (!existingPosted) {
        try {
          await postPaymentEntry({ paymentId: payment.id });
        } catch (e) {
          console.warn("Accounting payment posting retry skipped (momo status success):", e);
        }
      }
    }

    return NextResponse.json({ ok: true, status: status.status });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
