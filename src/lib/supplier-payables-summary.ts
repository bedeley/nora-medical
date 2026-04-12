import { PurchaseStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { recordAuditLog } from "@/lib/audit-log";

type SnapshotRow = {
  id: string;
  createdAt: Date;
  expectedAt: Date | null;
  status: PurchaseStatus;
  supplierKey: string;
  total: number;
  paidAmount: number;
  refundAmount: number;
  creditGenerated: number;
  pendingAmount: number;
  outstanding?: number;
};

type AgingBuckets = Record<"0_30" | "31_60" | "61_90" | "90_plus", number>;

export type SupplierPayablesSummarySnapshot = {
  totalPayablesRows: number;
  outstandingOperational: number;
  outstandingReceivedAp: number;
  orderedNotReceivedExposure: number;
  pendingPaymentApprovalsAmount: number;
  pendingPurchaseApprovalsAmount: number;
  overdueCount: number;
  dueTodayCount: number;
  due7Count: number;
  agingBuckets: AgingBuckets;
};

export type SupplierPayablesSummarySendResult = {
  ok: boolean;
  simulated: boolean;
  recipientCount: number;
  snapshot: SupplierPayablesSummarySnapshot;
  runAt: string;
};

const OPEN_PURCHASE_STATUSES: PurchaseStatus[] = [
  PurchaseStatus.APPROVED,
  PurchaseStatus.ORDERED,
  PurchaseStatus.PARTIALLY_RECEIVED,
  PurchaseStatus.RECEIVED,
];

function resolvePayableQuantity(purchase: {
  status: PurchaseStatus;
  quantity?: number | null;
  orderedQuantity?: number | null;
  receivedQuantity?: number | null;
}) {
  const receivedQty = Number(purchase.receivedQuantity ?? 0);
  const orderedQty = Number(purchase.orderedQuantity ?? purchase.quantity ?? 0);
  const fallbackQty = orderedQty > 0 ? orderedQty : Number(purchase.quantity ?? 0);
  const includeWithoutReceipt =
    purchase.status === PurchaseStatus.APPROVED ||
    purchase.status === PurchaseStatus.ORDERED ||
    purchase.status === PurchaseStatus.RECEIVED ||
    purchase.status === PurchaseStatus.PARTIALLY_RECEIVED;
  const baseQty = receivedQty > 0 ? receivedQty : includeWithoutReceipt ? fallbackQty : 0;
  const excludeUnreceived = receivedQty <= 0 && !includeWithoutReceipt;
  return { qty: Math.max(0, baseQty), exclude: excludeUnreceived };
}

function parseRecipients(value: string | undefined) {
  if (!value) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value.split(/[,\n;]+/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function formatMoney(value: number) {
  return new Intl.NumberFormat("en-GH", {
    style: "currency",
    currency: "GHS",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function expectedDiffDays(expectedAt: Date | null, today = new Date()) {
  if (!expectedAt) return null;
  const expectedDay = new Date(expectedAt.getFullYear(), expectedAt.getMonth(), expectedAt.getDate());
  const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.floor((expectedDay.getTime() - todayDay.getTime()) / (1000 * 60 * 60 * 24));
}

function daysBetween(from: Date, toDate = new Date()) {
  const ms = toDate.getTime() - from.getTime();
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

function getAgingBucket(days: number) {
  if (days <= 30) return "0_30";
  if (days <= 60) return "31_60";
  if (days <= 90) return "61_90";
  return "90_plus";
}

export async function buildSupplierPayablesSummarySnapshot(): Promise<SupplierPayablesSummarySnapshot> {
  const purchases = await prisma.purchase.findMany({
    where: {
      deletedAt: null,
      status: { in: OPEN_PURCHASE_STATUSES },
      product: { is: { deletedAt: null } },
    },
    include: {
      supplierRef: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
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

  const tempRows: SnapshotRow[] = purchases.flatMap((p) => {
    const payable = resolvePayableQuantity({
      status: p.status,
      quantity: p.quantity,
      orderedQuantity: p.orderedQuantity,
      receivedQuantity: p.receivedQuantity,
    });
    if (payable.exclude || payable.qty <= 0) return [];
    const total = Number(p.unitCost || 0) * payable.qty;
    const rawPaid = paidByPurchase.get(p.id) || 0;
    const appliedPaid = Math.min(rawPaid, total);
    const overpaid = Math.max(0, rawPaid - total);
    const baseCredits = creditByPurchase.get(p.id) || 0;
    const creditGenerated = baseCredits + overpaid;
    const refundAmount = refundByPurchase.get(p.id) || 0;
    const pendingAmount = pendingByPurchase.get(p.id) || 0;
    return [
      {
        id: p.id,
        createdAt: p.createdAt,
        expectedAt: p.expectedAt,
        status: p.status,
        supplierKey: p.supplierRef?.id || `name:${p.supplierRef?.name || p.supplier || "Unknown"}`,
        total,
        paidAmount: appliedPaid,
        refundAmount,
        creditGenerated,
        pendingAmount,
      },
    ];
  });

  const rowsBySupplier = new Map<string, SnapshotRow[]>();
  const creditPoolBySupplier = new Map<string, number>();
  for (const row of tempRows) {
    rowsBySupplier.set(row.supplierKey, [...(rowsBySupplier.get(row.supplierKey) || []), row]);
    creditPoolBySupplier.set(
      row.supplierKey,
      (creditPoolBySupplier.get(row.supplierKey) || 0) + row.creditGenerated,
    );
  }

  const rows: SnapshotRow[] = [];
  for (const [supplierKey, supplierRows] of rowsBySupplier.entries()) {
    const sorted = [...supplierRows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    let remainingCredit = creditPoolBySupplier.get(supplierKey) || 0;
    for (const row of sorted) {
      const baseOutstanding = Math.max(0, row.total - row.paidAmount + row.refundAmount);
      const appliedCredit = Math.min(baseOutstanding, remainingCredit);
      remainingCredit = Math.max(0, remainingCredit - appliedCredit);
      rows.push({
        ...row,
        outstanding: Math.max(0, baseOutstanding - appliedCredit),
      });
    }
  }

  const pendingApprovalsRows = await prisma.purchase.findMany({
    where: {
      deletedAt: null,
      status: PurchaseStatus.PENDING_APPROVAL,
      product: { is: { deletedAt: null } },
    },
    select: {
      unitCost: true,
      quantity: true,
      orderedQuantity: true,
    },
  });
  const pendingPurchaseApprovalsAmount = pendingApprovalsRows.reduce((sum, p) => {
    const qty = Number(p.orderedQuantity ?? p.quantity ?? 0);
    return sum + Number(p.unitCost || 0) * qty;
  }, 0);

  const pendingPaymentApprovalsAmount = rows.reduce((sum, row) => sum + Number(row.pendingAmount || 0), 0);
  const outstandingOperational = rows.reduce((sum, row) => sum + Number(row.outstanding || 0), 0);
  const outstandingReceivedAp = rows
    .filter((row) => row.status === PurchaseStatus.RECEIVED || row.status === PurchaseStatus.PARTIALLY_RECEIVED)
    .reduce((sum, row) => sum + Number(row.outstanding || 0), 0);
  const orderedNotReceivedExposure = rows
    .filter((row) => row.status === PurchaseStatus.ORDERED || row.status === PurchaseStatus.APPROVED)
    .reduce((sum, row) => sum + Number(row.outstanding || 0), 0);

  const agingBuckets: AgingBuckets = { "0_30": 0, "31_60": 0, "61_90": 0, "90_plus": 0 };
  let overdueCount = 0;
  let dueTodayCount = 0;
  let due7Count = 0;

  for (const row of rows) {
    if (!row.outstanding || row.outstanding <= 0.01) continue;
    const ageDays = daysBetween(row.createdAt);
    agingBuckets[getAgingBucket(ageDays)] += row.outstanding;
    const diff = expectedDiffDays(row.expectedAt);
    if (diff == null) continue;
    if (diff < 0) overdueCount += 1;
    else if (diff === 0) dueTodayCount += 1;
    else if (diff <= 7) due7Count += 1;
  }

  return {
    totalPayablesRows: rows.length,
    outstandingOperational,
    outstandingReceivedAp,
    orderedNotReceivedExposure,
    pendingPaymentApprovalsAmount,
    pendingPurchaseApprovalsAmount,
    overdueCount,
    dueTodayCount,
    due7Count,
    agingBuckets,
  };
}

function buildSummaryText(snapshot: SupplierPayablesSummarySnapshot) {
  return [
    "Hello Team,",
    "",
    "This is your automated supplier payables summary.",
    "",
    `Generated: ${new Date().toLocaleString()}`,
    "Scope: Full exposure",
    "",
    `Outstanding (operational): ${formatMoney(snapshot.outstandingOperational)}`,
    `Outstanding (ledger AP received): ${formatMoney(snapshot.outstandingReceivedAp)}`,
    `Ordered not received exposure: ${formatMoney(snapshot.orderedNotReceivedExposure)}`,
    `Pending payment approvals: ${formatMoney(snapshot.pendingPaymentApprovalsAmount)}`,
    `Pending purchase approvals: ${formatMoney(snapshot.pendingPurchaseApprovalsAmount)}`,
    "",
    "Next actions:",
    `- Overdue: ${snapshot.overdueCount}`,
    `- Due today: ${snapshot.dueTodayCount}`,
    `- Due in 7 days: ${snapshot.due7Count}`,
    "",
    "Aging buckets:",
    `- 0-30 days: ${formatMoney(snapshot.agingBuckets["0_30"])}`,
    `- 31-60 days: ${formatMoney(snapshot.agingBuckets["31_60"])}`,
    `- 61-90 days: ${formatMoney(snapshot.agingBuckets["61_90"])}`,
    `- 90+ days: ${formatMoney(snapshot.agingBuckets["90_plus"])}`,
    "",
    "Regards,",
    "Finance / Procurement",
  ].join("\n");
}

export async function executeSupplierPayablesSummarySend(params?: {
  actorId?: string | null;
  auditAction?: string;
  subjectPrefix?: string;
  sourcePage?: string;
}) {
  const toRecipients = parseRecipients(process.env.SUPPLIER_PAYABLES_SUMMARY_TO);
  const ccRecipients = parseRecipients(process.env.SUPPLIER_PAYABLES_SUMMARY_CC);
  if (!toRecipients.length) {
    throw new Error("SUPPLIER_PAYABLES_SUMMARY_TO is not configured.");
  }

  const subjectPrefix =
    params?.subjectPrefix?.trim() ||
    (process.env.SUPPLIER_PAYABLES_SUMMARY_SUBJECT_PREFIX || "Supplier payables summary").trim();
  const subject = `${subjectPrefix} - ${new Date().toLocaleDateString()}`;
  const snapshot = await buildSupplierPayablesSummarySnapshot();
  const text = buildSummaryText(snapshot);
  const html = text.replace(/\n/g, "<br/>");

  const targetRecipients = [...toRecipients, ...ccRecipients.filter((cc) => !toRecipients.includes(cc))];
  let simulated = false;
  for (const recipient of targetRecipients) {
    const sent = await sendEmail(recipient, subject, text, html);
    if (!sent.ok) {
      throw new Error(sent.error || `Failed to send email to ${recipient}`);
    }
    simulated = simulated || !!sent.simulated;
  }

  await recordAuditLog({
    actorId: params?.actorId || null,
    action: params?.auditAction || "SUPPLIER_PAYABLES_SUMMARY_CRON_SEND",
    entityType: "SUPPLIER_PAYMENT",
    entityId: "SUMMARY",
    meta: {
      to: toRecipients,
      cc: ccRecipients,
      subject,
      recipientCount: targetRecipients.length,
      simulated,
      sourcePage: params?.sourcePage || "admin/supplier-payments",
      section: "summary-schedule",
      operation: "run_supplier_payables_summary_send",
      snapshot,
      resultSummary: `Sent supplier payables summary to ${targetRecipients.length} recipient(s).`,
    },
  });

  const result: SupplierPayablesSummarySendResult = {
    ok: true,
    simulated,
    recipientCount: targetRecipients.length,
    snapshot,
    runAt: new Date().toISOString(),
  };
  return result;
}
