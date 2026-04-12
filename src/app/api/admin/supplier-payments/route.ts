import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Prisma, PurchaseStatus } from "@prisma/client";
import { postSupplierPaymentEntry, postSupplierRefundEntry } from "@/lib/accounting-posting";
import { hasPermission } from "@/lib/permissions";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";

const DEFAULT_SOURCE_PAGE = "admin/supplier-payments";

function resolvePayableQuantity(purchase: {
  status: string;
  quantity?: number | null;
  orderedQuantity?: number | null;
  receivedQuantity?: number | null;
}) {
  const receivedQty = Number(purchase.receivedQuantity ?? 0);
  const orderedQty = Number(purchase.orderedQuantity ?? purchase.quantity ?? 0);
  const fallbackQty = orderedQty > 0 ? orderedQty : Number(purchase.quantity ?? 0);
  const includeWithoutReceipt =
    purchase.status === "APPROVED" ||
    purchase.status === "ORDERED" ||
    purchase.status === "RECEIVED" ||
    purchase.status === "PARTIALLY_RECEIVED";
  const baseQty =
    receivedQty > 0
      ? receivedQty
      : includeWithoutReceipt
      ? fallbackQty
      : 0;
  const excludeUnreceived =
    receivedQty <= 0 &&
    !includeWithoutReceipt &&
    !["APPROVED", "ORDERED", "RECEIVED", "PARTIALLY_RECEIVED"].includes(purchase.status);
  const exclude = purchase.status === "CANCELLED" && receivedQty <= 0;
  return { qty: Math.max(0, baseQty), exclude: exclude || excludeUnreceived };
}

function parseMonth(m?: string) {
  if (!m) return null;
  const [y, mm] = m.split("-");
  const year = Number(y);
  const month = Number(mm);
  if (!year || !month || month < 1 || month > 12) return null;
  const from = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  const to = new Date(Date.UTC(year, month, 1, 0, 0, 0));
  return { from, to };
}

type SortMode = "newest" | "oldest" | "amount_desc" | "amount_asc";
type ExposureView = "full" | "received";
type AgingFilter =
  | "all"
  | "due_today"
  | "due_7"
  | "overdue"
  | "0_30"
  | "31_60"
  | "61_90"
  | "90_plus";

function sortRows<T extends { createdAt: string; total?: number; amount?: number }>(
  items: T[],
  sortMode: SortMode,
) {
  const list = [...items];
  list.sort((a, b) => {
    if (sortMode === "amount_desc") return Number(b.total ?? b.amount ?? 0) - Number(a.total ?? a.amount ?? 0);
    if (sortMode === "amount_asc") return Number(a.total ?? a.amount ?? 0) - Number(b.total ?? b.amount ?? 0);
    const delta = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    return sortMode === "newest" ? delta : -delta;
  });
  return list;
}

function daysBetween(fromIso: string, toDate = new Date()) {
  const from = new Date(fromIso);
  const ms = toDate.getTime() - from.getTime();
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

function getAgingBucket(days: number) {
  if (days <= 30) return "0_30";
  if (days <= 60) return "31_60";
  if (days <= 90) return "61_90";
  return "90_plus";
}

function expectedDiffDays(expectedAt: string | null, today = new Date()) {
  if (!expectedAt) return null;
  const expected = new Date(expectedAt);
  const expectedDay = new Date(expected.getFullYear(), expected.getMonth(), expected.getDate());
  const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.floor((expectedDay.getTime() - todayDay.getTime()) / (1000 * 60 * 60 * 24));
}

function normalizeSortMode(raw: string | null, fallbackSortDir: "asc" | "desc"): SortMode {
  if (raw === "newest" || raw === "oldest" || raw === "amount_desc" || raw === "amount_asc") return raw;
  return fallbackSortDir === "asc" ? "oldest" : "newest";
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isAccountant = role === "ACCOUNTANT";
  if (!session || (!isAdmin && !isAccountant)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const month = searchParams.get("month") || "";
  const statusRaw = searchParams.get("status") || "";
  const q = searchParams.get("q") || "";
  const supplierId = searchParams.get("supplierId") || "";
  const paymentId = searchParams.get("paymentId") || "";
  const strictDate = searchParams.get("strictDate") === "1";
  const sortDir = (searchParams.get("sort") as "asc" | "desc") || "desc";
  const sortMode = normalizeSortMode(searchParams.get("sortMode"), sortDir);
  const exposureView = (searchParams.get("exposureView") as ExposureView) || "full";
  const agingFilter = (searchParams.get("agingFilter") as AgingFilter) || "all";
  const outstandingOnly = searchParams.get("outstandingOnly") === "1";
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1);
  const pageSize = Math.max(1, Math.min(200, parseInt(searchParams.get("pageSize") || "25", 10) || 25));

  const range = parseMonth(month || undefined);
  let dateFilter: { gte?: Date; lt?: Date } | undefined;
  if (range) {
    dateFilter = { gte: range.from, lt: range.to };
  }

  const status =
    statusRaw && Object.values(PurchaseStatus).includes(statusRaw as PurchaseStatus)
      ? (statusRaw as PurchaseStatus)
      : "";

  const where: Prisma.PurchaseWhereInput = {
    deletedAt: null,
    ...(strictDate && dateFilter ? { createdAt: dateFilter } : {}),
    ...(status ? { status } : {}),
    ...(q
      ? {
          OR: [
            { supplier: { contains: q, mode: "insensitive" } },
            { supplierRef: { is: { name: { contains: q, mode: "insensitive" } } } },
            { product: { name: { contains: q, mode: "insensitive" } } },
            { product: { sku: { contains: q, mode: "insensitive" } } },
          ],
        }
      : {}),
    ...(supplierId
      ? {
          OR: [
            { supplierId },
            { supplierRef: { is: { id: supplierId } } },
          ],
        }
      : {}),
  };

  type PurchaseWithRefs = Prisma.PurchaseGetPayload<{
    include: {
      product: { select: { id: true; name: true; sku: true } };
      supplierRef: { select: { id: true; name: true } };
    };
  }>;

  const purchases: PurchaseWithRefs[] = await prisma.purchase.findMany({
    where,
    include: {
      product: { select: { id: true, name: true, sku: true } },
      supplierRef: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: sortDir },
  });
  const purchaseIds = purchases.map((p) => p.id);
  const paymentSums = purchaseIds.length
    ? await prisma.supplierPayment.groupBy({
        by: ["purchaseId"],
        where: {
          deletedAt: null,
          status: "NORMAL",
          purchaseId: { in: purchaseIds },
          OR: [{ method: { notIn: ["credit_memo", "refund"] } }, { method: null }],
          ...(strictDate && dateFilter ? { createdAt: dateFilter } : {}),
        },
        _sum: { amount: true },
      })
    : [];
  const creditSums = purchaseIds.length
    ? await prisma.supplierPayment.groupBy({
        by: ["purchaseId"],
        where: {
          deletedAt: null,
          status: "NORMAL",
          method: "credit_memo",
          purchaseId: { in: purchaseIds },
          ...(strictDate && dateFilter ? { createdAt: dateFilter } : {}),
        },
        _sum: { amount: true },
      })
    : [];
  const refundSums = purchaseIds.length
    ? await prisma.supplierPayment.groupBy({
        by: ["purchaseId"],
        where: {
          deletedAt: null,
          status: "NORMAL",
          method: "refund",
          purchaseId: { in: purchaseIds },
          ...(strictDate && dateFilter ? { createdAt: dateFilter } : {}),
        },
        _sum: { amount: true },
      })
    : [];
  const pendingSums = purchaseIds.length
    ? await prisma.supplierPayment.groupBy({
        by: ["purchaseId"],
        where: {
          deletedAt: null,
          status: "PENDING_APPROVAL",
          approvedAt: null,
          purchaseId: { in: purchaseIds },
        },
        _sum: { amount: true },
      })
    : [];
  const paidByPurchase = new Map(
    paymentSums
      .filter((row) => row.purchaseId)
      .map((row) => [row.purchaseId as string, Number(row._sum.amount || 0)]),
  );
  const creditByPurchase = new Map(
    creditSums
      .filter((row) => row.purchaseId)
      .map((row) => [row.purchaseId as string, Number(row._sum.amount || 0)]),
  );
  const refundByPurchase = new Map(
    refundSums
      .filter((row) => row.purchaseId)
      .map((row) => [row.purchaseId as string, Number(row._sum.amount || 0)]),
  );
  const pendingByPurchase = new Map(
    pendingSums
      .filter((row) => row.purchaseId)
      .map((row) => [row.purchaseId as string, Number(row._sum.amount || 0)]),
  );

  const pendingPayments = await prisma.supplierPayment.findMany({
    where: {
      deletedAt: null,
      status: "PENDING_APPROVAL",
      approvedAt: null,
      ...(paymentId ? { id: paymentId } : {}),
      ...(dateFilter ? { createdAt: dateFilter } : {}),
      ...(supplierId
        ? { supplierId }
        : q
        ? { supplier: { is: { name: { contains: q, mode: "insensitive" } } } }
        : {}),
    },
    include: {
      supplier: { select: { id: true, name: true } },
      purchase: { select: { id: true, product: { select: { name: true, sku: true } } } },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const pendingPurchaseApprovals = await prisma.purchase.findMany({
    where: {
      deletedAt: null,
      status: "PENDING_APPROVAL",
      product: { is: { deletedAt: null } },
      ...(dateFilter ? { createdAt: dateFilter } : {}),
      ...(supplierId
        ? {
            OR: [
              { supplierId },
              { supplierRef: { is: { id: supplierId } } },
            ],
          }
        : q
        ? {
            OR: [
              { supplier: { contains: q, mode: "insensitive" } },
              { supplierRef: { is: { name: { contains: q, mode: "insensitive" } } } },
              { product: { name: { contains: q, mode: "insensitive" } } },
              { product: { sku: { contains: q, mode: "insensitive" } } },
            ],
          }
        : {}),
    },
    include: {
      supplierRef: { select: { id: true, name: true } },
      product: { select: { id: true, name: true, sku: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const pendingPurchaseIds = new Set(
    pendingPayments.map((p) => p.purchaseId).filter((id): id is string => Boolean(id)),
  );

  const tempRows = purchases.flatMap((p) => {
    if (pendingPurchaseIds.has(p.id)) {
      return [];
    }
    const payable = resolvePayableQuantity({
      status: p.status,
      quantity: p.quantity,
      orderedQuantity: p.orderedQuantity,
      receivedQuantity: p.receivedQuantity,
    });
    if (payable.exclude || payable.qty <= 0) {
      return [];
    }
    const supplierName = p.supplierRef?.name || p.supplier || "Unknown";
    const supplierKey = p.supplierRef?.id || `name:${supplierName}`;
    const total = Number(p.unitCost || 0) * payable.qty;
    const rawPaid = paidByPurchase.get(p.id) || 0;
    const appliedPaid = Math.min(rawPaid, total);
    const overpaid = Math.max(0, rawPaid - total);
    const baseCredits = creditByPurchase.get(p.id) || 0;
    const creditGenerated = baseCredits + overpaid;
    const refundAmount = refundByPurchase.get(p.id) || 0;
    const pendingAmount = pendingByPurchase.get(p.id) || 0;
    const baseOutstanding = Math.max(0, total - appliedPaid + refundAmount);
    const paymentStatus =
      baseOutstanding <= 0.01
        ? "PAID"
        : appliedPaid > 0
        ? "PARTIALLY_PAID"
        : "UNPAID";
    return [{
      id: p.id,
      createdAt: p.createdAt,
      expectedAt: p.expectedAt ? p.expectedAt.toISOString() : null,
      status: p.status,
      supplier: supplierName,
      supplierId: p.supplierRef?.id || null,
      supplierKey,
      product: p.product,
      quantity: payable.qty,
      unitCost: Number(p.unitCost || 0),
      total,
      paidAmount: appliedPaid,
      creditGenerated,
      refundAmount,
      pendingAmount,
      paymentStatus,
    }];
  });

  const creditPoolBySupplier = new Map<string, number>();
  const rowsBySupplier = new Map<string, typeof tempRows>();
  for (const row of tempRows) {
    const key = row.supplierKey;
    creditPoolBySupplier.set(key, (creditPoolBySupplier.get(key) || 0) + Number(row.creditGenerated || 0));
    const list = rowsBySupplier.get(key) || [];
    list.push(row);
    rowsBySupplier.set(key, list);
  }

  const rows = [];
  const creditBalanceBySupplier = new Map<string, number>();
  for (const [key, list] of rowsBySupplier.entries()) {
    const sorted = [...list].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    let remainingCredit = creditPoolBySupplier.get(key) || 0;
    for (const row of sorted) {
      const baseOutstanding = Math.max(0, Number(row.total || 0) - Number(row.paidAmount || 0) + Number(row.refundAmount || 0));
      const applyCredit = Math.min(baseOutstanding, remainingCredit);
      const outstanding = Math.max(0, baseOutstanding - applyCredit);
      remainingCredit = Math.max(0, remainingCredit - applyCredit);
      rows.push({
        ...row,
        creditAmount: applyCredit,
        outstanding,
        createdAt: row.createdAt.toISOString(),
      });
    }
    creditBalanceBySupplier.set(key, remainingCredit);
  }
  const sortedRows = sortRows(rows, sortMode);
  const scopedRows = sortedRows.filter((row) => {
    if (
      exposureView === "received" &&
      row.status !== "RECEIVED" &&
      row.status !== "PARTIALLY_RECEIVED"
    ) {
      return false;
    }
    if (outstandingOnly && Number(row.outstanding || 0) <= 0.01) {
      return false;
    }
    if (agingFilter === "all") return true;
    if (agingFilter === "overdue") {
      const diff = expectedDiffDays(row.expectedAt);
      return Number(row.outstanding || 0) > 0.01 && diff !== null && diff < 0;
    }
    if (agingFilter === "due_today") {
      if (!row.expectedAt || Number(row.outstanding || 0) <= 0.01) return false;
      const expected = new Date(row.expectedAt);
      const today = new Date();
      return (
        expected.getFullYear() === today.getFullYear() &&
        expected.getMonth() === today.getMonth() &&
        expected.getDate() === today.getDate()
      );
    }
    if (agingFilter === "due_7") {
      const diff = expectedDiffDays(row.expectedAt);
      return Number(row.outstanding || 0) > 0.01 && diff !== null && diff >= 0 && diff <= 7;
    }
    if (Number(row.outstanding || 0) <= 0.01) return false;
    return getAgingBucket(daysBetween(row.createdAt)) === agingFilter;
  });

  const total = scopedRows.length;
  const totalAmount = scopedRows.reduce((sum, row) => sum + Number(row.total || 0), 0);
  const totalPaid = scopedRows.reduce((sum, row) => sum + Number(row.paidAmount || 0), 0);
  const totalCreditsFromRows = scopedRows.reduce(
    (sum, row) => sum + Number(row.creditGenerated || 0),
    0,
  );
  const totalRefundsFromRows = scopedRows.reduce(
    (sum, row) => sum + Number(row.refundAmount || 0),
    0,
  );
  const paymentFilterBase = {
    deletedAt: null,
    status: "NORMAL",
    ...(strictDate && dateFilter ? { createdAt: dateFilter } : {}),
    ...(supplierId
      ? { supplierId }
      : q
      ? { supplier: { name: { contains: q, mode: "insensitive" } } }
      : {}),
  } satisfies NonNullable<Parameters<typeof prisma.supplierPayment.aggregate>[0]>["where"];
  let extraCredits = 0;
  let extraRefunds = 0;
  if (!strictDate) {
    const creditExtras = await prisma.supplierPayment.aggregate({
      where: { ...paymentFilterBase, method: "credit_memo", purchaseId: null },
      _sum: { amount: true },
    });
    const refundExtras = await prisma.supplierPayment.aggregate({
      where: { ...paymentFilterBase, method: "refund", purchaseId: null },
      _sum: { amount: true },
    });
    extraCredits = Number(creditExtras._sum.amount || 0);
    extraRefunds = Number(refundExtras._sum.amount || 0);
  }
  const totalCredits = totalCreditsFromRows + extraCredits;
  const totalRefunds = totalRefundsFromRows + extraRefunds;
  const scopeSupplierKeys = new Set(scopedRows.map((row) => String(row.supplierKey || "")));
  const totalCreditBalance =
    Array.from(creditBalanceBySupplier.entries()).reduce(
      (sum, [key, value]) => sum + (scopeSupplierKeys.has(key) ? Number(value || 0) : 0),
      0,
    ) +
    Math.max(0, extraCredits - extraRefunds);
  const totalOutstanding = scopedRows.reduce((sum, row) => sum + Number(row.outstanding || 0), 0);
  const totalPendingPaymentApprovals = scopedRows.reduce((sum, row) => sum + Number(row.pendingAmount || 0), 0);
  const totalPendingPurchaseApprovals = pendingPurchaseApprovals.reduce(
    (sum, purchase) =>
      sum + Number(purchase.unitCost || 0) * Number(purchase.orderedQuantity ?? purchase.quantity ?? 0),
    0,
  );
  const startIdx = (page - 1) * pageSize;
  const paged = scopedRows.slice(startIdx, startIdx + pageSize);

  return NextResponse.json({
    rows: paged,
    scopeRows: scopedRows,
    total,
    totalAmount,
    totalPaid,
    totalPending: totalPendingPaymentApprovals,
    totalPendingPaymentApprovals,
    totalPendingPurchaseApprovals,
    totalCredits,
    totalRefunds,
    totalCreditBalance,
    totalOutstanding,
    page,
    pageSize,
    pendingPayments: pendingPayments.map((p) => ({
      id: p.id,
      amount: Number(p.amount || 0),
      method: p.method || "",
      reference: p.reference || "",
      proofUrl: p.proofUrl || "",
      note: p.note || "",
      createdAt: p.createdAt.toISOString(),
      supplier: p.supplier ? { id: p.supplier.id, name: p.supplier.name } : null,
      purchase: p.purchase
        ? {
            id: p.purchase.id,
            product: p.purchase.product,
          }
        : null,
    })),
    pendingPurchaseApprovals: pendingPurchaseApprovals.map((p) => ({
      id: p.id,
      createdAt: p.createdAt.toISOString(),
      supplierId: p.supplierRef?.id || p.supplierId || null,
      supplier: p.supplierRef?.name || p.supplier || "Unknown",
      product: p.product
        ? { id: p.product.id, name: p.product.name, sku: p.product.sku }
        : null,
      quantity: Number(p.orderedQuantity ?? p.quantity ?? 0),
      unitCost: Number(p.unitCost || 0),
      total: Number(p.unitCost || 0) * Number(p.orderedQuantity ?? p.quantity ?? 0),
      expectedAt: p.expectedAt ? p.expectedAt.toISOString() : null,
      status: p.status,
    })),
  });
}

export async function POST(req: Request) {
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

  try {
    const body = await req.json();
    const sourcePage = String(body.sourcePage || DEFAULT_SOURCE_PAGE).trim() || DEFAULT_SOURCE_PAGE;
    const kind = String(body.kind || "").trim().toLowerCase();
    const approvalThreshold = Number(process.env.SUPPLIER_PAYMENT_APPROVAL_THRESHOLD || 0);
    const canBypassApproval = canManageSupplierPayments;
    const eligibleStatuses = ["APPROVED", "ORDERED", "PARTIALLY_RECEIVED", "RECEIVED"] as const;
    const purchaseId = String(body.purchaseId || "").trim();
    const supplierId = String(body.supplierId || "").trim();
    const supplierName = String(body.supplierName || "").trim();
    const amount = Number(body.amount);
    const method = String(body.method || "cash").toLowerCase();
    const reference = String(body.reference || "").trim() || null;
    const note = String(body.note || "").trim() || null;
    const proofUrl = String(body.proofUrl || "").trim() || null;
    const paidAt = body.paidAt ? new Date(body.paidAt) : new Date();
    const requestedPurchaseIds: string[] = Array.isArray(body.purchaseIds)
      ? Array.from(
          new Set(
            body.purchaseIds
              .map((value: unknown) => String(value || "").trim())
              .filter((value: string) => Boolean(value)),
          ),
        )
      : [];

    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ error: "Invalid payment details" }, { status: 400 });
    }

    if (kind === "refund") {
      if (!supplierId && !supplierName) {
        return NextResponse.json({ error: "Supplier is required for refunds." }, { status: 400 });
      }
      let resolvedSupplierId = supplierId || null;
      if (!resolvedSupplierId && supplierName) {
        const supplier = await prisma.supplier.findFirst({
          where: { name: { equals: supplierName, mode: "insensitive" } },
          select: { id: true, name: true },
        });
        if (supplier) {
          resolvedSupplierId = supplier.id;
        }
      }
      const payment = await prisma.supplierPayment.create({
        data: {
          supplierId: resolvedSupplierId,
          purchaseId: purchaseId || null,
          amount,
          method: "refund",
          reference: reference || "SUPPLIER_REFUND",
          note,
          proofUrl,
          status: "NORMAL",
          paidAt,
        },
      });
      try {
        await recordAuditLog({
          actorId: user?.id,
          action: "SUPPLIER_REFUND_CREATE",
          entityType: "SUPPLIER_PAYMENT",
          entityId: payment.id,
          request: req,
          meta: {
            sourcePage,
            section: "refunds",
            operation: "create_supplier_refund",
            supplierId: resolvedSupplierId,
            purchaseId: purchaseId || null,
            amount: Number(payment.amount || 0),
            method: payment.method || null,
            reference: payment.reference || null,
            note: payment.note || null,
            status: payment.status,
            paidAt: payment.paidAt ? payment.paidAt.toISOString() : null,
            resultSummary: `Recorded supplier refund of ${Number(payment.amount || 0).toFixed(2)}.`,
          },
        });
      } catch {
        // best-effort
      }
      try {
        await postSupplierRefundEntry({ supplierPaymentId: payment.id });
      } catch (e) {
        console.warn("Accounting supplier refund posting skipped:", e);
      }
      return NextResponse.json({ ok: true, id: payment.id });
    }

    if (purchaseId) {
      const purchase = await prisma.purchase.findUnique({
        where: { id: purchaseId },
        select: {
          id: true,
          supplierId: true,
          unitCost: true,
          quantity: true,
          orderedQuantity: true,
          receivedQuantity: true,
          status: true,
        },
      });
      if (!purchase) {
        return NextResponse.json({ error: "Purchase not found" }, { status: 404 });
      }
      const canPayCancelled =
        purchase.status === "CANCELLED" && Number(purchase.receivedQuantity || 0) > 0;
      if (!eligibleStatuses.includes(purchase.status as (typeof eligibleStatuses)[number]) && !canPayCancelled) {
        return NextResponse.json(
          { error: "Cannot record payment until the purchase is approved." },
          { status: 400 },
        );
      }
      if (purchase.status === "CANCELLED" && Number(purchase.receivedQuantity || 0) <= 0) {
        return NextResponse.json({ error: "Cancelled purchase has no received items to pay for." }, { status: 400 });
      }

      const requiresApproval =
        approvalThreshold > 0 && amount >= approvalThreshold && !canBypassApproval;
      const payment = await prisma.supplierPayment.create({
        data: {
          purchaseId: purchase.id,
          supplierId: purchase.supplierId,
          amount,
          method,
          reference,
          note,
          proofUrl,
          status: requiresApproval ? "PENDING_APPROVAL" : "NORMAL",
          paidAt: requiresApproval ? null : paidAt,
        },
      });
      try {
        await recordAuditLog({
          actorId: user?.id,
          action: "SUPPLIER_PAYMENT_CREATE",
          entityType: "SUPPLIER_PAYMENT",
          entityId: payment.id,
          request: req,
          meta: {
            sourcePage,
            section: "ledger",
            operation: "create_supplier_payment",
            supplierId: purchase.supplierId || null,
            purchaseId: purchase.id,
            amount: Number(payment.amount || 0),
            method: payment.method || null,
            reference: payment.reference || null,
            note: payment.note || null,
            status: payment.status,
            approvalThreshold: approvalThreshold > 0 ? approvalThreshold : null,
            requiresApproval: payment.status === "PENDING_APPROVAL",
            paidAt: payment.paidAt ? payment.paidAt.toISOString() : null,
            resultSummary:
              payment.status === "PENDING_APPROVAL"
                ? `Recorded supplier payment of ${Number(payment.amount || 0).toFixed(2)} pending approval.`
                : `Recorded supplier payment of ${Number(payment.amount || 0).toFixed(2)}.`,
          },
        });
      } catch {
        // best-effort
      }
      try {
        if (payment.status === "NORMAL") {
          await postSupplierPaymentEntry({ supplierPaymentId: payment.id });
        }
      } catch (e) {
        console.warn("Accounting supplier payment posting skipped:", e);
      }

      return NextResponse.json({ ok: true, id: payment.id });
    }

    if (!supplierId && !supplierName) {
      return NextResponse.json({ error: "Supplier is required for bulk payments." }, { status: 400 });
    }

    let resolvedSupplierId = supplierId || null;
    let resolvedSupplierName = supplierName || null;
    if (!resolvedSupplierId && supplierName) {
      const supplier = await prisma.supplier.findFirst({
        where: { name: { equals: supplierName, mode: "insensitive" } },
        select: { id: true, name: true },
      });
      if (supplier) {
        resolvedSupplierId = supplier.id;
        resolvedSupplierName = supplier.name;
      }
    }

    const purchaseWhere: Prisma.PurchaseWhereInput = {
      deletedAt: null,
      ...(requestedPurchaseIds.length ? { id: { in: requestedPurchaseIds } } : {}),
      status: { in: [...eligibleStatuses, "CANCELLED"] as PurchaseStatus[] },
      ...(resolvedSupplierId
        ? {
            OR: [
              { supplierId: resolvedSupplierId },
              ...(resolvedSupplierName
                ? [{ supplier: { equals: resolvedSupplierName, mode: Prisma.QueryMode.insensitive } }]
                : []),
            ],
          }
        : resolvedSupplierName
        ? { supplier: { equals: resolvedSupplierName, mode: Prisma.QueryMode.insensitive } }
        : {}),
    };

    const purchases = await prisma.purchase.findMany({
      where: purchaseWhere,
      select: {
        id: true,
        supplierId: true,
        supplier: true,
        unitCost: true,
        quantity: true,
        orderedQuantity: true,
        receivedQuantity: true,
        status: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    });
    if (purchases.length === 0) {
      return NextResponse.json({ error: "No matching purchases found." }, { status: 404 });
    }

    const purchaseIds = purchases.map((p) => p.id);
    const paymentSums = await prisma.supplierPayment.groupBy({
      by: ["purchaseId"],
      where: { deletedAt: null, status: "NORMAL", purchaseId: { in: purchaseIds } },
      _sum: { amount: true },
    });
    const paidByPurchase = new Map(
      paymentSums
        .filter((row) => row.purchaseId)
        .map((row) => [row.purchaseId as string, Number(row._sum.amount || 0)]),
    );

    let remaining = amount;
    const allocations: Array<{ purchaseId: string; amount: number; supplierId: string | null }> = [];
    for (const purchase of purchases) {
      if (remaining <= 0) break;
      const payable = resolvePayableQuantity({
        status: purchase.status,
        quantity: purchase.quantity,
        orderedQuantity: purchase.orderedQuantity,
        receivedQuantity: purchase.receivedQuantity,
      });
      if (payable.exclude || payable.qty <= 0) {
        continue;
      }
      const total = Number(purchase.unitCost || 0) * payable.qty;
      const paid = paidByPurchase.get(purchase.id) || 0;
      const outstanding = Math.max(0, total - paid);
      if (outstanding <= 0.01) continue;
      const applyAmount = Math.min(outstanding, remaining);
      if (applyAmount <= 0) continue;
      allocations.push({
        purchaseId: purchase.id,
        amount: applyAmount,
        supplierId: purchase.supplierId ?? resolvedSupplierId,
      });
      remaining -= applyAmount;
    }

    if (allocations.length === 0) {
      return NextResponse.json({ error: "No outstanding balances for this supplier." }, { status: 400 });
    }

    const created = await prisma.$transaction(async (tx) => {
      const records = [];
      for (const alloc of allocations) {
        const requiresApproval =
          approvalThreshold > 0 && alloc.amount >= approvalThreshold && !canBypassApproval;
        const payment = await tx.supplierPayment.create({
          data: {
            purchaseId: alloc.purchaseId,
            supplierId: alloc.supplierId,
            amount: alloc.amount,
            method,
            reference,
            note: note || "Bulk supplier payment",
            proofUrl,
            status: requiresApproval ? "PENDING_APPROVAL" : "NORMAL",
            paidAt: requiresApproval ? null : paidAt,
          },
        });
        records.push(payment);
      }
      return records;
    });

    for (const payment of created) {
      try {
        await recordAuditLog({
          actorId: user?.id,
          action: "SUPPLIER_PAYMENT_CREATE",
          entityType: "SUPPLIER_PAYMENT",
          entityId: payment.id,
          request: req,
          meta: {
            sourcePage,
            section: "bulk-payments",
            operation: "create_bulk_supplier_payment",
            supplierId: payment.supplierId || resolvedSupplierId || null,
            purchaseId: payment.purchaseId || null,
            amount: Number(payment.amount || 0),
            method: payment.method || null,
            reference: payment.reference || null,
            note: payment.note || null,
            status: payment.status,
            approvalThreshold: approvalThreshold > 0 ? approvalThreshold : null,
            requiresApproval: payment.status === "PENDING_APPROVAL",
            paidAt: payment.paidAt ? payment.paidAt.toISOString() : null,
            source: "BULK_SUPPLIER_PAYMENT",
            scopedPurchaseCount: requestedPurchaseIds.length || allocations.length,
            scopedPurchaseIdsSample: requestedPurchaseIds.slice(0, 25),
            resultSummary:
              payment.status === "PENDING_APPROVAL"
                ? `Recorded bulk supplier payment allocation of ${Number(payment.amount || 0).toFixed(2)} pending approval.`
                : `Recorded bulk supplier payment allocation of ${Number(payment.amount || 0).toFixed(2)}.`,
          },
        });
      } catch {
        // best-effort
      }
      try {
        if (payment.status === "NORMAL") {
          await postSupplierPaymentEntry({ supplierPaymentId: payment.id });
        }
      } catch (e) {
        console.warn("Accounting supplier payment posting skipped:", e);
      }
    }

    return NextResponse.json({
      ok: true,
      allocations: created.map((p) => ({ id: p.id, purchaseId: p.purchaseId, amount: Number(p.amount || 0) })),
      remaining,
    });
  } catch (err) {
    console.error("Supplier payment create error:", err);
    return NextResponse.json({ error: "Failed to record payment" }, { status: 500 });
  }
}
