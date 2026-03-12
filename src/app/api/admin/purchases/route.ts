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

const APPROVAL_QTY_THRESHOLD = Number(process.env.PURCHASE_APPROVAL_QTY_THRESHOLD || 100);
const SUPPLIER_PAYMENT_APPROVAL_THRESHOLD = Number(
  process.env.SUPPLIER_PAYMENT_APPROVAL_THRESHOLD || 0,
);

type TxClient = Parameters<typeof prisma.$transaction>[0] extends (arg: infer A) => unknown ? A : never;

type PurchasesWhere = Prisma.PurchaseWhereInput;

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
    }));

    if (format === "csv") {
      const header = ["Date", "Product", "SKU", "Qty", "Received", "Status", "Unit Cost", "Total", "Supplier", "Reason", "Note"];
      const lines = [header.join(",")];
      for (const r of items) {
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
      const totalQty = items.reduce((s: number, r: { quantity: number }) => s + r.quantity, 0);
      const totalVal = items.reduce((s: number, r: { total: number }) => s + r.total, 0);
      lines.push(["Totals", "", "", String(totalQty), "", totalVal.toFixed(2), "", "", ""].join(","));
      const csv = lines.join("\n");
      return new Response(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename=purchases_${Date.now()}.csv`,
        },
      });
    }

    return NextResponse.json({ items });
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
      const newCost = denom > 0 ? ((oldCost * effectiveOldStock + unitCost * receiveQty) / denom) : oldCost;
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
    }

    const correlationId = randomUUID();

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
          lotCode: normalizeLotCode(lotCode) || null,
          expiryDate: expiryDate ? expiryDate.toISOString() : null,
          highValueCreditOnly: result.highValueCreditOnly,
          requiresApproval: result.requiresApproval,
          approvalThresholdQty: result.approvalThresholdQty,
          purchaseJournalEntryId,
          paymentJournalEntryId,
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
