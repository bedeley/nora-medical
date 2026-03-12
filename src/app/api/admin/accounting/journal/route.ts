import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { recordAuditLog } from "@/lib/audit-log";
import { findClosedPeriod } from "@/lib/accounting-periods";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

const lineSchema = z.object({
  accountId: z.string().min(1),
  debit: z.number().min(0),
  credit: z.number().min(0),
  description: z.string().max(200).optional(),
  taxCodeId: z.string().optional().nullable(),
});

const entrySchema = z
  .object({
    entryDate: z.string().min(1),
    memo: z.string().max(500).optional(),
    sourceType: z.enum(["ORDER", "PAYMENT", "EXPENSE", "PURCHASE", "PAYROLL", "MANUAL"]),
    sourceId: z.string().optional().nullable(),
    status: z.enum(["DRAFT", "POSTED", "VOID"]).optional(),
    lines: z.array(lineSchema).min(2),
  })
  .superRefine((data, ctx) => {
    let debitTotal = 0;
    let creditTotal = 0;
    data.lines.forEach((line, idx) => {
      if (line.debit > 0 && line.credit > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lines", idx],
          message: "Line cannot have both debit and credit.",
        });
      }
      if (line.debit <= 0 && line.credit <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lines", idx],
          message: "Line must have a debit or credit amount.",
        });
      }
      debitTotal += line.debit;
      creditTotal += line.credit;
    });
    if (Math.abs(debitTotal - creditTotal) > 0.01) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lines"],
        message: "Debits must equal credits.",
      });
    }
  });

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status");
  const sourceType = searchParams.get("sourceType");
  const start = searchParams.get("start");
  const end = searchParams.get("end");
  const includeArchive = searchParams.get("includeArchive") === "1";

  const where: {
    status?: "DRAFT" | "POSTED" | "VOID";
    sourceType?: "ORDER" | "PAYMENT" | "EXPENSE" | "PURCHASE" | "PAYROLL" | "MANUAL";
    entryDate?: { gte?: Date; lte?: Date };
    archivedAt?: Date | null;
  } = {};
  if (!includeArchive) {
    where.archivedAt = null;
  }
  if (status === "DRAFT" || status === "POSTED" || status === "VOID") {
    where.status = status;
  }
  if (
    sourceType === "ORDER" ||
    sourceType === "PAYMENT" ||
    sourceType === "EXPENSE" ||
    sourceType === "PURCHASE" ||
    sourceType === "PAYROLL" ||
    sourceType === "MANUAL"
  ) {
    where.sourceType = sourceType;
  }
  if (start || end) {
    where.entryDate = {};
    if (start) {
      if (YMD_RE.test(start)) {
        where.entryDate.gte = new Date(`${start}T00:00:00.000Z`);
      } else {
        where.entryDate.gte = new Date(start);
      }
    }
    if (end) {
      if (YMD_RE.test(end)) {
        where.entryDate.lte = new Date(`${end}T23:59:59.999Z`);
      } else {
        const endDate = new Date(end);
        endDate.setHours(23, 59, 59, 999);
        where.entryDate.lte = endDate;
      }
    }
  }
  const hasExplicitDateWindow = Boolean(start || end);
  if (!hasExplicitDateWindow && !includeArchive) {
    const configuredDays = Number(process.env.JOURNAL_RECENT_WINDOW_DAYS || "90");
    const recentWindowDays = Number.isFinite(configuredDays) && configuredDays > 0 ? Math.floor(configuredDays) : 90;
    const recentStart = new Date();
    recentStart.setUTCDate(recentStart.getUTCDate() - recentWindowDays);
    recentStart.setUTCHours(0, 0, 0, 0);
    where.entryDate = {
      ...(where.entryDate || {}),
      gte: recentStart,
    };
  }

  const entries = await prisma.journalEntry.findMany({
    where,
    orderBy: [{ entryDate: "desc" }, { createdAt: "desc" }],
    include: {
      approvedBy: { select: { id: true, name: true, email: true } },
      lines: {
        include: {
          account: true,
          taxCode: true,
        },
      },
    },
  });
  const orderIds = entries
    .filter((entry) => entry.sourceType === "ORDER" && entry.sourceId)
    .map((entry) => entry.sourceId as string);
  const paymentIds = entries
    .filter((entry) => entry.sourceType === "PAYMENT" && entry.sourceId)
    .map((entry) => String(entry.sourceId || "").split(":")[0] || "")
    .filter(Boolean);
  const purchaseSourceIds = entries
    .filter((entry) => entry.sourceType === "PURCHASE" && entry.sourceId)
    .map((entry) => entry.sourceId as string);

  const [orders, payments, purchaseSources, supplierPaymentSources] = await Promise.all([
    orderIds.length
      ? prisma.order.findMany({
          where: { id: { in: orderIds } },
          select: { id: true, invoiceNumber: true, receiptHash: true },
        })
      : Promise.resolve([]),
    paymentIds.length
      ? prisma.payment.findMany({
          where: { id: { in: paymentIds } },
          select: { id: true, orderId: true },
        })
      : Promise.resolve([]),
    purchaseSourceIds.length
      ? prisma.purchase.findMany({
          where: { id: { in: purchaseSourceIds } },
          select: { id: true, supplierId: true, supplier: true, unitCost: true, quantity: true },
        })
      : Promise.resolve([]),
    purchaseSourceIds.length
      ? prisma.supplierPayment.findMany({
          where: { id: { in: purchaseSourceIds } },
          select: { id: true, purchaseId: true },
        })
      : Promise.resolve([]),
  ]);
  const paymentOrderIds = payments.map((payment) => payment.orderId).filter(Boolean) as string[];
  const paymentOrders = paymentOrderIds.length
    ? await prisma.order.findMany({
        where: { id: { in: paymentOrderIds } },
        select: { id: true, invoiceNumber: true, receiptHash: true },
      })
    : [];

  const invoiceByOrderId = new Map(
    [...orders, ...paymentOrders].map((order) => [
      order.id,
      `${order.invoiceNumber || ""} ${order.receiptHash || ""}`.trim(),
    ] as const),
  );
  const invoiceByPaymentId = new Map(
    payments.map((payment) => [payment.id, invoiceByOrderId.get(payment.orderId || "") || ""]),
  );
  const purchaseIdsFromPayments = supplierPaymentSources
    .map((sp) => sp.purchaseId)
    .filter(Boolean) as string[];
  const purchaseIds = Array.from(new Set([
    ...purchaseSources.map((p) => p.id),
    ...purchaseIdsFromPayments,
  ]));
  const purchasesById = new Map(purchaseSources.map((p) => [p.id, p]));
  if (purchaseIds.length > 0) {
    const missingIds = purchaseIds.filter((id) => !purchasesById.has(id));
    if (missingIds.length > 0) {
      const missingPurchases = await prisma.purchase.findMany({
        where: { id: { in: missingIds } },
        select: { id: true, supplierId: true, supplier: true, unitCost: true, quantity: true },
      });
      for (const p of missingPurchases) {
        purchasesById.set(p.id, p);
      }
    }
  }
  const paidByPurchase = new Map<string, number>();
  if (purchaseIds.length > 0) {
    const paymentSums = await prisma.supplierPayment.groupBy({
      by: ["purchaseId"],
      where: { deletedAt: null, status: "NORMAL", purchaseId: { in: purchaseIds } },
      _sum: { amount: true },
    });
    for (const row of paymentSums) {
      if (row.purchaseId) paidByPurchase.set(row.purchaseId, Number(row._sum.amount || 0));
    }
  }
  const purchaseIdBySupplierPaymentId = new Map(
    supplierPaymentSources.map((sp) => [sp.id, sp.purchaseId]).filter(([, pid]) => Boolean(pid)) as [string, string][],
  );
  const apBalanceByEntryId = new Map<string, number>();
  for (const entry of entries) {
    if (entry.sourceType !== "PURCHASE" || !entry.sourceId) continue;
    let purchaseId = entry.sourceId;
    if (!purchasesById.has(purchaseId) && purchaseIdBySupplierPaymentId.has(purchaseId)) {
      purchaseId = purchaseIdBySupplierPaymentId.get(purchaseId) as string;
    }
    const purchase = purchasesById.get(purchaseId);
    if (!purchase) continue;
    const total = Number(purchase.unitCost || 0) * Number(purchase.quantity || 0);
    const paid = paidByPurchase.get(purchaseId) || 0;
    const outstanding = Math.max(0, total - paid);
    apBalanceByEntryId.set(entry.id, outstanding);
  }

  const enriched = entries.map((entry) => {
    if (entry.sourceType !== "ORDER" || !entry.sourceId) return entry;
    return {
      ...entry,
      sourceLabel: invoiceByOrderId.get(entry.sourceId) || null,
    };
  });
  const enrichedWithPayments = enriched.map((entry) => {
    if (entry.sourceType !== "PAYMENT" || !entry.sourceId) return entry;
    const paymentId = String(entry.sourceId || "").split(":")[0] || "";
    return {
      ...entry,
      sourceLabel: invoiceByPaymentId.get(paymentId) || null,
    };
  });
  const enrichedWithAp = enrichedWithPayments.map((entry) => ({
    ...entry,
    apBalanceAfter: apBalanceByEntryId.get(entry.id) ?? null,
  }));
  return NextResponse.json(enrichedWithAp);
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  try {
    const body = await req.json();
    const parsed = entrySchema.safeParse({
      ...body,
      status: body.status ?? "POSTED",
      sourceId: body.sourceId || null,
      lines: Array.isArray(body.lines)
        ? body.lines.map((line: { debit?: unknown; credit?: unknown }) => ({
            ...line,
            debit: Number(line.debit || 0),
            credit: Number(line.credit || 0),
          }))
        : [],
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const user = session.user as AuthenticatedUser;
    const isManual = parsed.data.sourceType === "MANUAL";
    if (isManual && user.role !== "ADMIN") {
      return NextResponse.json(
        { error: "Manual journal entries are limited to admins." },
        { status: 403 },
      );
    }
    if (isManual && !parsed.data.memo?.trim()) {
      return NextResponse.json(
        { error: "Manual journal entries require a reason in the memo field." },
        { status: 400 },
      );
    }
    if (isManual) {
      const allowPnl =
        (process.env.ACCOUNTING_MANUAL_ENTRY_ALLOW_PNL || "").toLowerCase() === "1";
      const accountIds = Array.from(
        new Set(parsed.data.lines.map((line) => line.accountId)),
      );
      const accounts = await prisma.ledgerAccount.findMany({
        where: { id: { in: accountIds } },
        select: { id: true, type: true },
      });
      const typesById = new Map(accounts.map((acc) => [acc.id, acc.type]));
      const invalid = accountIds.filter((id) => {
        const type = typesById.get(id);
        if (!type) return true;
        if (allowPnl) return false;
        return type === "INCOME" || type === "EXPENSE";
      });
      if (invalid.length > 0) {
        return NextResponse.json(
          {
            error:
              "Manual entries cannot post to Income/Expense accounts unless ACCOUNTING_MANUAL_ENTRY_ALLOW_PNL=1.",
          },
          { status: 400 },
        );
      }
    }

    const entryDate = new Date(parsed.data.entryDate);
    const closedPeriod = await findClosedPeriod(entryDate);
    if (closedPeriod) {
      return NextResponse.json(
        { error: `Period "${closedPeriod.name}" is closed.` },
        { status: 400 },
      );
    }

    const entry = await prisma.journalEntry.create({
      data: {
        entryDate,
        memo: parsed.data.memo,
        sourceType: parsed.data.sourceType,
        sourceId: parsed.data.sourceId ?? null,
        status: parsed.data.status ?? "POSTED",
        approvedById: parsed.data.status === "POSTED" ? (session.user as AuthenticatedUser).id : null,
        approvedAt: parsed.data.status === "POSTED" ? new Date() : null,
        lines: {
          create: parsed.data.lines.map((line) => ({
            accountId: line.accountId,
            debit: line.debit,
            credit: line.credit,
            description: line.description,
            taxCodeId: line.taxCodeId ?? null,
          })),
        },
      },
      include: {
        lines: true,
      },
    });
    await recordAuditLog({
      actorId: (session.user as AuthenticatedUser).id,
      action: parsed.data.status === "POSTED" ? "journal.post" : "journal.create",
      entityType: "JournalEntry",
      entityId: entry.id,
      meta: { status: parsed.data.status ?? "POSTED" },
    });
    return NextResponse.json(entry);
  } catch (error) {
    console.error("Accounting journal create error:", error);
    return NextResponse.json({ error: "Failed to create journal entry" }, { status: 500 });
  }
}
