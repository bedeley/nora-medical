import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit-log";
import { randomUUID } from "crypto";
import { hasPermission } from "@/lib/permissions";

const csvEscape = (value: unknown) => {
  const str = value == null ? "" : String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

const toCsv = (headers: string[], rows: Array<Record<string, unknown>>) => {
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  }
  return `${lines.join("\n")}\n`;
};

type ReturnMeta = {
  reference?: string;
  orderId?: string;
  appliedToBalance?: number;
  restockToStock?: boolean;
  refundDisposition?: string;
  disposition?: string;
  reason?: string;
  reasonNote?: string;
  item?: { id?: string; quantity?: number; lineRefund?: number };
};

const parseReturnMeta = (note: string | null): ReturnMeta | null => {
  if (!note || !note.trim().startsWith("{")) return null;
  try {
    return JSON.parse(note) as ReturnMeta;
  } catch {
    return null;
  }
};

export async function GET(
  req: Request,
  context: { params: Promise<{ resource: string }> | { resource: string } },
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !hasPermission(user?.role, "export.data")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = await context.params;
  const resource = params.resource;

  const filename = `${resource}-export.csv`;
  let headers: string[] = [];
  let rows: Array<Record<string, unknown>> = [];

  if (resource === "products") {
    headers = [
      "sku",
      "name",
      "category",
      "price",
      "cost",
      "minMarginPct",
      "stock",
      "supplier",
      "supplierId",
      "requiresLotTracking",
      "requiresExpiryDate",
      "updatedAt",
    ];
    const products = await prisma.product.findMany({
      select: {
        sku: true,
        name: true,
        category: true,
        price: true,
        cost: true,
        minMarginPct: true,
        stock: true,
        supplier: true,
        supplierId: true,
        requiresLotTracking: true,
        requiresExpiryDate: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: "desc" },
    });
    rows = products.map((p) => ({
      sku: p.sku || "",
      name: p.name,
      category: p.category || "",
      price: Number(p.price || 0),
      cost: Number(p.cost || 0),
      minMarginPct: p.minMarginPct != null ? Number(p.minMarginPct) : "",
      stock: Number(p.stock || 0),
      supplier: p.supplier || "",
      supplierId: p.supplierId || "",
      requiresLotTracking: p.requiresLotTracking ? "true" : "false",
      requiresExpiryDate: p.requiresExpiryDate ? "true" : "false",
      updatedAt: p.updatedAt.toISOString(),
    }));
  } else if (resource === "suppliers") {
    headers = ["name", "email", "phone", "leadTimeDays", "status", "defaultMinOrderQty", "defaultPackSize", "updatedAt"];
    const suppliers = await prisma.supplier.findMany({
      select: {
        name: true,
        email: true,
        phone: true,
        leadTimeDays: true,
        status: true,
        defaultMinOrderQty: true,
        defaultPackSize: true,
        updatedAt: true,
      },
      where: { deletedAt: null },
      orderBy: { name: "asc" },
    });
    rows = suppliers.map((s) => ({
      name: s.name,
      email: s.email || "",
      phone: s.phone || "",
      leadTimeDays: s.leadTimeDays ?? "",
      status: s.status || "",
      defaultMinOrderQty: s.defaultMinOrderQty ?? "",
      defaultPackSize: s.defaultPackSize ?? "",
      updatedAt: s.updatedAt.toISOString(),
    }));
  } else if (resource === "customers") {
    headers = ["name", "email", "phone", "creditLimit", "role", "archived", "createdAt"];
    const customers = await prisma.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        archived: true,
        createdAt: true,
      },
      where: { role: "CUSTOMER" },
      orderBy: { createdAt: "desc" },
    });
    const balanceRows = await prisma.balance.findMany({
      where: { userId: { in: customers.map((c) => c.id) } },
      select: { userId: true, creditLimit: true },
    });
    const creditLimitByUser = new Map<string, number>();
    for (const row of balanceRows) {
      creditLimitByUser.set(row.userId, Number(row.creditLimit || 0));
    }
    rows = customers.map((c) => ({
      name: c.name || "",
      email: c.email || "",
      phone: c.phone || "",
      creditLimit: creditLimitByUser.get(c.id) ?? 0,
      role: c.role,
      archived: c.archived ? "yes" : "no",
      createdAt: c.createdAt.toISOString(),
    }));
  } else if (resource === "orders") {
    headers = ["invoiceNumber", "customerType", "status", "total", "amountPaid", "balance", "createdAt"];
    const orders = await prisma.order.findMany({
      select: {
        invoiceNumber: true,
        customerType: true,
        status: true,
        total: true,
        amountPaid: true,
        balance: true,
        createdAt: true,
      },
      where: { status: { not: "CANCELLED" } },
      orderBy: { createdAt: "desc" },
    });
    rows = orders.map((o) => ({
      invoiceNumber: o.invoiceNumber || "",
      customerType: o.customerType,
      status: o.status,
      total: Number(o.total || 0),
      amountPaid: Number(o.amountPaid || 0),
      balance: Number(o.balance || 0),
      createdAt: o.createdAt.toISOString(),
    }));
  } else if (resource === "purchases") {
    headers = ["productSku", "productName", "supplier", "quantity", "unitCost", "status", "expectedAt", "createdAt"];
    const purchases = await prisma.purchase.findMany({
      select: {
        quantity: true,
        unitCost: true,
        status: true,
        expectedAt: true,
        createdAt: true,
        supplier: true,
        supplierRef: { select: { name: true } },
        product: { select: { sku: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    rows = purchases.map((p) => ({
      productSku: p.product?.sku || "",
      productName: p.product?.name || "",
      supplier: p.supplierRef?.name || p.supplier || "",
      quantity: Number(p.quantity || 0),
      unitCost: Number(p.unitCost || 0),
      status: p.status || "",
      expectedAt: p.expectedAt ? p.expectedAt.toISOString() : "",
      createdAt: p.createdAt.toISOString(),
    }));
  } else if (resource === "payments") {
    headers = ["orderId", "amount", "status", "refundDisposition", "createdAt"];
    const payments = await prisma.payment.findMany({
      select: {
        orderId: true,
        amount: true,
        status: true,
        refundDisposition: true,
        createdAt: true,
      },
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" },
    });
    rows = payments.map((p) => ({
      orderId: p.orderId || "",
      amount: Number(p.amount || 0),
      status: p.status,
      refundDisposition: p.refundDisposition || "",
      createdAt: p.createdAt.toISOString(),
    }));
  } else if (resource === "inventory") {
    headers = [
      "sku",
      "name",
      "category",
      "stock",
      "unitCost",
      "price",
      "supplier",
      "supplierId",
      "updatedAt",
    ];
    const products = await prisma.product.findMany({
      select: {
        sku: true,
        name: true,
        category: true,
        stock: true,
        cost: true,
        price: true,
        supplier: true,
        supplierId: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: "desc" },
    });
    rows = products.map((p) => ({
      sku: p.sku || "",
      name: p.name,
      category: p.category || "",
      stock: Number(p.stock || 0),
      unitCost: Number(p.cost || 0),
      price: Number(p.price || 0),
      supplier: p.supplier || "",
      supplierId: p.supplierId || "",
      updatedAt: p.updatedAt.toISOString(),
    }));
  } else if (resource === "movements") {
    headers = ["createdAt", "sku", "product", "delta", "reason", "note", "lotCode", "purchaseId"];
    const movements = await prisma.inventoryMovement.findMany({
      select: {
        createdAt: true,
        delta: true,
        reason: true,
        note: true,
        purchaseId: true,
        product: { select: { sku: true, name: true } },
        lot: { select: { lotCode: true } },
      },
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" },
    });
    rows = movements.map((m) => ({
      createdAt: m.createdAt.toISOString(),
      sku: m.product?.sku || "",
      product: m.product?.name || "",
      delta: m.delta,
      reason: m.reason,
      note: m.note || "",
      lotCode: m.lot?.lotCode || "",
      purchaseId: m.purchaseId || "",
    }));
  } else if (resource === "supplierPayments") {
    headers = [
      "supplier",
      "supplierId",
      "purchaseId",
      "amount",
      "status",
      "method",
      "reference",
      "paidAt",
      "approvedAt",
      "createdAt",
    ];
    const supplierPayments = await prisma.supplierPayment.findMany({
      select: {
        supplierId: true,
        purchaseId: true,
        amount: true,
        status: true,
        method: true,
        reference: true,
        paidAt: true,
        approvedAt: true,
        createdAt: true,
        supplier: { select: { name: true } },
      },
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" },
    });
    rows = supplierPayments.map((p) => ({
      supplier: p.supplier?.name || "",
      supplierId: p.supplierId || "",
      purchaseId: p.purchaseId || "",
      amount: Number(p.amount || 0),
      status: p.status,
      method: p.method || "",
      reference: p.reference || "",
      paidAt: p.paidAt ? p.paidAt.toISOString() : "",
      approvedAt: p.approvedAt ? p.approvedAt.toISOString() : "",
      createdAt: p.createdAt.toISOString(),
    }));
  } else if (resource === "inventoryLots") {
    headers = [
      "product",
      "sku",
      "supplier",
      "supplierId",
      "lotCode",
      "expiryDate",
      "receivedAt",
      "quantityReceived",
      "quantityRemaining",
      "notes",
      "updatedAt",
    ];
    const lots = await prisma.inventoryLot.findMany({
      select: {
        lotCode: true,
        expiryDate: true,
        receivedAt: true,
        quantityReceived: true,
        quantityRemaining: true,
        notes: true,
        updatedAt: true,
        supplierId: true,
        product: { select: { name: true, sku: true } },
        supplier: { select: { name: true } },
      },
      orderBy: { updatedAt: "desc" },
    });
    rows = lots.map((lot) => ({
      product: lot.product?.name || "",
      sku: lot.product?.sku || "",
      supplier: lot.supplier?.name || "",
      supplierId: lot.supplierId || "",
      lotCode: lot.lotCode,
      expiryDate: lot.expiryDate ? lot.expiryDate.toISOString() : "",
      receivedAt: lot.receivedAt.toISOString(),
      quantityReceived: lot.quantityReceived,
      quantityRemaining: lot.quantityRemaining,
      notes: lot.notes || "",
      updatedAt: lot.updatedAt.toISOString(),
    }));
  } else if (resource === "inventoryPlanning") {
    headers = [
      "product",
      "sku",
      "reorderPoint",
      "fallbackReorderPoint",
      "safetyStock",
      "leadTimeDays",
      "reviewPeriodDays",
      "minOrderQty",
      "approvalThresholdQty",
      "targetStock",
      "notes",
      "updatedAt",
    ];
    const plans = await prisma.inventoryPlan.findMany({
      select: {
        reorderPoint: true,
        fallbackReorderPoint: true,
        safetyStock: true,
        leadTimeDays: true,
        reviewPeriodDays: true,
        minOrderQty: true,
        approvalThresholdQty: true,
        targetStock: true,
        notes: true,
        updatedAt: true,
        product: { select: { name: true, sku: true } },
      },
      orderBy: { updatedAt: "desc" },
    });
    rows = plans.map((plan) => ({
      product: plan.product?.name || "",
      sku: plan.product?.sku || "",
      reorderPoint: plan.reorderPoint,
      fallbackReorderPoint: plan.fallbackReorderPoint ?? "",
      safetyStock: plan.safetyStock,
      leadTimeDays: plan.leadTimeDays,
      reviewPeriodDays: plan.reviewPeriodDays,
      minOrderQty: plan.minOrderQty,
      approvalThresholdQty: plan.approvalThresholdQty ?? "",
      targetStock: plan.targetStock,
      notes: plan.notes || "",
      updatedAt: plan.updatedAt.toISOString(),
    }));
  } else if (resource === "inventoryPlanningSuggestions") {
    headers = [
      "product",
      "sku",
      "suggestedQty",
      "reason",
      "status",
      "createdAt",
      "updatedAt",
    ];
    const suggestions = await prisma.restockSuggestion.findMany({
      select: {
        suggestedQty: true,
        reason: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        product: { select: { name: true, sku: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    rows = suggestions.map((s) => ({
      product: s.product?.name || "",
      sku: s.product?.sku || "",
      suggestedQty: s.suggestedQty,
      reason: s.reason || "",
      status: s.status || "",
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    }));
  } else if (resource === "returns") {
    headers = [
      "createdAt",
      "orderId",
      "customerName",
      "customerEmail",
      "itemLabel",
      "quantity",
      "refundTotal",
      "refundDisposition",
      "appliedToBalance",
      "restock",
      "rmaDisposition",
      "returnReason",
      "returnReasonNote",
      "source",
    ];

    const payments = await prisma.payment.findMany({
      where: {
        deletedAt: null,
        note: { contains: "ITEM_RETURN" },
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        orderId: true,
        amount: true,
        refundDisposition: true,
        note: true,
        createdAt: true,
        user: { select: { name: true, email: true } },
      },
    });

    const paymentItemIds = payments
      .map((p) => parseReturnMeta(p.note)?.item?.id)
      .filter((id): id is string => Boolean(id));

    const items = paymentItemIds.length
      ? await prisma.orderItem.findMany({
          where: { id: { in: paymentItemIds } },
          select: { id: true, product: { select: { name: true } } },
        })
      : [];
    const itemNameById = new Map(items.map((row) => [row.id, row.product?.name || "Item"]));

    const paymentRows = payments.map((payment) => {
      const meta = parseReturnMeta(payment.note);
      const refundDisposition =
        payment.refundDisposition ||
        (meta?.refundDisposition ? String(meta.refundDisposition).toUpperCase() : "");
      const orderId = payment.orderId || meta?.orderId || "";
      const itemId = meta?.item?.id;
      const itemLabel = itemId ? itemNameById.get(itemId) || "" : "";
      const quantity = meta?.item?.quantity ? Number(meta.item.quantity) : "";
      const refundTotal = Number(meta?.item?.lineRefund ?? Math.abs(Number(payment.amount || 0)));
      const appliedToBalance = Number(meta?.appliedToBalance || 0);
      const restock = meta?.restockToStock ?? null;
      const rmaDisposition = meta?.disposition || (restock === null ? "" : restock ? "RESTOCK" : "SCRAP");
      const returnReason = meta?.reason ? String(meta.reason) : "";
      const returnReasonNote = meta?.reasonNote ? String(meta.reasonNote) : "";
      const effectiveDisposition =
        appliedToBalance > 0 && refundTotal - appliedToBalance <= 0.01
          ? "APPLIED"
          : refundDisposition;
      return {
        createdAt: payment.createdAt.toISOString(),
        orderId,
        customerName: payment.user?.name || "",
        customerEmail: payment.user?.email || "",
        itemLabel,
        quantity,
        refundTotal,
        refundDisposition: effectiveDisposition,
        appliedToBalance,
        restock: restock === null ? "" : restock ? "yes" : "no",
        rmaDisposition,
        returnReason,
        returnReasonNote,
        source: "PAYMENT",
      };
    });

    const journalEntries = await prisma.journalEntry.findMany({
      where: {
        status: "POSTED",
        sourceType: "ORDER",
        memo: { startsWith: "Return/refund -" },
      },
      orderBy: { entryDate: "desc" },
      include: { lines: { include: { account: true } } },
    });

    const orderIdsFromJournal = journalEntries
      .map((entry) => {
        const match = entry.memo?.match(/\(([^)]+)\)\s*$/);
        return match?.[1] || null;
      })
      .filter((id): id is string => Boolean(id));

    const orders = orderIdsFromJournal.length
      ? await prisma.order.findMany({
          where: { id: { in: orderIdsFromJournal } },
          select: { id: true, user: { select: { name: true, email: true } } },
        })
      : [];
    const orderById = new Map(orders.map((o) => [o.id, o]));

    const paymentKeys = new Set(
      paymentRows.map((row) => `${row.orderId}|${row.itemLabel}|${Number(row.refundTotal).toFixed(2)}`),
    );

    const journalRows = journalEntries.map((entry) => {
      const memo = entry.memo || "";
      const orderMatch = memo.match(/\(([^)]+)\)\s*$/);
      const labelMatch = memo.match(/^Return\/refund\s*-\s*(.*)\s+\(/);
      const orderId = orderMatch?.[1] || "";
      const order = orderById.get(orderId);
      const refundLine = entry.lines.find((line) => line.account.code === "4000" && Number(line.debit || 0) > 0);
      const inventoryLine = entry.lines.find(
        (line) => line.account.code === "1200" && Number(line.debit || 0) > 0,
      );
      const cashLine = entry.lines.find((line) => line.account.code === "1000" && Number(line.credit || 0) > 0);
      const storeCreditLine = entry.lines.find(
        (line) => line.account.code === "2200" && Number(line.credit || 0) > 0,
      );
      const arLine = entry.lines.find((line) => line.account.code === "1100" && Number(line.credit || 0) > 0);
      const refundTotal = Number(refundLine?.debit || 0);
      const restock = Boolean(inventoryLine);
      const rmaDisposition = restock ? "RESTOCK" : "SCRAP";
      const appliedToBalance = Number(arLine?.credit || 0);
      const refundDisposition = cashLine ? "CASH" : storeCreditLine ? "CREDIT" : appliedToBalance > 0 ? "APPLIED" : "APPLIED";
      return {
        createdAt: entry.entryDate.toISOString(),
        orderId,
        customerName: order?.user?.name || "",
        customerEmail: order?.user?.email || "",
        itemLabel: labelMatch?.[1] || "",
        quantity: "",
        refundTotal,
        refundDisposition,
        appliedToBalance,
        restock: restock ? "yes" : "no",
        rmaDisposition,
        returnReason: "",
        returnReasonNote: "",
        source: "ORDER",
      };
    });

    const dedupedJournalRows = journalRows.filter((row) => {
      const key = `${row.orderId}|${row.itemLabel}|${Number(row.refundTotal).toFixed(2)}`;
      return !paymentKeys.has(key);
    });

    rows = [...paymentRows, ...dedupedJournalRows].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  } else if (resource === "audit") {
    headers = ["createdAt", "actorId", "actorName", "actorEmail", "action", "entityType", "entityId", "meta"];
    const audits = await prisma.auditLog.findMany({
      select: {
        createdAt: true,
        actorId: true,
        action: true,
        entityType: true,
        entityId: true,
        meta: true,
        actor: { select: { name: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    rows = audits.map((a) => ({
      createdAt: a.createdAt.toISOString(),
      actorId: a.actorId || "",
      actorName: a.actor?.name || "",
      actorEmail: a.actor?.email || "",
      action: a.action || "",
      entityType: a.entityType || "",
      entityId: a.entityId || "",
      meta: a.meta || "",
    }));
  } else {
    return NextResponse.json({ error: "Resource not supported" }, { status: 400 });
  }

  await recordAuditLog({
    actorId: user?.id,
    action: "IMPORT_EXPORT",
    entityType: "IMPORT_EXPORT",
    entityId: randomUUID(),
    meta: {
      action: "EXPORT",
      resource,
      format: "csv",
      count: rows.length,
      url: new URL(req.url).pathname,
    },
  });

  const body = toCsv(headers, rows);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename=${filename}`,
    },
  });
}
