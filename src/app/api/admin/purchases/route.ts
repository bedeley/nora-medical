import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Prisma, PurchaseStatus } from "@prisma/client";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuditLog } from "@/lib/audit-log";
import { notifyBackInStock } from "@/lib/stock-alerts";
import { postPurchaseEntry, postSupplierPaymentEntry } from "@/lib/accounting-posting";
import { ensureInventoryLot, normalizeLotCode } from "@/lib/inventory-lots";
import { hasPermission } from "@/lib/permissions";
import { roundCurrency } from "@/lib/currency";

const APPROVAL_QTY_THRESHOLD = Number(process.env.PURCHASE_APPROVAL_QTY_THRESHOLD || 100);
const SUPPLIER_PAYMENT_APPROVAL_THRESHOLD = Number(
  process.env.SUPPLIER_PAYMENT_APPROVAL_THRESHOLD || 0,
);

type TxClient = Parameters<typeof prisma.$transaction>[0] extends (arg: infer A) => unknown ? A : never;

type PurchasesWhere = Prisma.PurchaseWhereInput;

type PurchaseRowDto = {
  id: string;
  productId: string;
  productName: string;
  productSku?: string | null;
  requiresLotTracking?: boolean;
  requiresExpiryDate?: boolean;
  quantity: number;
  orderedQuantity?: number;
  receivedQuantity?: number;
  status?: string;
  expectedAt?: Date | null;
  supplierId?: string | null;
  unitCost: number;
  total: number;
  supplier?: string | null;
  reason?: string | null;
  note?: string | null;
  createdAt: Date;
};

function startOfDay(date: Date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function startOfWeek(date: Date) {
  const base = startOfDay(date);
  const day = base.getDay();
  base.setDate(base.getDate() - day);
  return base;
}

function endOfWeek(date: Date) {
  const base = startOfWeek(date);
  base.setDate(base.getDate() + 6);
  return base;
}

function isAwaitingReceive(row: PurchaseRowDto) {
  const status = String(row.status || "").toUpperCase();
  const openStatus = ["APPROVED", "ORDERED", "PARTIALLY_RECEIVED"].includes(status);
  const ordered = Number(row.orderedQuantity ?? row.quantity);
  const received = Number(row.receivedQuantity ?? 0);
  return openStatus && received < ordered;
}

function getExpectedUrgency(row: PurchaseRowDto): { label: string; tone: "danger" | "warning" | "neutral" } | null {
  if (!row.expectedAt || !isAwaitingReceive(row)) return null;
  const expected = new Date(row.expectedAt);
  if (Number.isNaN(expected.getTime())) return null;
  const today = startOfDay(new Date());
  const target = startOfDay(expected);
  const dayMs = 24 * 60 * 60 * 1000;
  const diffDays = Math.round((target.getTime() - today.getTime()) / dayMs);
  if (diffDays < 0) return { label: `Overdue ${Math.abs(diffDays)}d`, tone: "danger" };
  if (diffDays === 0) return { label: "Due today", tone: "warning" };
  if (diffDays <= 3) return { label: `Due in ${diffDays}d`, tone: "warning" };
  return { label: `Expected ${expected.toLocaleDateString()}`, tone: "neutral" };
}

function applyQuickView(rows: PurchaseRowDto[], quickView: string) {
  switch (quickView) {
    case "pending_approval":
      return rows.filter((row) => String(row.status || "").toUpperCase() === "PENDING_APPROVAL");
    case "awaiting_receive":
      return rows.filter((row) => isAwaitingReceive(row));
    case "due_today":
      return rows.filter((row) => getExpectedUrgency(row)?.label === "Due today");
    case "overdue":
      return rows.filter((row) => getExpectedUrgency(row)?.tone === "danger");
    default:
      return rows;
  }
}

function applyExpectedWindow(rows: PurchaseRowDto[], expectedWindow: string) {
  const today = startOfDay(new Date());
  const weekStart = startOfWeek(today);
  const weekEnd = endOfWeek(today);
  const plus7 = new Date(today);
  plus7.setDate(plus7.getDate() + 7);
  switch (expectedWindow) {
    case "missing":
      return rows.filter((row) => isAwaitingReceive(row) && !row.expectedAt);
    case "this_week":
      return rows.filter((row) => {
        if (!isAwaitingReceive(row) || !row.expectedAt) return false;
        const d = startOfDay(new Date(row.expectedAt));
        return d >= weekStart && d <= weekEnd;
      });
    case "next_7":
      return rows.filter((row) => {
        if (!isAwaitingReceive(row) || !row.expectedAt) return false;
        const d = startOfDay(new Date(row.expectedAt));
        return d >= today && d <= plus7;
      });
    default:
      return rows;
  }
}

function applyExpectedSort(rows: PurchaseRowDto[], expectedSort: string) {
  if (expectedSort === "none") return rows;
  const next = [...rows];
  const toTime = (value?: Date | null) => {
    if (!value) return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return d.getTime();
  };
  next.sort((a, b) => {
    const at = toTime(a.expectedAt);
    const bt = toTime(b.expectedAt);
    if (expectedSort === "missing_first") {
      const am = at === null ? 0 : 1;
      const bm = bt === null ? 0 : 1;
      if (am !== bm) return am - bm;
      if (at === null || bt === null) return 0;
      return at - bt;
    }
    if (at === null && bt === null) return 0;
    if (at === null) return 1;
    if (bt === null) return -1;
    return expectedSort === "expected_oldest" ? at - bt : bt - at;
  });
  return next;
}

function normalizePositiveThreshold(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function resolveApprovalThresholdQty(globalThresholdRaw: unknown, productThresholdRaw: unknown): number {
  const globalThreshold = normalizePositiveThreshold(globalThresholdRaw);
  const productThreshold = normalizePositiveThreshold(productThresholdRaw);
  if (globalThreshold && productThreshold) return Math.min(globalThreshold, productThreshold);
  return globalThreshold ?? productThreshold ?? 0;
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const { searchParams } = new URL(req.url);
    const start = searchParams.get("start");
    const end = searchParams.get("end");
    const product = searchParams.get("product");
    const purchaseId = searchParams.get("purchaseId");
    const paymentId = searchParams.get("paymentId");
    const supplier = searchParams.get("supplier");
    const statusRaw = searchParams.get("status");
    const status =
      statusRaw && Object.values(PurchaseStatus).includes(statusRaw as PurchaseStatus)
        ? (statusRaw as PurchaseStatus)
        : undefined;
    const q = searchParams.get("q");
    const format = searchParams.get("format");
    const quickView = searchParams.get("quickView") || "all";
    const expectedWindow = searchParams.get("expectedWindow") || "all";
    const expectedSort = searchParams.get("expectedSort") || "none";
    const openOnly = searchParams.get("openOnly") === "1";
    const paginate = searchParams.has("page") || searchParams.has("pageSize");
    const pageRaw = Number(searchParams.get("page") || 1);
    const pageSizeRaw = Number(searchParams.get("pageSize") || 50);
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
    const pageSize = Number.isFinite(pageSizeRaw)
      ? Math.min(Math.max(Math.floor(pageSizeRaw), 1), 200)
      : 50;

    const where: PurchasesWhere = {
      deletedAt: null,
      product: { deletedAt: null },
    };
    if (purchaseId) {
      where.id = purchaseId;
    } else if (paymentId) {
      const payment = await prisma.supplierPayment.findUnique({
        where: { id: paymentId },
        select: { purchaseId: true },
      });
      if (payment?.purchaseId) {
        where.id = payment.purchaseId;
      } else {
        where.id = "__NO_MATCH__";
      }
    }
    if (product) where.productId = product;
    if (supplier) where.supplier = { contains: supplier, mode: "insensitive" };
    if (status) where.status = status;
    if (q) {
      where.OR = [
        { note: { contains: q, mode: "insensitive" } },
        { reason: { contains: q, mode: "insensitive" } },
      ];
    }
    if (start || end) {
      where.createdAt = {};
      if (start) where.createdAt.gte = new Date(start);
      if (end) {
        const dt = new Date(end);
        dt.setHours(23, 59, 59, 999);
        where.createdAt.lte = dt;
      }
    }

    const rows = await prisma.purchase.findMany({
      where,
      include: { product: { select: { name: true, sku: true, requiresLotTracking: true, requiresExpiryDate: true } } },
      orderBy: { createdAt: "desc" },
    });

    const items = rows.map((r: {
      id: string;
      productId: string;
      quantity: number;
      unitCost: unknown;
      supplier?: string | null;
      reason?: string | null;
      note?: string | null;
      createdAt: Date;
      status?: string | null;
      orderedQuantity?: number | null;
      receivedQuantity?: number | null;
      expectedAt?: Date | null;
      supplierId?: string | null;
      product?: { name?: string | null; sku?: string | null; requiresLotTracking?: boolean | null; requiresExpiryDate?: boolean | null } | null;
    }) => ({
      id: r.id,
      productId: r.productId,
      productName: r.product?.name ?? "",
      productSku: r.product?.sku ?? null,
      requiresLotTracking: Boolean(r.product?.requiresLotTracking),
      requiresExpiryDate: Boolean(r.product?.requiresExpiryDate),
      quantity: r.quantity,
      orderedQuantity: r.orderedQuantity ?? r.quantity,
      receivedQuantity: r.receivedQuantity ?? r.quantity,
      status: r.status || "RECEIVED",
      expectedAt: r.expectedAt ?? null,
      supplierId: r.supplierId ?? null,
      unitCost: Number(r.unitCost),
      total: Number(r.unitCost) * r.quantity,
      supplier: r.supplier || "",
      reason: r.reason || "",
      note: r.note || "",
      createdAt: r.createdAt,
    })) satisfies PurchaseRowDto[];

    const quickCounts = {
      pendingApproval: items.filter((row) => String(row.status || "").toUpperCase() === "PENDING_APPROVAL").length,
      awaitingReceive: items.filter((row) => isAwaitingReceive(row)).length,
      dueToday: items.filter((row) => getExpectedUrgency(row)?.label === "Due today").length,
      overdue: items.filter((row) => getExpectedUrgency(row)?.tone === "danger").length,
    };
    const quickRows = applyQuickView(items, quickView);
    const expectedCounts = {
      missing: quickRows.filter((row) => isAwaitingReceive(row) && !row.expectedAt).length,
      thisWeek: applyExpectedWindow(quickRows, "this_week").length,
      next7: applyExpectedWindow(quickRows, "next_7").length,
    };
    const expectedRows = applyExpectedWindow(quickRows, expectedWindow);
    const scopedRows = applyExpectedSort(
      openOnly ? expectedRows.filter((row) => isAwaitingReceive(row)) : expectedRows,
      expectedSort,
    );
    const scopedItems = format === "csv" || !paginate
      ? scopedRows
      : scopedRows.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);
    const viewTotals = {
      qty: scopedRows.reduce((sum, row) => sum + Number(row.quantity || 0), 0),
      value: scopedRows.reduce((sum, row) => sum + Number(row.total || 0), 0),
    };
    const statusCounts = Array.from(
      scopedRows.reduce((map, row) => {
        const statusName = String(row.status || "RECEIVED");
        map.set(statusName, (map.get(statusName) || 0) + 1);
        return map;
      }, new Map<string, number>()),
    ).map(([statusName, count]) => ({ status: statusName, count }));
    const topSuppliers = Array.from(
      scopedRows.reduce((map, row) => {
        const supplierName = String(row.supplier || "").trim();
        if (!supplierName) return map;
        map.set(supplierName, (map.get(supplierName) || 0) + 1);
        return map;
      }, new Map<string, number>()),
    )
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([supplierName]) => supplierName);
    const supplierOpenSummary = Array.from(
      scopedRows.reduce((map, row) => {
        if (!isAwaitingReceive(row)) return map;
        const supplierName = String(row.supplier || "Unknown supplier").trim() || "Unknown supplier";
        const ordered = Number(row.orderedQuantity ?? row.quantity);
        const received = Number(row.receivedQuantity ?? 0);
        const openQty = Math.max(0, ordered - received);
        if (openQty <= 0) return map;
        const entry = map.get(supplierName) || {
          supplier: supplierName,
          openQty: 0,
          openValue: 0,
          oldestExpected: null as Date | null,
          overdueCount: 0,
        };
        entry.openQty += openQty;
        entry.openValue += openQty * Number(row.unitCost || 0);
        if (row.expectedAt) {
          const expected = startOfDay(new Date(row.expectedAt));
          if (!Number.isNaN(expected.getTime())) {
            if (!entry.oldestExpected || expected < entry.oldestExpected) entry.oldestExpected = expected;
            if (expected < startOfDay(new Date())) entry.overdueCount += 1;
          }
        }
        map.set(supplierName, entry);
        return map;
      }, new Map<string, { supplier: string; openQty: number; openValue: number; oldestExpected: Date | null; overdueCount: number }>()),
    )
      .map(([, entry]) => ({
        ...entry,
        oldestExpected: entry.oldestExpected ? entry.oldestExpected.toISOString() : null,
      }))
      .sort((a, b) => b.openValue - a.openValue)
      .slice(0, 4);
    const staleOpenSummary = scopedRows.reduce(
      (acc, row) => {
        if (!isAwaitingReceive(row)) return acc;
        if (!row.expectedAt) {
          acc.missingExpected += 1;
          acc.total += 1;
          return acc;
        }
        const expected = startOfDay(new Date(row.expectedAt));
        if (Number.isNaN(expected.getTime())) return acc;
        const diffDays = Math.round((expected.getTime() - startOfDay(new Date()).getTime()) / (24 * 60 * 60 * 1000));
        if (diffDays <= -7) {
          acc.overdue7Plus += 1;
          acc.total += 1;
        }
        return acc;
      },
      { missingExpected: 0, overdue7Plus: 0, total: 0 },
    );

    if (format === "ids") {
      const condition = searchParams.get("condition") || "";
      let conditionRows = scopedRows;
      if (condition === "pending") {
        conditionRows = scopedRows.filter((row) => String(row.status || "").toUpperCase() === "PENDING_APPROVAL");
      } else if (condition === "open") {
        conditionRows = scopedRows.filter((row) => isAwaitingReceive(row));
      } else if (condition === "overdue") {
        conditionRows = scopedRows.filter((row) => getExpectedUrgency(row)?.tone === "danger");
      }
      return NextResponse.json({ ids: conditionRows.map((row) => row.id) });
    }

    if (format === "csv") {
      const header = ["Date", "Product", "SKU", "Qty", "Received", "Status", "Unit Cost", "Total", "Supplier", "Reason", "Note"];
      const lines = [header.join(",")];
      for (const r of scopedItems) {
        lines.push([
          new Date(r.createdAt).toISOString(),
          JSON.stringify(r.productName),
          JSON.stringify(r.productSku || ""),
          String(r.quantity),
          JSON.stringify(`${Number(r.receivedQuantity ?? r.quantity)} / ${Number(r.orderedQuantity ?? r.quantity)}`),
          JSON.stringify(r.status || "RECEIVED"),
          r.unitCost.toFixed(2),
          r.total.toFixed(2),
          JSON.stringify(r.supplier || ""),
          JSON.stringify(r.reason || ""),
          JSON.stringify(r.note || ""),
        ].join(","));
      }
      const totalQty = scopedItems.reduce((s: number, r: { quantity: number }) => s + r.quantity, 0);
      const totalVal = scopedItems.reduce((s: number, r: { total: number }) => s + r.total, 0);
      lines.push(["Totals", "", "", String(totalQty), "", "", "", totalVal.toFixed(2), "", "", ""].join(","));
      const csv = lines.join("\n");
      return new Response(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename=purchases_${Date.now()}.csv`,
        },
      });
    }

    return NextResponse.json({
      items: scopedItems,
      total: scopedRows.length,
      page: paginate ? page : 1,
      pageSize: paginate ? pageSize : scopedRows.length,
      meta: {
        total: scopedRows.length,
        baseTotal: items.length,
        quickCounts,
        expectedCounts,
        statusCounts,
        viewTotals,
        topSuppliers,
        supplierOpenSummary,
        staleOpenSummary,
        hasScopedViewMismatch: items.length > 0 && scopedRows.length === 0,
      },
    });
  } catch (err) {
    console.error("Error listing purchases:", err);
    return NextResponse.json({ error: "Failed to list purchases" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const user = session.user as AuthenticatedUser;
  const role = user.role;
  const canManagePurchases = hasPermission(role, "purchases.manage");
  if (!canManagePurchases) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  const limited = await rateLimit(req, "admin-purchase-create", 60_000, 60);
  if (!limited.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  try {
    const body = await req.json();
    const productId = String(body.productId || "").trim();
    const quantity = Number(body.quantity);
    const unitCost = Number(body.unitCost);
    const supplier = (body.supplier || "").trim() || null;
    const supplierId = String(body.supplierId || "").trim() || null;
    const reason = (body.reason || "").trim() || null;
    const note = (body.note || "").trim() || null;
    const expectedAt = body.expectedAt ? new Date(body.expectedAt) : null;
    const lotCode = typeof body.lotCode === "string" ? body.lotCode : null;
    const expiryDate = body.expiryDate ? new Date(body.expiryDate) : null;
    if (expectedAt && Number.isNaN(expectedAt.getTime())) {
      return NextResponse.json({ error: "Invalid expected arrival date" }, { status: 400 });
    }
    if (expiryDate && Number.isNaN(expiryDate.getTime())) {
      return NextResponse.json({ error: "Invalid expiry date" }, { status: 400 });
    }
    const receiveNow = body.receiveNow !== false;
    const paidOnReceipt = receiveNow ? body.paidOnReceipt !== false : false;
    const rawPaymentMethod = String(body.paymentMethod || "").toLowerCase();
    const paymentMethod =
      rawPaymentMethod && ["cash", "transfer", "bank", "credit"].includes(rawPaymentMethod)
        ? rawPaymentMethod
        : "";
    if (paidOnReceipt && !["cash", "transfer", "bank"].includes(paymentMethod)) {
      return NextResponse.json({ error: "Select payment mode when paying now." }, { status: 400 });
    }
    const explicitCreditMode = paymentMethod === "credit";
    if (!productId || !Number.isInteger(quantity) || quantity <= 0 || !Number.isFinite(unitCost) || unitCost < 0) {
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }
    const threshold = Number(process.env.PURCHASE_APPROVAL_QTY_THRESHOLD || APPROVAL_QTY_THRESHOLD || 0);
    const paymentAmount = Number(unitCost) * Number(quantity);
    const highValueCreditOnly =
      Number.isFinite(SUPPLIER_PAYMENT_APPROVAL_THRESHOLD) &&
      SUPPLIER_PAYMENT_APPROVAL_THRESHOLD > 0 &&
      paymentAmount >= SUPPLIER_PAYMENT_APPROVAL_THRESHOLD;

    const result = await prisma.$transaction(async (tx: TxClient) => {
      const product = await tx.product.findUnique({
        where: { id: productId },
        select: {
          deletedAt: true,
          sku: true,
          stock: true,
          cost: true,
          name: true,
          supplier: true,
          supplierId: true,
          inventoryPlan: { select: { approvalThresholdQty: true } },
          requiresLotTracking: true,
          requiresExpiryDate: true,
        },
      });
      if (!product) throw new Error("Product not found");
      if (product.deletedAt) throw new Error("Cannot create purchases for deleted products.");
      const oldStock = Number(product.stock || 0);
      const oldCost = Number(product.cost || 0);
      const lotHistory = await tx.inventoryLot.findFirst({
        where: { productId },
        select: { id: true },
      });
      const expiryHistory = await tx.inventoryLot.findFirst({
        where: { productId, expiryDate: { not: null } },
        select: { id: true },
      });
      const requiresLotTracking =
        Boolean(product.requiresLotTracking) ||
        Boolean(product.requiresExpiryDate) ||
        Boolean(lotHistory);
      const requiresExpiryDate = Boolean(product.requiresExpiryDate);
      const requiresExpiryByHistory = Boolean(expiryHistory);
      const effectiveApprovalThreshold = resolveApprovalThresholdQty(
        threshold,
        product.inventoryPlan?.approvalThresholdQty,
      );
      const requiresApproval =
        Number.isFinite(effectiveApprovalThreshold) &&
        effectiveApprovalThreshold > 0
          ? quantity >= effectiveApprovalThreshold
          : false;
      const canReceiveNow = receiveNow && !requiresApproval;
      const status = requiresApproval
        ? "PENDING_APPROVAL"
        : canReceiveNow
        ? "RECEIVED"
        : "ORDERED";
      const effectivePaidOnReceipt = paidOnReceipt && !highValueCreditOnly && !explicitCreditMode;
      // Ignore negative on-hand when computing weighted average cost
      const effectiveOldStock = Math.max(0, oldStock);
      const receiveQty = status === "RECEIVED" ? quantity : 0;
      const newStock = oldStock + receiveQty;
      const denom = effectiveOldStock + receiveQty;
      const newCost = roundCurrency(
        denom > 0 ? (oldCost * effectiveOldStock + unitCost * receiveQty) / denom : oldCost
      );
      if (receiveQty > 0) {
        if (requiresLotTracking && !(lotCode && lotCode.trim())) {
          throw new Error("Lot/Batch code is required for this product.");
        }
        if ((requiresExpiryDate || requiresExpiryByHistory) && !expiryDate) {
          throw new Error("Expiry date is required for this product.");
        }
      }

      const supplierName = String(supplier || "").trim();
      let resolvedSupplierName = supplierName;
      let resolvedSupplierId: string | null = supplierId;
      if (supplierName.toLowerCase() === "unknown") {
        throw new Error("Please enter a real supplier.");
      }
      if (supplierName) {
        const linked = await tx.supplier.upsert({
          where: { name: supplierName },
          create: { name: supplierName },
          update: {},
          select: { id: true },
        });
        resolvedSupplierId = linked.id;
      }
      if (!resolvedSupplierId && product.supplierId) {
        resolvedSupplierId = product.supplierId;
        if (!resolvedSupplierName && product.supplier) {
          resolvedSupplierName = product.supplier;
        }
      }
      if (!resolvedSupplierId && !resolvedSupplierName) {
        throw new Error("Supplier is required for every purchase.");
      }

      if (resolvedSupplierId && resolvedSupplierName) {
        const currentSupplier = String(product.supplier || "");
        if (!product.supplierId || currentSupplier.toLowerCase() === resolvedSupplierName.toLowerCase()) {
          await tx.product.update({
            where: { id: productId },
            data: { supplierId: resolvedSupplierId, supplier: resolvedSupplierName },
          });
        }
      }

      const previousPurchase =
        resolvedSupplierId
          ? await tx.purchase.findFirst({
              where: {
                productId,
                supplierId: resolvedSupplierId,
                status: { in: ["RECEIVED", "PARTIALLY_RECEIVED"] },
                receivedQuantity: { gt: 0 },
              },
              orderBy: { createdAt: "desc" },
              select: { unitCost: true, createdAt: true },
            })
          : null;

      const purchase = await tx.purchase.create({
        data: {
          productId,
          quantity,
          orderedQuantity: quantity,
          receivedQuantity: receiveQty,
          status,
          unitCost,
          supplier: resolvedSupplierName || undefined,
          supplierId: resolvedSupplierId,
          expectedAt,
          reason,
          note,
        },
      });
      let supplierPaymentId: string | null = null;
      let supplierPaymentStatus: string | null = null;

      if (receiveQty > 0) {
        await tx.product.update({
          where: { id: productId },
          data: { stock: newStock, cost: Number(newCost) },
        });

        const lot = await ensureInventoryLot(tx, {
          productId,
          purchaseId: purchase.id,
          supplierId: resolvedSupplierId,
          lotCode,
          expiryDate,
          quantity: receiveQty,
          notes: note,
        });
        await tx.inventoryMovement.create({
          data: {
            productId,
            delta: receiveQty,
            reason: "PURCHASE",
            purchaseId: purchase.id,
            lotId: lot.id,
            note,
          },
        });
      }
      if (receiveQty > 0 && effectivePaidOnReceipt) {
        const payment = await tx.supplierPayment.create({
          data: {
            supplierId: resolvedSupplierId,
            purchaseId: purchase.id,
            amount: Number(unitCost) * Number(receiveQty),
            method: paymentMethod,
            reference: "PURCHASE_RECEIPT",
            note: "Paid on receipt",
            status: "NORMAL",
            paidAt: new Date(),
          },
        });
        supplierPaymentId = payment.id;
        supplierPaymentStatus = payment.status;
      }

      return {
        purchaseId: purchase.id,
        oldStock,
        newStock,
        newCost: Number(newCost),
        productName: product.name,
        productSku: product.sku || null,
        status,
        supplierPaymentId,
        supplierPaymentStatus,
        highValueCreditOnly,
        explicitCreditMode,
        requiresApproval,
        approvalThresholdQty: effectiveApprovalThreshold || null,
        supplierId: resolvedSupplierId,
        supplierName: resolvedSupplierName,
        previousUnitCost: previousPurchase ? Number(previousPurchase.unitCost) : null,
      };
    });

    const correlationId = randomUUID();
    let purchaseJournalEntryId: string | null = null;
    let paymentJournalEntryId: string | null = null;
    try {
      const purchase = await prisma.purchase.findUnique({
        where: { id: result.purchaseId },
        select: { id: true, createdAt: true, quantity: true, unitCost: true },
      });
      if (purchase && result.status === "RECEIVED") {
        const purchaseEntry = await postPurchaseEntry({
          purchaseId: purchase.id,
          amount: Number(purchase.unitCost) * Number(purchase.quantity || 0),
          createdAt: purchase.createdAt,
          memo: supplier || "Inventory purchase",
        });
        purchaseJournalEntryId = purchaseEntry?.id ?? null;
      }
      if (result.supplierPaymentId && result.supplierPaymentStatus === "NORMAL") {
        const paymentEntry = await postSupplierPaymentEntry({ supplierPaymentId: result.supplierPaymentId });
        paymentJournalEntryId = paymentEntry?.id ?? null;
      }
    } catch (e) {
      console.warn("Accounting purchase posting skipped:", e);
      try {
        await recordAuditLog({
          actorId: user.id,
          action: "ACCOUNTING_POST_FAILED",
          entityType: "PURCHASE",
          entityId: result.purchaseId,
          meta: {
            correlationId,
            reason: "purchase_create_post_failed",
            message: e instanceof Error ? e.message : String(e),
            purchaseId: result.purchaseId,
            productId,
            productName: result.productName,
            productSku: result.productSku || null,
            supplierId: result.supplierId,
            supplierName: result.supplierName || supplier || null,
            amount: Number(unitCost) * Number(quantity),
            purchaseJournalEntryId,
            paymentJournalEntryId,
            source: "PURCHASE_CREATE",
          },
        });
      } catch {
        // best-effort
      }
    }

    try {
      await recordAuditLog({
        actorId: user.id,
        action: "PURCHASE_CREATE",
        entityType: "PURCHASE",
        entityId: result.purchaseId,
        meta: {
          correlationId,
          name: result.productName,
          productId,
          productSku: result.productSku || null,
          quantity,
          unitCost,
          amount: Number(unitCost) * Number(quantity),
          stockBefore: result.oldStock,
          stockAfter: result.newStock,
          newStock: result.newStock,
          newCost: result.newCost,
          status: result.status,
          receiveNow,
          paidOnReceipt,
          effectivePaidOnReceipt: result.status === "RECEIVED" ? paidOnReceipt && !result.highValueCreditOnly && !result.explicitCreditMode : false,
          paymentMethod: paymentMethod || null,
          explicitCreditMode: result.explicitCreditMode,
          supplier: result.supplierName || supplier || null,
          supplierId: result.supplierId,
          reason,
          note,
          expectedAt: expectedAt ? expectedAt.toISOString() : null,
          lotCode: normalizeLotCode(lotCode) || null,
          expiryDate: expiryDate ? expiryDate.toISOString() : null,
          highValueCreditOnly: result.highValueCreditOnly,
          requiresApproval: result.requiresApproval,
          approvalThresholdQty: result.approvalThresholdQty,
          purchaseJournalEntryId,
          paymentJournalEntryId,
          source: "PURCHASE_CREATE",
        },
      });
    } catch {
      // best-effort
    }
    try {
      if (result.status === "RECEIVED") {
        const normalizedUnitCost = Number(Number(unitCost || 0).toFixed(2));
        const normalizedNewCost = Number(Number(result.newCost || 0).toFixed(2));
        await recordAuditLog({
          actorId: user.id,
          action: "PRODUCT_STOCK_UPDATE",
          entityType: "PRODUCT",
          entityId: productId,
          meta: {
            correlationId,
            name: result.productName,
            sku: result.productSku || null,
            from: result.oldStock,
            to: result.newStock,
            delta: quantity,
            reason: "PURCHASE",
            unitCost: normalizedUnitCost,
            newCost: normalizedNewCost,
            currency: "GHS",
            source: "PURCHASE_CREATE",
            effectiveAt: new Date().toISOString(),
            purchaseId: result.purchaseId,
            supplier,
            purchaseReason: reason?.trim() || null,
            note: note?.trim() || null,
          },
        });
      }
    } catch {
      // best-effort
    }
    try {
      if (
        result.status === "RECEIVED" &&
        typeof result.previousUnitCost === "number" &&
        Number.isFinite(result.previousUnitCost) &&
        Number(result.previousUnitCost) !== Number(unitCost) &&
        result.supplierId
      ) {
        const oldUnitCost = Number(result.previousUnitCost);
        const newUnitCost = Number(unitCost);
        const delta = newUnitCost - oldUnitCost;
        const deltaPct = oldUnitCost > 0 ? (delta / oldUnitCost) * 100 : null;
        const productForAudit = await prisma.product.findUnique({
          where: { id: productId },
          select: { sku: true },
        });
        await recordAuditLog({
          actorId: user.id,
          action: "SUPPLIER_PRICE_CHANGE",
          entityType: "SUPPLIER",
          entityId: result.supplierId,
          meta: {
            correlationId,
            supplierId: result.supplierId,
            supplierName: result.supplierName,
            productId,
            productName: result.productName,
            productSku: productForAudit?.sku || null,
            oldUnitCost,
            newUnitCost,
            delta,
            deltaAmount: delta,
            deltaPct,
            currency: "GHS",
            changeReason: reason?.trim() || "PURCHASE_CREATE",
            effectiveAt: new Date().toISOString(),
            source: "PURCHASE_CREATE",
            purchaseId: result.purchaseId,
          },
        });
      }
    } catch {
      // best-effort
    }

    try {
      if (result.status === "RECEIVED" && Number(result.oldStock || 0) <= 0 && Number(result.newStock || 0) > 0) {
        await notifyBackInStock(productId);
      }
    } catch (e) {
      console.warn("Back-in-stock notification error:", e);
    }

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("Error creating purchase:", err);
    const message = err instanceof Error ? err.message : "Failed to create purchase";
    const isValidationError =
      message.includes("required") ||
      message.includes("Invalid") ||
      message.includes("Cannot create purchases for deleted products.") ||
      message.includes("Please enter a real supplier.") ||
      message.includes("Supplier is required");
    return NextResponse.json(
      { error: message },
      { status: isValidationError ? 400 : 500 },
    );
  }
}
