import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PaymentStatus, RefundDestination } from "@/lib/prisma-enums";
import { assertSameOrigin } from "@/lib/origin";
import { recomputeOrderTotalsFromPayments } from "@/lib/payments";
import { postPaymentEntry } from "@/lib/accounting-posting";
import { recordAuditLog } from "@/lib/audit-log";
import { randomUUID } from "crypto";
import { rateLimit } from "@/lib/rate-limit";
import {
  buildCustomerActorTargetMeta,
  canApproveEmployeeCustomerFinancialChange,
} from "@/lib/customer-account-policy";

type TxClient = Parameters<(typeof prisma)["$transaction"]>[0] extends (
  arg: infer A,
) => unknown
  ? A
  : never;

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> | { id: string } }
) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = session.user as AuthenticatedUser;
  const role = user.role;
  const isAdmin = role === "ADMIN";
  const isAccountant = role === "ACCOUNTANT";
  if (!isAdmin && !isAccountant) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const limited = await rateLimit(req, "admin-credit-apply", 60_000, 30);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const params = await context.params;
  const userId = params.id;

  try {
    const targetCustomerForApproval = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, role: true },
    });
    if (!targetCustomerForApproval) {
      return NextResponse.json({ error: "Customer not found" }, { status: 404 });
    }
    if (
      !canApproveEmployeeCustomerFinancialChange({
        actorRole: user.role,
        targetRole: targetCustomerForApproval.role,
      })
    ) {
      await recordAuditLog({
        actorId: user.id,
        action: "STORE_CREDIT_APPLY_DENIED",
        entityType: "USER",
        entityId: userId,
        request: req,
        outcome: "FAILED",
        meta: {
          ...buildCustomerActorTargetMeta({
            actorId: user.id,
            actorRole: user.role,
            targetId: userId,
            targetRole: targetCustomerForApproval.role,
          }),
          customerName: targetCustomerForApproval.name,
          customerEmail: targetCustomerForApproval.email,
          sourcePage: "admin/customers",
          sourceRoute: `/api/admin/customers/${userId}/credit/apply`,
          reason: "ADMIN_APPROVAL_REQUIRED_FOR_EMPLOYEE_CUSTOMER",
        },
      });
      return NextResponse.json(
        { error: "Admin approval is required to apply store credit on employee-owned accounts." },
        { status: 403 },
      );
    }

    const result = await prisma.$transaction(async (tx: TxClient) => {
      const customer = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, email: true, role: true },
      });
      if (!customer) {
        throw new Error("CUSTOMER_NOT_FOUND");
      }
      const orders = await tx.order.findMany({
        where: { userId, NOT: { status: "CANCELLED" } },
        select: {
          id: true,
          invoiceNumber: true,
          total: true,
          amountPaid: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      });
      const payments = await tx.payment.findMany({
        where: {
          userId,
        },
        select: { amount: true, status: true, refundDisposition: true, note: true },
      });

      const totalDue = orders.reduce(
        (s, o) => s + Number(o.total || 0),
        0,
      );
      const totalPaid = orders.reduce(
        (s, o) => s + Number(o.amountPaid || 0),
        0,
      );
      const balance = Math.max(0, totalDue - totalPaid);
      const openOrders = orders
        .map((order) => {
          const total = Number(order.total ?? 0);
          const paid = Number(order.amountPaid ?? 0);
          const remaining = Math.max(0, total - paid);
          return remaining > 0
            ? {
                orderId: order.id,
                invoiceNumber: order.invoiceNumber ?? null,
                balanceBefore: remaining,
              }
            : null;
        })
        .filter(
          (
            entry,
          ): entry is {
            orderId: string;
            invoiceNumber: string | null;
            balanceBefore: number;
          } => entry !== null,
        );

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
          p.status === PaymentStatus.NORMAL &&
          p.refundDisposition === RefundDestination.CREDIT &&
          amount > 0;
        const isCreditCashPayout =
          p.status === PaymentStatus.REFUND &&
          p.refundDisposition === RefundDestination.CASH &&
          note.includes("\"location\":\"admin/customers:credit-payout\"");

        if (isCreditIssued) {
          credit += amount;
        } else if (isAutoApply) {
          credit -= amount;
        } else if (isCreditCashPayout) {
          // amount is negative; reduce credit
          credit += amount;
        }
      }
      credit = Math.max(0, credit);

      if (balance <= 0.005 || credit <= 0.005) {
        return {
          customerName: customer?.name ?? null,
          customerEmail: customer?.email ?? null,
          customerRole: customer?.role ?? null,
          actorTargetMeta: buildCustomerActorTargetMeta({
            actorId: user.id,
            actorRole: user.role,
            targetId: userId,
            targetRole: customer.role,
          }),
          applied: 0,
          creditBefore: credit,
          balanceBefore: balance,
          remainingBalance: balance,
          remainingCredit: credit,
          createdPaymentIds: [],
          allocations: [],
          openOrderCount: openOrders.length,
          openOrders,
          totalDueBefore: totalDue,
          totalPaidBefore: totalPaid,
          totalDueAfter: totalDue,
          totalPaidAfter: totalPaid,
        };
      }

      const amountToApply = Math.min(balance, credit);
      const totalDueBefore = totalDue;
      const totalPaidBefore = totalPaid;
      const balanceBefore = balance;

      const meta = {
        note: "Admin-applied store credit",
        method: "adjustment",
        reference: "AUTO_APPLY",
        receivedBy: user.email || user.name || "admin",
        location: "admin/customers/credit/apply",
        status: "normal",
        preTotals: {
          totalDue: totalDueBefore,
          totalPaid: totalPaidBefore,
          balance: balanceBefore,
        },
      };

      let remainingPayment = amountToApply;
      const applied: Array<{
        orderId: string;
        applied: number;
        newAmountPaid: number;
        newBalance: number;
        newStatus: string;
      }> = [];
      const batchId = randomUUID();
      const createdPayments: Array<{ id: string; orderId: string; applied: number }> = [];

      for (const o of orders) {
        if (remainingPayment <= 0) break;
        const paid = Number(o.amountPaid ?? 0);
        const total = Number(o.total);
        const remaining = Math.max(0, total - paid);
        if (remaining <= 0) continue;
        const applyAmt = Math.min(remainingPayment, remaining);
        const payment = await tx.payment.create({
          data: {
            userId,
            orderId: o.id,
            amount: applyAmt,
            note: JSON.stringify({
              ...meta,
              batchId,
              applied: [{ orderId: o.id, applied: applyAmt }],
            }),
            status: PaymentStatus.NORMAL,
            refundDisposition: null,
          },
        });
        createdPayments.push({ id: payment.id, orderId: o.id, applied: applyAmt });

        const updated = await recomputeOrderTotalsFromPayments(tx, o.id);
        applied.push({
          orderId: updated.id,
          applied: applyAmt,
          newAmountPaid: Number(updated.amountPaid ?? 0),
          newBalance: Number(updated.balance ?? 0),
          newStatus: String(updated.status),
        });
        remainingPayment -= applyAmt;
      }

      const afterOrders = await tx.order.findMany({
        where: { userId, NOT: { status: "CANCELLED" } },
        select: { total: true, amountPaid: true },
      });
      const totalDueAfter = afterOrders.reduce(
        (s: number, o: { total: unknown }) => s + Number(o.total || 0),
        0,
      );
      const totalPaidAfter = afterOrders.reduce(
        (s: number, o: { amountPaid: unknown }) =>
          s + Number(o.amountPaid || 0),
        0,
      );
      const balanceAfter = Math.max(0, totalDueAfter - totalPaidAfter);

      if (createdPayments.length > 0) {
        try {
          const withAppliedBase = {
            ...meta,
            batchId,
            batchAppliedTotal: amountToApply,
            batchAppliedCount: createdPayments.length,
            postTotals: {
              totalDue: totalDueAfter,
              totalPaid: totalPaidAfter,
              balance: balanceAfter,
            },
          };
          for (const row of createdPayments) {
            await tx.payment.update({
              where: { id: row.id },
              data: {
                note: JSON.stringify({
                  ...withAppliedBase,
                  applied: [{ orderId: row.orderId, applied: row.applied }],
                }),
              },
            });
          }
        } catch {
          // best-effort to enrich metadata
        }
      }

      const remainingCredit = Math.max(0, credit - amountToApply);

      return {
        customerName: customer?.name ?? null,
        customerEmail: customer?.email ?? null,
        customerRole: customer?.role ?? null,
        actorTargetMeta: buildCustomerActorTargetMeta({
          actorId: user.id,
          actorRole: user.role,
          targetId: userId,
          targetRole: customer.role,
        }),
        applied: amountToApply,
        creditBefore: credit,
        balanceBefore,
        remainingBalance: balanceAfter,
        remainingCredit,
        createdPaymentIds: createdPayments.map((p) => p.id),
        allocations: applied.map((entry) => ({
          orderId: entry.orderId,
          applied: entry.applied,
          newAmountPaid: entry.newAmountPaid,
          newBalance: entry.newBalance,
          newStatus: entry.newStatus,
          invoiceNumber:
            orders.find((order) => order.id === entry.orderId)?.invoiceNumber ?? null,
        })),
        openOrderCount: openOrders.length,
        openOrders,
        totalDueBefore,
        totalPaidBefore,
        totalDueAfter,
        totalPaidAfter,
      };
    });

    const postingFailures: Array<{ paymentId: string; error: string }> = [];
    for (const paymentId of result.createdPaymentIds) {
      try {
        await postPaymentEntry({ paymentId });
      } catch (error) {
        console.warn("postPaymentEntry (admin credit apply) error:", error);
        postingFailures.push({
          paymentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (result.applied > 0) {
      try {
        await recordAuditLog({
          actorId: user.id,
          action: "STORE_CREDIT_APPLY",
          entityType: "CUSTOMER",
          entityId: userId,
          request: req,
          outcome: postingFailures.length > 0 ? "PARTIAL" : "SUCCESS",
          meta: {
            customerId: userId,
            customerName: result.customerName,
            customerEmail: result.customerEmail,
            customerRole: result.customerRole,
            ...result.actorTargetMeta,
            changedByName: user.name || user.email || null,
            changedByEmail: user.email || null,
            changedByRole: user.role || null,
            sourcePage: "admin/customers",
            sourceRoute: `/api/admin/customers/${userId}/credit/apply`,
            appliedAmount: result.applied,
            creditBefore: result.creditBefore,
            creditAfter: result.remainingCredit,
            balanceBefore: result.balanceBefore,
            balanceAfter: result.remainingBalance,
            totalDueBefore: result.totalDueBefore,
            totalPaidBefore: result.totalPaidBefore,
            totalDueAfter: result.totalDueAfter,
            totalPaidAfter: result.totalPaidAfter,
            openOrderCount: result.openOrderCount,
            openOrders: result.openOrders,
            allocations: result.allocations,
            createdPaymentIds: result.createdPaymentIds,
            postingFailureCount: postingFailures.length,
            failedPaymentIds: postingFailures.map((entry) => entry.paymentId),
          },
        });
      } catch {
        // best-effort
      }
    }

    for (const failure of postingFailures) {
      try {
        await recordAuditLog({
          actorId: user.id,
          action: "ACCOUNTING_POST_FAILED",
          entityType: "PAYMENT",
          entityId: failure.paymentId,
          request: req,
          outcome: "FAILED",
          meta: {
            customerId: userId,
            customerName: result.customerName,
            customerRole: result.customerRole,
            ...result.actorTargetMeta,
            sourcePage: "admin/customers",
            sourceRoute: `/api/admin/customers/${userId}/credit/apply`,
            reason: "store_credit_apply",
            error: failure.error,
          },
        });
      } catch {
        // best-effort
      }
    }

    return NextResponse.json({
      applied: result.applied,
      remainingBalance: result.remainingBalance,
      remainingCredit: result.remainingCredit,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message === "CUSTOMER_NOT_FOUND") {
      return NextResponse.json({ error: "Customer not found" }, { status: 404 });
    }
    if (message === "EMPLOYEE_CUSTOMER_ADMIN_APPROVAL_REQUIRED") {
      try {
        await recordAuditLog({
          actorId: user.id,
          action: "STORE_CREDIT_APPLY_DENIED",
          entityType: "USER",
          entityId: userId,
          request: req,
          outcome: "FAILED",
          meta: {
            actorId: user.id,
            actorRole: user.role || null,
            targetCustomerId: userId,
            sourcePage: "admin/customers",
            sourceRoute: `/api/admin/customers/${userId}/credit/apply`,
            reason: "ADMIN_APPROVAL_REQUIRED_FOR_EMPLOYEE_CUSTOMER",
          },
        });
      } catch {
        // best-effort
      }
      return NextResponse.json(
        { error: "Admin approval is required to apply store credit on employee-owned accounts." },
        { status: 403 },
      );
    }
    console.error("Admin apply credit error", e);
    return NextResponse.json(
      { error: "Failed to apply store credit" },
      { status: 500 },
    );
  }
}
