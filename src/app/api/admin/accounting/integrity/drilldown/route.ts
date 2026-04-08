import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import type { AccountType } from "@prisma/client";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type DrilldownKey = "ar" | "inventory" | "ap" | "revenue" | "cogs" | "vat" | "store_credit";

function isAuthorized(user?: AuthenticatedUser | null) {
  const role = user?.role;
  return role === "ADMIN" || role === "ACCOUNTANT";
}

function parseAsOfUtcEnd(asOf?: string | null) {
  if (!asOf) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(asOf.trim());
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999));
}

function toAmount(value: unknown) {
  return Number(value || 0);
}

function toIso(value?: Date | null) {
  return value ? value.toISOString() : null;
}

function toBaseSourceId(value?: string | null) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.split(":")[0] || raw;
}

function sortRowsByDateDesc<T extends { date: string | null }>(rows: T[]) {
  return [...rows].sort((a, b) => {
    const aMs = a.date ? new Date(a.date).getTime() : 0;
    const bMs = b.date ? new Date(b.date).getTime() : 0;
    return bMs - aMs;
  });
}

async function getLedgerBreakdown(accountCode: string, asOfEnd?: Date) {
  const account = await prisma.ledgerAccount.findUnique({
    where: { code: accountCode },
    select: { id: true, code: true, name: true, type: true },
  });
  if (!account) {
    throw new Error(`Ledger account ${accountCode} not found.`);
  }

  const normalizeAccountAmount = (type: AccountType, debit: number, credit: number) => {
    if (type === "ASSET" || type === "EXPENSE") return debit - credit;
    return credit - debit;
  };

  const rows = await prisma.journalLine.findMany({
    where: {
      accountId: account.id,
      entry: {
        status: "POSTED",
        ...(asOfEnd ? { entryDate: { lte: asOfEnd } } : {}),
      },
    },
    select: {
      id: true,
      debit: true,
      credit: true,
      description: true,
      createdAt: true,
      entry: {
        select: {
          id: true,
          entryDate: true,
          memo: true,
          sourceType: true,
          sourceId: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const normalized = rows
    .map((row) => ({
      id: row.id,
      entryId: row.entry.id,
      date: row.entry.entryDate.toISOString(),
      sourceType: row.entry.sourceType,
      sourceId: row.entry.sourceId || null,
      memo: row.entry.memo || null,
      description: row.description || null,
      debit: toAmount(row.debit),
      credit: toAmount(row.credit),
      amount: normalizeAccountAmount(account.type, toAmount(row.debit), toAmount(row.credit)),
    }))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return {
    code: account.code,
    name: account.name,
    total: normalized.reduce((sum, row) => sum + row.amount, 0),
    rows: normalized,
  };
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || !isAuthorized(session.user as AuthenticatedUser)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const keyRaw = String(searchParams.get("key") || "").trim().toLowerCase();
  const key = keyRaw as DrilldownKey;
  const asOf = searchParams.get("asOf");
  const asOfEnd = parseAsOfUtcEnd(asOf);

  if (!["ar", "inventory", "ap", "revenue", "cogs", "vat", "store_credit"].includes(key)) {
    return NextResponse.json({ error: "Unsupported drilldown key." }, { status: 400 });
  }
  if (asOf && asOfEnd === null) {
    return NextResponse.json({ error: "Invalid as-of date. Use YYYY-MM-DD." }, { status: 400 });
  }

  try {
    if (key === "ar") {
      const ledger = await getLedgerBreakdown("1100", asOfEnd || undefined);
      const [orders, payments] = await Promise.all([
        prisma.order.findMany({
          where: {
            deletedAt: null,
            status: { not: "CANCELLED" },
            ...(asOfEnd ? { createdAt: { lte: asOfEnd } } : {}),
          },
          select: {
            id: true,
            createdAt: true,
            invoiceNumber: true,
            status: true,
          },
          orderBy: { createdAt: "desc" },
        }),
        prisma.payment.findMany({
          where: {
            deletedAt: null,
            ...(asOfEnd ? { createdAt: { lte: asOfEnd } } : {}),
          },
          select: {
            id: true,
            createdAt: true,
            amount: true,
            status: true,
            refundDisposition: true,
            note: true,
            orderId: true,
            order: { select: { invoiceNumber: true } },
          },
          orderBy: { createdAt: "desc" },
        }),
      ]);

      const eligiblePayments = payments.filter((row) => {
        const amount = toAmount(row.amount);
        if (amount <= 0) return false;
        const status = String(row.status || "").toUpperCase();
        if (status === "REFUND" || status === "VOID") return false;
        const disposition = String(row.refundDisposition || "").toUpperCase();
        if (disposition === "CREDIT") return false;
        if (row.note) {
          try {
            const meta = JSON.parse(row.note) as { reference?: string; balanceAdjustment?: boolean };
            if (meta.reference === "ITEM_RETURN") return false;
            if (meta.balanceAdjustment) return false;
          } catch {
            // ignore malformed notes
          }
        }
        return true;
      });

      const orderById = new Map(orders.map((row) => [row.id, row]));
      const paymentById = new Map(eligiblePayments.map((row) => [row.id, row]));
      const orderBasisRows = ledger.rows
        .filter((row) => row.sourceType === "ORDER" && row.amount > 0.005)
        .map((row) => {
          const order = row.sourceId ? orderById.get(row.sourceId) : undefined;
          return {
            id: `order:${row.id}`,
            date: row.date,
            type: "Posted receivable basis",
            reference: order?.invoiceNumber || row.sourceId || row.entryId,
            detail: order?.status || row.description || row.memo || "Posted order receivable",
            amount: row.amount,
          };
        });
      const paymentRows = eligiblePayments.map((row) => ({
        id: row.id,
        date: toIso(row.createdAt),
        type: "Customer payment",
        reference: row.order?.invoiceNumber || row.orderId || row.id,
        detail: row.orderId ? `Applied to order ${row.orderId}` : "Unapplied customer payment",
        amount: -toAmount(row.amount),
      }));
      const unclampedOperationalTotal = [...orderBasisRows, ...paymentRows].reduce((sum, row) => sum + row.amount, 0);
      const operationalTotal = Math.max(0, unclampedOperationalTotal);
      const operationalRows = sortRowsByDateDesc([...orderBasisRows, ...paymentRows]);
      const ledgerRows = ledger.rows.map((row) => {
        const baseSourceId = toBaseSourceId(row.sourceId);
        if (row.sourceType === "ORDER" && baseSourceId && orderById.has(baseSourceId)) {
          const order = orderById.get(baseSourceId)!;
          return {
            ...row,
            traceStatus: "matched_operational",
            traceCategory: "Linked order receivable",
            traceNote: order.invoiceNumber || order.status,
          };
        }
        if (row.sourceType === "PAYMENT" && baseSourceId && paymentById.has(baseSourceId)) {
          const payment = paymentById.get(baseSourceId)!;
          return {
            ...row,
            traceStatus: "matched_operational",
            traceCategory: "Linked customer payment",
            traceNote: payment.order?.invoiceNumber || payment.orderId || "Customer payment",
          };
        }
        return {
          ...row,
          traceStatus: "gl_only",
          traceCategory: "GL-only AR journal",
          traceNote: baseSourceId
            ? `Source ${baseSourceId} is not part of the current receivable basis snapshot.`
            : "No linked order or eligible payment source.",
        };
      });
      const matchedLedgerTotal = ledgerRows
        .filter((row) => row.traceStatus === "matched_operational")
        .reduce((sum, row) => sum + row.amount, 0);
      const glOnlyRows = ledgerRows.filter((row) => row.traceStatus === "gl_only");
      const glOnlyTotal = glOnlyRows.reduce((sum, row) => sum + row.amount, 0);
      const alerts: Array<{ tone: "info" | "warning"; message: string }> = [];
      if (Math.abs(glOnlyTotal) > 0.005) {
        alerts.push({
          tone: "warning",
          message:
            `${glOnlyRows.length} GL-only AR journal row(s) totaling ${glOnlyTotal.toFixed(2)} ` +
            "are included in the ledger balance but do not map to the receivable basis used on the integrity page.",
        });
      }
      if (unclampedOperationalTotal < 0) {
        alerts.push({
          tone: "info",
          message:
            `Eligible payments exceed posted receivable basis by ${Math.abs(unclampedOperationalTotal).toFixed(2)}. ` +
            "The integrity page clamps operational AR to zero in that case.",
        });
      } else if (Math.abs(matchedLedgerTotal - operationalTotal) <= 0.005 && Math.abs(glOnlyTotal) > 0.005) {
        alerts.push({
          tone: "info",
          message:
            `Receivable-basis AR matches ${matchedLedgerTotal.toFixed(2)}. ` +
            "The remaining variance is coming from GL-only AR journal lines.",
        });
      }

      return NextResponse.json({
        key,
        label: "AR (Receivables)",
        code: "1100",
        asOf,
        difference: ledger.total - operationalTotal,
        methodology: [
          "GL side includes every posted journal line on account 1100 up to the selected as-of date.",
          "Operational side uses the same receivable basis as the integrity page: posted order receivable lines on AR plus eligible customer payments as settlements.",
          "Refunds, voids, credit-destination refunds, item returns, and balance-adjustment payments are excluded from the AR settlement basis.",
        ],
        alerts,
        ledger: {
          ...ledger,
          rows: ledgerRows,
        },
        operational: {
          label: "Receivable basis contributors",
          total: operationalTotal,
          rows: operationalRows,
        },
      });
    }

    if (key === "inventory") {
      const ledger = await getLedgerBreakdown("1200", asOfEnd || undefined);
      const [products, movements] = await Promise.all([
        prisma.product.findMany({
          select: { id: true, name: true, sku: true, cost: true },
        }),
        prisma.inventoryMovement.groupBy({
          by: ["productId"],
          where: {
            deletedAt: null,
            ...(asOfEnd ? { createdAt: { lte: asOfEnd } } : {}),
          },
          _sum: { delta: true },
        }),
      ]);

      const stockByProduct = new Map<string, number>();
      for (const movement of movements) {
        stockByProduct.set(movement.productId, toAmount(movement._sum.delta));
      }

      const operationalRows = products
        .map((product) => {
          const qty = stockByProduct.get(product.id) ?? 0;
          const unitCost = toAmount(product.cost);
          const amount = qty * unitCost;
          return {
            id: product.id,
            date: null,
            type: "Inventory valuation",
            reference: product.sku ? `${product.name} (${product.sku})` : product.name,
            detail: `Qty ${qty} x ${unitCost.toFixed(2)}`,
            amount,
          };
        })
        .filter((row) => Math.abs(row.amount) > 0.005 || row.detail.includes("Qty -"));

      const operationalTotal = operationalRows.reduce((sum, row) => sum + row.amount, 0);

      return NextResponse.json({
        key,
        label: "Inventory",
        code: "1200",
        asOf,
        difference: ledger.total - operationalTotal,
        methodology: [
          "GL side includes every posted journal line on account 1200 up to the selected as-of date.",
          "Operational side is the movement-based stock snapshot: quantity on hand per product multiplied by current unit cost.",
        ],
        ledger,
        operational: {
          label: "Inventory valuation contributors",
          total: operationalTotal,
          rows: operationalRows.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)),
        },
      });
    }

    if (key === "ap") {
      const ledger = await getLedgerBreakdown("2000", asOfEnd || undefined);
      const [purchases, supplierPayments] = await Promise.all([
        prisma.purchase.findMany({
          where: {
            deletedAt: null,
            status: "RECEIVED",
            ...(asOfEnd ? { createdAt: { lte: asOfEnd } } : {}),
          },
          select: {
            id: true,
            createdAt: true,
            quantity: true,
            unitCost: true,
            supplier: true,
            supplierRef: { select: { name: true } },
            product: { select: { name: true, sku: true } },
          },
          orderBy: { createdAt: "desc" },
        }),
        prisma.supplierPayment.findMany({
          where: {
            deletedAt: null,
            status: "NORMAL",
            ...(asOfEnd ? { createdAt: { lte: asOfEnd } } : {}),
          },
          select: {
            id: true,
            createdAt: true,
            amount: true,
            method: true,
            reference: true,
            supplier: { select: { name: true } },
            purchase: {
              select: {
                id: true,
                product: { select: { name: true, sku: true } },
              },
            },
          },
          orderBy: { createdAt: "desc" },
        }),
      ]);

      const eligibleSupplierPayments = supplierPayments.filter((row) => {
        const method = String(row.method || "").toLowerCase();
        if (method === "credit_memo") return false;
        if (String(row.reference || "").toUpperCase() === "SUPPLIER_RETURN") return false;
        return true;
      });

      const purchaseRows = purchases.map((row) => ({
        id: row.id,
        date: toIso(row.createdAt),
        type: "Received purchase",
        reference: row.product?.sku ? `${row.product.name} (${row.product.sku})` : row.product?.name || row.id,
        detail: row.supplierRef?.name || row.supplier || "Supplier not set",
        amount: toAmount(row.unitCost) * toAmount(row.quantity),
      }));

      const paymentRows = eligibleSupplierPayments.map((row) => ({
        id: row.id,
        date: toIso(row.createdAt),
        type: "Supplier payment",
        reference: row.purchase?.product?.sku
          ? `${row.purchase.product.name} (${row.purchase.product.sku})`
          : row.purchase?.product?.name || row.purchase?.id || row.id,
        detail: row.supplier?.name || row.reference || row.method || "Supplier payment",
        amount: -toAmount(row.amount),
      }));

      const operationalRows = sortRowsByDateDesc([...purchaseRows, ...paymentRows]);
      const operationalTotal = operationalRows.reduce((sum, row) => sum + row.amount, 0);
      const purchaseById = new Map(purchases.map((row) => [row.id, row]));
      const supplierPaymentById = new Map(eligibleSupplierPayments.map((row) => [row.id, row]));
      const ledgerRows = ledger.rows.map((row) => {
        const baseSourceId = toBaseSourceId(row.sourceId);
        const purchase = baseSourceId ? purchaseById.get(baseSourceId) : undefined;
        if (purchase) {
          const supplierName = purchase.supplierRef?.name || purchase.supplier || "Supplier not set";
          return {
            ...row,
            traceStatus: "matched_operational",
            traceCategory: "Linked received purchase",
            traceNote: supplierName,
          };
        }

        const supplierPayment = baseSourceId ? supplierPaymentById.get(baseSourceId) : undefined;
        if (supplierPayment) {
          return {
            ...row,
            traceStatus: "matched_operational",
            traceCategory: "Linked supplier payment",
            traceNote: supplierPayment.supplier?.name || supplierPayment.reference || supplierPayment.method || "Supplier payment",
          };
        }

        if (!baseSourceId) {
          return {
            ...row,
            traceStatus: "gl_only",
            traceCategory: "GL-only AP journal",
            traceNote: "No linked received purchase or supplier payment source.",
          };
        }

        return {
          ...row,
          traceStatus: "gl_only",
          traceCategory: "Unmatched AP source",
          traceNote: `Source ${baseSourceId} is not a received purchase or eligible supplier payment.`,
        };
      });
      const linkedLedgerTotal = ledgerRows
        .filter((row) => row.traceStatus === "matched_operational")
        .reduce((sum, row) => sum + row.amount, 0);
      const glOnlyRows = ledgerRows.filter((row) => row.traceStatus === "gl_only");
      const glOnlyTotal = glOnlyRows.reduce((sum, row) => sum + row.amount, 0);
      const alerts: Array<{ tone: "info" | "warning"; message: string }> = [];
      if (Math.abs(glOnlyTotal) > 0.005) {
        alerts.push({
          tone: "warning",
          message:
            `${glOnlyRows.length} GL-only AP journal row(s) totaling ${glOnlyTotal.toFixed(2)} ` +
            "are included in the GL balance but do not map to a received purchase or eligible supplier payment.",
        });
      }
      if (Math.abs(linkedLedgerTotal - operationalTotal) <= 0.005) {
        alerts.push({
          tone: "info",
          message:
            `Operational-backed AP matches ${linkedLedgerTotal.toFixed(2)}. ` +
            "The remaining variance is coming from GL-only AP journal lines.",
        });
      }

      return NextResponse.json({
        key,
        label: "AP (Payables)",
        code: "2000",
        asOf,
        difference: ledger.total - operationalTotal,
        methodology: [
          "AP is a liability account, so GL contributors on account 2000 are shown on their normal credit-balance basis.",
          "GL side includes every posted journal line on account 2000 up to the selected as-of date.",
          "Operational side includes received purchases as positive liability drivers and eligible supplier payments as negative settlements.",
          "Credit-memo and supplier-return settlement rows are excluded from the operational AP basis to match the intended integrity rule.",
        ],
        alerts,
        ledger: {
          ...ledger,
          rows: ledgerRows,
        },
        operational: {
          label: "Received AP contributors",
          total: operationalTotal,
          rows: operationalRows,
        },
      });
    }

    if (key === "revenue" || key === "vat") {
      const accountCode = key === "revenue" ? "4000" : "2100";
      const label = key === "revenue" ? "Revenue" : "VAT Payable";
      const ledger = await getLedgerBreakdown(accountCode, asOfEnd || undefined);
      const orders = await prisma.order.findMany({
        where: {
          deletedAt: null,
          status: { not: "CANCELLED" },
          ...(asOfEnd ? { createdAt: { lte: asOfEnd } } : {}),
        },
        select: {
          id: true,
          createdAt: true,
          invoiceNumber: true,
          subtotal: true,
          taxAmount: true,
          status: true,
        },
        orderBy: { createdAt: "desc" },
      });

      const operationalRows = orders
        .map((row) => ({
          id: row.id,
          date: toIso(row.createdAt),
          type: key === "revenue" ? "Order subtotal" : "Order VAT",
          reference: row.invoiceNumber || row.id,
          detail: row.status,
          amount: key === "revenue" ? toAmount(row.subtotal) : toAmount(row.taxAmount),
        }))
        .filter((row) => Math.abs(row.amount) > 0.005);

      const operationalTotal = operationalRows.reduce((sum, row) => sum + row.amount, 0);

      return NextResponse.json({
        key,
        label,
        code: accountCode,
        asOf,
        difference: ledger.total - operationalTotal,
        methodology: [
          `GL side includes every posted journal line on account ${accountCode} up to the selected as-of date.`,
          key === "revenue"
            ? "Operational side includes order subtotals from non-cancelled orders."
            : "Operational side includes tax amounts from non-cancelled orders.",
        ],
        ledger,
        operational: {
          label: key === "revenue" ? "Order revenue contributors" : "Order VAT contributors",
          total: operationalTotal,
          rows: operationalRows,
        },
      });
    }

    if (key === "cogs") {
      const ledger = await getLedgerBreakdown("5000", asOfEnd || undefined);
      const orderItems = await prisma.orderItem.findMany({
        where: {
          order: {
            deletedAt: null,
            status: { not: "CANCELLED" },
            ...(asOfEnd ? { createdAt: { lte: asOfEnd } } : {}),
          },
        },
        select: {
          id: true,
          quantity: true,
          returnedQuantity: true,
          costAtSale: true,
          order: {
            select: {
              id: true,
              createdAt: true,
              invoiceNumber: true,
            },
          },
        },
      });

      const byOrder = new Map<string, { date: string | null; reference: string; amount: number; itemCount: number }>();
      for (const item of orderItems) {
        const soldQty = Math.max(0, toAmount(item.quantity) - toAmount(item.returnedQuantity));
        const amount = soldQty * toAmount(item.costAtSale);
        const keyRef = item.order.id;
        const existing = byOrder.get(keyRef) || {
          date: toIso(item.order.createdAt),
          reference: item.order.invoiceNumber || item.order.id,
          amount: 0,
          itemCount: 0,
        };
        existing.amount += amount;
        existing.itemCount += 1;
        byOrder.set(keyRef, existing);
      }

      const operationalRows = sortRowsByDateDesc(
        Array.from(byOrder.entries())
          .map(([id, row]) => ({
            id,
            date: row.date,
            type: "Sold-item cost",
            reference: row.reference,
            detail: `${row.itemCount} line(s)`,
            amount: row.amount,
          }))
          .filter((row) => Math.abs(row.amount) > 0.005),
      );

      const operationalTotal = operationalRows.reduce((sum, row) => sum + row.amount, 0);

      return NextResponse.json({
        key,
        label: "COGS",
        code: "5000",
        asOf,
        difference: ledger.total - operationalTotal,
        methodology: [
          "GL side includes every posted journal line on account 5000 up to the selected as-of date.",
          "Operational side aggregates order-item cost-at-sale for net sold quantity after returns.",
        ],
        ledger,
        operational: {
          label: "Order cost contributors",
          total: operationalTotal,
          rows: operationalRows,
        },
      });
    }

    const ledger = await getLedgerBreakdown("2200", asOfEnd || undefined);
    const [creditRefunds, creditPayouts] = await Promise.all([
      prisma.payment.findMany({
        where: {
          deletedAt: null,
          status: "REFUND",
          refundDisposition: "CREDIT",
          ...(asOfEnd ? { createdAt: { lte: asOfEnd } } : {}),
        },
        select: {
          id: true,
          createdAt: true,
          amount: true,
          orderId: true,
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.payment.findMany({
        where: {
          deletedAt: null,
          status: "REFUND",
          refundDisposition: "CASH",
          note: { contains: "\"location\":\"admin/customers:credit-payout\"" },
          ...(asOfEnd ? { createdAt: { lte: asOfEnd } } : {}),
        },
        select: {
          id: true,
          createdAt: true,
          amount: true,
          orderId: true,
        },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    const operationalRows = sortRowsByDateDesc([
      ...creditRefunds.map((row) => ({
        id: row.id,
        date: toIso(row.createdAt),
        type: "Refund to store credit",
        reference: row.orderId || row.id,
        detail: "Store-credit liability increase",
        amount: toAmount(row.amount),
      })),
      ...creditPayouts.map((row) => ({
        id: row.id,
        date: toIso(row.createdAt),
        type: "Credit payout",
        reference: row.orderId || row.id,
        detail: "Store-credit liability settlement",
        amount: -toAmount(row.amount),
      })),
    ]);
    const operationalTotal = operationalRows.reduce((sum, row) => sum + row.amount, 0);

    return NextResponse.json({
      key,
      label: "Store Credit",
      code: "2200",
      asOf,
      difference: ledger.total - operationalTotal,
      methodology: [
        "GL side includes every posted journal line on account 2200 up to the selected as-of date.",
        "Operational side includes refunds issued to customer credit as positive rows and cash credit payouts as negative rows.",
      ],
      ledger,
      operational: {
        label: "Store-credit contributors",
        total: operationalTotal,
        rows: operationalRows,
      },
    });
  } catch (error) {
    console.error("Integrity drilldown error:", error);
    return NextResponse.json({ error: "Failed to load integrity drilldown." }, { status: 500 });
  }
}
