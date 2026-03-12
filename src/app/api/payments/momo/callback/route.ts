import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { notifyPaymentEvent } from "@/lib/notifications";
import { parseMomoCallbackBody, verifyMomoSignature } from "@/lib/momo";
import { postPaymentEntry } from "@/lib/accounting-posting";
import { Prisma } from "@prisma/client";
import { recordAuditLog } from "@/lib/audit-log";

type TxClient = Parameters<typeof prisma.$transaction>[0] extends (arg: infer A) => unknown ? A : never;

export const runtime = "nodejs";
function maskProviderRef(value: string | null | undefined) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (raw.length <= 8) return `${raw.slice(0, 2)}***${raw.slice(-2)}`;
  return `${raw.slice(0, 4)}***${raw.slice(-4)}`;
}

function parsePaymentNote(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  try {
    const rawBody = await req.text();
    if (!verifyMomoSignature(rawBody, req.headers)) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
    }
    const parsed = parseMomoCallbackBody(rawBody);
    if (!parsed.valid || !parsed.externalId) {
      return NextResponse.json({ error: "Invalid callback" }, { status: 400 });
    }

    const paymentId = parsed.externalId;
    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) return NextResponse.json({ error: "Payment not found" }, { status: 404 });
    const paymentCustomer = payment.userId
      ? await prisma.user.findUnique({
          where: { id: payment.userId },
          select: { name: true, email: true, phone: true },
        })
      : null;
    const paymentMeta = parsePaymentNote(payment.note);
    const providerRef = String((paymentMeta?.providerRef as string | undefined) || "");

    const amount = Number(payment.amount || 0);
    const userIdForNotification = payment.userId || undefined;
    let purpose = "";

    const maxSerializableRetries = 3;
    let attempt = 0;
    let callbackSuccessful = false;
    let callbackAlreadyApplied = false;
    while (attempt < maxSerializableRetries) {
      try {
        const txResult = await prisma.$transaction(
          async (tx: TxClient) => {
            const fresh = await tx.payment.findUnique({ where: { id: payment.id } });
            if (!fresh) throw new Error("Payment disappeared");

            const note = parsePaymentNote(fresh.note);
            purpose = String((note?.purpose as string | undefined) ?? purpose);
            const forcePendingForTest = Boolean((note as { forcePendingForTest?: unknown } | null)?.forcePendingForTest);
            const alreadyDone = (note as { status?: string } | null)?.status === "success";
            if (alreadyDone) {
              return { alreadyDone: true as const };
            }
            const localStatus = String((note?.status as string | undefined) ?? "").toUpperCase();
            if (localStatus === "CANCELLED_BY_STAFF" && (parsed.status || "").toUpperCase() === "SUCCESSFUL") {
              const withLate = {
                ...(note ?? {}),
                status: "late_success_after_cancel" as const,
                providerStatus: parsed.status,
              };
              await tx.payment.update({
                where: { id: payment.id },
                data: { note: JSON.stringify(withLate) },
              });
              return { alreadyDone: false as const, successful: false as const };
            }

            if ((parsed.status || "").toUpperCase() !== "SUCCESSFUL") {
              const meta = {
                ...(note ?? {}),
                status: "failed" as const,
                providerStatus: parsed.status,
              };
              await tx.payment.update({
                where: { id: payment.id },
                data: { note: JSON.stringify(meta) },
              });
              return { alreadyDone: false as const, successful: false as const };
            }
            if (forcePendingForTest) {
              const keepPending = {
                ...(note ?? {}),
                status: "pending_forced_test" as const,
                providerStatus: parsed.status,
              };
              await tx.payment.update({
                where: { id: payment.id },
                data: { note: JSON.stringify(keepPending) },
              });
              return { alreadyDone: false as const, successful: false as const };
            }

            const userId = fresh.userId || undefined;
            const orderId = fresh.orderId || undefined;
            const beforeOrders = userId
              ? await tx.order.findMany({
                  where: { userId, NOT: { status: "CANCELLED" } },
                  select: { id: true, total: true, amountPaid: true, status: true },
                  orderBy: { createdAt: "asc" },
                })
              : [];
            const totalDueBefore = beforeOrders.reduce(
              (s: number, o: { total: unknown }) => s + Number(o.total || 0),
              0,
            );
            const totalPaidBefore = beforeOrders.reduce(
              (s: number, o: { amountPaid: unknown }) => s + Number(o.amountPaid || 0),
              0,
            );

            const applied: Array<{
              orderId: string;
              applied: number;
              newAmountPaid: number;
              newBalance: number;
              newStatus: string;
            }> = [];

            if (orderId) {
              const o = await tx.order.findUnique({ where: { id: orderId } });
              if (!o) throw new Error("Order not found");
              if (o.status === "CANCELLED") throw new Error("Cannot apply to cancelled order");
              const currentPaid = Number(o.amountPaid || 0);
              const total = Number(o.total);
              const remaining = Math.max(0, total - currentPaid);
              const applyAmt = Math.min(amount, remaining);
              const newAmountPaid = Math.max(0, currentPaid + applyAmt);
              const newBalance = Math.max(0, total - newAmountPaid);
              let newStatus =
                newBalance <= 0 ? "PAID" : newAmountPaid > 0 ? "PARTIALLY_PAID" : "UNPAID";
              if (String(o.status || "").toUpperCase() === "ON_HOLD_CREDIT" && newBalance > 0) {
                newStatus = "ON_HOLD_CREDIT";
              }
              const updated = await tx.order.update({
                where: { id: o.id },
                data: { amountPaid: newAmountPaid, balance: newBalance, status: newStatus },
              });
              applied.push({
                orderId: updated.id,
                applied: applyAmt,
                newAmountPaid,
                newBalance,
                newStatus,
              });
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
                const newAmountPaid = paid + applyAmt;
                const newBalance = Math.max(0, total - newAmountPaid);
                let newStatus =
                  newBalance <= 0 ? "PAID" : newAmountPaid > 0 ? "PARTIALLY_PAID" : "UNPAID";
                if (String(o.status || "").toUpperCase() === "ON_HOLD_CREDIT" && newBalance > 0) {
                  newStatus = "ON_HOLD_CREDIT";
                }
                const updated = await tx.order.update({
                  where: { id: o.id },
                  data: { amountPaid: newAmountPaid, balance: newBalance, status: newStatus },
                });
                applied.push({
                  orderId: updated.id,
                  applied: applyAmt,
                  newAmountPaid,
                  newBalance,
                  newStatus,
                });
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
              0,
            );
            const totalPaidAfter = afterOrders.reduce(
              (s: number, o: { amountPaid: unknown }) => s + Number(o.amountPaid || 0),
              0,
            );
            const balanceAfter = Math.max(0, totalDueAfter - totalPaidAfter);

            const meta = {
              ...(note ?? {}),
              status: "success" as const,
              applied,
              ...(userId
                ? {
                    preTotals: {
                      totalDue: totalDueBefore,
                      totalPaid: totalPaidBefore,
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
              data: { note: JSON.stringify(meta) },
            });

            return { alreadyDone: false as const, successful: true as const };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );

        if (txResult.alreadyDone) {
          callbackAlreadyApplied = true;
          break;
        }
        if (!txResult.successful) {
          callbackSuccessful = false;
          break;
        }
        callbackSuccessful = true;
        break;
      } catch (e: unknown) {
        const isSerializationConflict =
          e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2034";
        attempt += 1;
        if (!isSerializationConflict || attempt >= maxSerializableRetries) {
          throw e;
        }
      }
    }
    if (callbackAlreadyApplied) {
      try {
        await recordAuditLog({
          actorId: null,
          action: "PAYMENT_PROVIDER_CALLBACK",
          entityType: "PAYMENT",
          entityId: payment.id,
          meta: {
            actorType: "SYSTEM",
            source: "MOMO_CALLBACK",
            customerId: payment.userId || null,
            customerName: paymentCustomer?.name || null,
            customerEmail: paymentCustomer?.email || null,
            customerPhone: paymentCustomer?.phone || null,
            orderId: payment.orderId || null,
            providerStatus: parsed.status || null,
            providerRef: maskProviderRef(providerRef),
            mappedStatus: "ALREADY_APPLIED",
          },
        });
      } catch {}
      return NextResponse.json({ ok: true });
    }
    if (!callbackSuccessful) {
      try {
        await postPaymentEntry({ paymentId: payment.id });
      } catch (e) {
        console.warn("Accounting payment posting skipped (momo callback non-success):", e);
      }
      try {
        await recordAuditLog({
          actorId: null,
          action: "PAYMENT_PROVIDER_CALLBACK",
          entityType: "PAYMENT",
          entityId: payment.id,
          meta: {
            actorType: "SYSTEM",
            source: "MOMO_CALLBACK",
            customerId: payment.userId || null,
            customerName: paymentCustomer?.name || null,
            customerEmail: paymentCustomer?.email || null,
            customerPhone: paymentCustomer?.phone || null,
            orderId: payment.orderId || null,
            providerStatus: parsed.status || null,
            providerRef: maskProviderRef(providerRef),
            mappedStatus: "FAILED_OR_PENDING",
          },
        });
      } catch {}
      return NextResponse.json({ ok: true });
    }

    // Notify customer about successful MoMo payment
    try {
      if (userIdForNotification) {
        const subject =
          purpose === "order_checkout"
            ? "Order Confirmation & Receipt"
            : "Payment received — updated receipt";
        await notifyPaymentEvent({
          kind: "payment_recorded",
          userId: userIdForNotification,
          amount,
          orderId: payment.orderId || undefined,
          subject,
        });
      }
    } catch (e) {
      console.warn("notifyPaymentEvent (momo callback) error:", e);
    }
    let postingJournalEntryId: string | null = null;
    try {
      const posted = await postPaymentEntry({ paymentId: payment.id });
      postingJournalEntryId = posted?.id || null;
    } catch (e) {
      console.warn("Accounting payment posting skipped (momo callback):", e);
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
    const allocationScope = String(parsedAfter?.allocationScope || "").trim();
    try {
      await recordAuditLog({
        actorId: null,
        action: "PAYMENT_PROVIDER_CALLBACK",
        entityType: "PAYMENT",
        entityId: payment.id,
        meta: {
          actorType: "SYSTEM",
          source: "MOMO_CALLBACK",
          customerId: payment.userId || null,
          customerName: paymentCustomer?.name || null,
          customerEmail: paymentCustomer?.email || null,
          customerPhone: paymentCustomer?.phone || null,
          orderId: payment.orderId || null,
          amount,
          providerStatus: parsed.status || null,
          providerRef: maskProviderRef(providerRef),
          mappedStatus: "SUCCESS",
        },
      });
      await recordAuditLog({
        actorId: payment.userId || null,
        action: "PAYMENT_SUCCESS",
        entityType: "PAYMENT",
        entityId: payment.id,
        meta: {
          actorType: "CUSTOMER",
          source: "MOMO_CALLBACK",
          resolvedBy: "CALLBACK",
          customerId: payment.userId || null,
          customerName: paymentCustomer?.name || null,
          customerEmail: paymentCustomer?.email || null,
          customerPhone: paymentCustomer?.phone || null,
          orderId: payment.orderId || null,
          paymentId: payment.id,
          amount,
          method: "momo",
          paymentMethodLabel: "MoMo",
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
          providerRef: maskProviderRef(providerRef),
          postingStatus: postingJournalEntryId ? "POSTED" : "PENDING",
          journalEntryId: postingJournalEntryId,
          balanceAfter:
            orderAfter?.balance == null ? null : Number(orderAfter.balance),
        },
      });
    } catch {}

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Callback error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
