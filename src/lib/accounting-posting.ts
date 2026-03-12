import { prisma } from "@/lib/prisma";
import { isFeatureEnabled } from "@/lib/features";
import { findClosedPeriod } from "@/lib/accounting-periods";
import { recordAuditLog } from "@/lib/audit-log";

type SourceType = "ORDER" | "PAYMENT" | "EXPENSE" | "PURCHASE" | "PAYROLL" | "MANUAL";

type LineInput = {
  accountCode: string;
  debit: number;
  credit: number;
  description?: string;
  taxCodeId?: string | null;
};

const DEFAULT_ACCOUNT_CODES = {
  CASH: "1000",
  BANK: "1010",
  CASH_IN_TRANSIT: "1020",
  MOMO_CLEARING: "1030",
  GATEWAY_CLEARING: "1040",
  AR: "1100",
  INVENTORY: "1200",
  AP: "2000",
  VAT_PAYABLE: "2100",
  STORE_CREDIT: "2200",
  ACCRUED_EXPENSES: "2300",
  PAYROLL_PAYABLE: "2400",
  CUSTOMER_DEPOSITS: "2500",
  SALES: "4000",
  SALES_DISCOUNTS: "4010",
  COGS: "5000",
  OPERATING_EXPENSE: "6000",
  PAYROLL_EXPENSE: "6100",
  DELIVERY_EXPENSE: "6200",
  BANK_CHARGES_EXPENSE: "6300",
  UTILITIES_EXPENSE: "6400",
  RENT_EXPENSE: "6500",
  REPAIRS_MAINTENANCE_EXPENSE: "6600",
  MARKETING_EXPENSE: "6700",
  PROFESSIONAL_FEES_EXPENSE: "6800",
  INSURANCE_EXPENSE: "6810",
  LICENSES_REGULATORY_EXPENSE: "6820",
  OFFICE_SUPPLIES_EXPENSE: "6830",
  COMMUNICATION_EXPENSE: "6840",
};

const DEFAULT_ACCOUNTS_BY_CODE: Record<string, { name: string; type: "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE" }> = {
  "1000": { name: "Cash", type: "ASSET" },
  "1010": { name: "Bank", type: "ASSET" },
  "1020": { name: "Cash in Transit", type: "ASSET" },
  "1030": { name: "MoMo Clearing", type: "ASSET" },
  "1040": { name: "Payment Gateway Clearing", type: "ASSET" },
  "1100": { name: "Accounts Receivable", type: "ASSET" },
  "1200": { name: "Inventory", type: "ASSET" },
  "2000": { name: "Accounts Payable", type: "LIABILITY" },
  "2100": { name: "VAT Payable", type: "LIABILITY" },
  "2200": { name: "Store Credit", type: "LIABILITY" },
  "2300": { name: "Accrued Expenses", type: "LIABILITY" },
  "2400": { name: "Payroll Payable", type: "LIABILITY" },
  "2500": { name: "Unearned Revenue / Customer Deposits", type: "LIABILITY" },
  "3000": { name: "Owner's Equity", type: "EQUITY" },
  "4000": { name: "Sales Revenue", type: "INCOME" },
  "4010": { name: "Sales Discounts (Contra Revenue)", type: "INCOME" },
  "5000": { name: "Cost of Goods Sold", type: "EXPENSE" },
  "6000": { name: "Operating Expenses", type: "EXPENSE" },
  "6100": { name: "Payroll Expense", type: "EXPENSE" },
  "6200": { name: "Delivery & Logistics Expense", type: "EXPENSE" },
  "6300": { name: "Bank Charges & Fees", type: "EXPENSE" },
  "6400": { name: "Utilities Expense", type: "EXPENSE" },
  "6500": { name: "Rent Expense", type: "EXPENSE" },
  "6600": { name: "Repairs & Maintenance", type: "EXPENSE" },
  "6700": { name: "Marketing Expense", type: "EXPENSE" },
  "6800": { name: "Professional Fees", type: "EXPENSE" },
  "6810": { name: "Insurance Expense", type: "EXPENSE" },
  "6820": { name: "Licenses & Regulatory Fees", type: "EXPENSE" },
  "6830": { name: "Office Supplies Expense", type: "EXPENSE" },
  "6840": { name: "Communication & Internet Expense", type: "EXPENSE" },
};

export async function getAccountCodes() {
  const setting = await prisma.appSetting.findUnique({
    where: { key: "accounting.posting.accounts" },
  });
  const value = setting?.value && typeof setting.value === "object" ? setting.value : null;
  return {
    ...DEFAULT_ACCOUNT_CODES,
    ...(value as Record<string, string> | null),
  };
}

async function resolveAccounts(codes: string[]) {
  const rows = await prisma.ledgerAccount.findMany({
    where: { code: { in: codes } },
  });
  const map = new Map(rows.map((r) => [r.code, r.id]));
  return map;
}

async function ensureEntry(opts: {
  sourceType: SourceType;
  sourceId: string;
  entryDate: Date;
  memo?: string;
  lines: LineInput[];
  allowDuplicateSource?: boolean;
}) {
  const enabled = await isFeatureEnabled("accounting_auto_post", true);
  if (!enabled) {
    await recordAuditLog({
      action: "ACCOUNTING_POST_SKIPPED",
      entityType: opts.sourceType,
      entityId: opts.sourceId,
      meta: { reason: "auto_post_disabled" },
    });
    return null;
  }

  if (!opts.allowDuplicateSource) {
    const existing = await prisma.journalEntry.findFirst({
      where: { sourceType: opts.sourceType, sourceId: opts.sourceId, status: "POSTED" },
      select: { id: true },
    });
    if (existing) return null;
  }

  const closedPeriod = await findClosedPeriod(opts.entryDate);
  if (closedPeriod) {
    console.warn("Accounting post skipped: period closed", {
      sourceType: opts.sourceType,
      sourceId: opts.sourceId,
      periodId: closedPeriod.id,
      periodName: closedPeriod.name,
    });
    await recordAuditLog({
      action: "ACCOUNTING_POST_SKIPPED",
      entityType: opts.sourceType,
      entityId: opts.sourceId,
      meta: {
        reason: "period_closed",
        periodId: closedPeriod.id,
        periodName: closedPeriod.name,
      },
    });
    return null;
  }

  const codes = Array.from(new Set(opts.lines.map((l) => l.accountCode)));
  let accountMap = await resolveAccounts(codes);
  if (accountMap.size !== codes.length) {
    const missingCodes = codes.filter((c) => !accountMap.has(c));
    for (const code of missingCodes) {
      const template = DEFAULT_ACCOUNTS_BY_CODE[code];
      if (!template) continue;
      await prisma.ledgerAccount.upsert({
        where: { code },
        update: { name: template.name, type: template.type, isActive: true },
        create: { code, name: template.name, type: template.type },
      });
    }
    accountMap = await resolveAccounts(codes);
  }
  if (accountMap.size !== codes.length) {
    const missingCodes = codes.filter((c) => !accountMap.has(c));
    console.warn("Accounting post skipped: missing ledger accounts", {
      sourceType: opts.sourceType,
      sourceId: opts.sourceId,
      missing: missingCodes,
    });
    await recordAuditLog({
      action: "ACCOUNTING_POST_SKIPPED",
      entityType: opts.sourceType,
      entityId: opts.sourceId,
      meta: { reason: "missing_accounts", missing: missingCodes },
    });
    return null;
  }

  try {
    return await prisma.journalEntry.create({
      data: {
        entryDate: opts.entryDate,
        memo: opts.memo,
        sourceType: opts.sourceType,
        sourceId: opts.sourceId,
        status: "POSTED",
        lines: {
          create: opts.lines.map((line) => ({
            accountId: accountMap.get(line.accountCode) as string,
            debit: line.debit,
            credit: line.credit,
            description: line.description,
            taxCodeId: line.taxCodeId ?? null,
          })),
        },
      },
    });
  } catch (error) {
    await recordAuditLog({
      action: "ACCOUNTING_POST_FAILED",
      entityType: opts.sourceType,
      entityId: opts.sourceId,
      meta: { reason: "create_failed", message: String(error) },
    });
    throw error;
  }
}

function formatItemSummary(items: Array<{ name?: string | null; sku?: string | null; quantity?: number | null }>) {
  const parts = items
    .map((item) => {
      const name = item.name?.trim() || "Item";
      const sku = item.sku?.trim();
      const qty = Number(item.quantity || 0);
      const label = sku ? `${name} (${sku})` : name;
      return qty > 0 ? `${label} x${qty}` : label;
    })
    .filter(Boolean);
  return parts.join(", ");
}

function clampLine(value: string, maxLength = 200) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}

export async function postExpenseEntry(opts: {
  expenseId: string;
  amount: number;
  createdAt: Date;
  category?: string | null;
  note?: string | null;
  isReversal?: boolean;
}) {
  const ACCOUNT_CODES = await getAccountCodes();
  const amount = Math.abs(Number(opts.amount || 0));
  if (!(amount > 0)) return null;
  const normalizedCategory = String(opts.category || "").trim().toLowerCase();
  const normalizedNote = String(opts.note || "").trim().toLowerCase();
  const categoryText = `${normalizedCategory} ${normalizedNote}`.trim();
  const explicitCodeMatch = String(opts.category || "").trim().match(/^(\d{4})\b/);
  const explicitExpenseCode = explicitCodeMatch?.[1];
  const isDelivery = /(delivery|dispatch|rider|courier|logistics|transport|fuel)/.test(categoryText);
  const isBankFee = /(bank charge|bank fee|transfer fee|momo charge|processing fee|merchant fee)/.test(categoryText);
  const isUtilities = /(utility|utilities|electric|electricity|water|internet|airtime|data)/.test(categoryText);
  const isRent = /(rent|lease)/.test(categoryText);
  const isRepair = /(repair|maintenance|service)/.test(categoryText);
  const isMarketing = /(marketing|advert|promotion|ads|campaign|branding)/.test(categoryText);
  const isBankSettlement = /(settlement:\s*bank|bank transfer|payment mode:\s*bank|paid now.*bank)/.test(
    categoryText,
  );
  const isMomoSettlement = /(settlement:\s*momo|payment mode:\s*momo|paid now.*momo)/.test(categoryText);
  const isProfessionalFees = /(professional|legal|audit|accounting|consulting|advisory)/.test(categoryText);
  const isInsurance = /(insurance|premium|cover)/.test(categoryText);
  const isLicensing = /(license|licence|permit|regulatory|compliance fee)/.test(categoryText);
  const isOfficeSupplies = /(office|stationery|printing|consumable)/.test(categoryText);
  const isCommunication = /(phone|telephone|call|internet|airtime|data|communication)/.test(categoryText);
  const isAccrual = /(accrual|accrued|unpaid|payable)/.test(categoryText);
  const expenseCode = explicitExpenseCode
    ? explicitExpenseCode
    : isDelivery
    ? ACCOUNT_CODES.DELIVERY_EXPENSE || ACCOUNT_CODES.OPERATING_EXPENSE
    : isBankFee
    ? ACCOUNT_CODES.BANK_CHARGES_EXPENSE || ACCOUNT_CODES.OPERATING_EXPENSE
    : isUtilities
    ? ACCOUNT_CODES.UTILITIES_EXPENSE || ACCOUNT_CODES.OPERATING_EXPENSE
    : isRent
    ? ACCOUNT_CODES.RENT_EXPENSE || ACCOUNT_CODES.OPERATING_EXPENSE
    : isRepair
    ? ACCOUNT_CODES.REPAIRS_MAINTENANCE_EXPENSE || ACCOUNT_CODES.OPERATING_EXPENSE
    : isMarketing
    ? ACCOUNT_CODES.MARKETING_EXPENSE || ACCOUNT_CODES.OPERATING_EXPENSE
    : isProfessionalFees
    ? ACCOUNT_CODES.PROFESSIONAL_FEES_EXPENSE || ACCOUNT_CODES.OPERATING_EXPENSE
    : isInsurance
    ? ACCOUNT_CODES.INSURANCE_EXPENSE || ACCOUNT_CODES.OPERATING_EXPENSE
    : isLicensing
    ? ACCOUNT_CODES.LICENSES_REGULATORY_EXPENSE || ACCOUNT_CODES.OPERATING_EXPENSE
    : isOfficeSupplies
    ? ACCOUNT_CODES.OFFICE_SUPPLIES_EXPENSE || ACCOUNT_CODES.OPERATING_EXPENSE
    : isCommunication
    ? ACCOUNT_CODES.COMMUNICATION_EXPENSE || ACCOUNT_CODES.OPERATING_EXPENSE
    : ACCOUNT_CODES.OPERATING_EXPENSE;
  const settlementAccount = isAccrual
    ? ACCOUNT_CODES.ACCRUED_EXPENSES || ACCOUNT_CODES.AP
    : isMomoSettlement
    ? ACCOUNT_CODES.MOMO_CLEARING || ACCOUNT_CODES.CASH
    : isBankSettlement
    ? ACCOUNT_CODES.BANK || ACCOUNT_CODES.CASH
    : ACCOUNT_CODES.CASH;
  const reversal = Boolean(opts.isReversal) || Number(opts.amount) < 0;
  const lines: LineInput[] = reversal
    ? [
        {
          accountCode: settlementAccount,
          debit: amount,
          credit: 0,
          description: opts.note || "Expense reversal",
        },
        {
          accountCode: expenseCode,
          debit: 0,
          credit: amount,
          description: opts.note || "Expense reversal",
        },
      ]
    : [
        {
          accountCode: expenseCode,
          debit: amount,
          credit: 0,
          description: opts.note || "Expense",
        },
        {
          accountCode: settlementAccount,
          debit: 0,
          credit: amount,
          description: opts.note || "Expense",
        },
      ];

  return ensureEntry({
    sourceType: "EXPENSE",
    sourceId: opts.expenseId,
    entryDate: opts.createdAt,
    memo: "Expense",
    lines,
  });
}

export async function postExpenseSettlementEntry(opts: {
  expenseId: string;
  amount: number;
  createdAt: Date;
  settlementKey: string;
  paymentMode: "cash" | "bank" | "momo";
  memo?: string | null;
}) {
  const ACCOUNT_CODES = await getAccountCodes();
  const amount = Math.abs(Number(opts.amount || 0));
  if (!(amount > 0)) return null;
  const settlementAccount =
    opts.paymentMode === "bank"
      ? ACCOUNT_CODES.BANK || ACCOUNT_CODES.CASH
      : opts.paymentMode === "momo"
      ? ACCOUNT_CODES.MOMO_CLEARING || ACCOUNT_CODES.CASH
      : ACCOUNT_CODES.CASH;
  return ensureEntry({
    sourceType: "EXPENSE",
    sourceId: `${opts.expenseId}:settlement:${opts.settlementKey}`,
    entryDate: opts.createdAt,
    memo: opts.memo || "Expense settlement",
    lines: [
      {
        accountCode: ACCOUNT_CODES.ACCRUED_EXPENSES || ACCOUNT_CODES.AP,
        debit: amount,
        credit: 0,
        description: "Expense accrual settlement",
      },
      {
        accountCode: settlementAccount,
        debit: 0,
        credit: amount,
        description: "Expense payment",
      },
    ],
  });
}

export async function postPurchaseEntry(opts: {
  purchaseId: string;
  amount: number;
  createdAt: Date;
  memo?: string | null;
}) {
  const ACCOUNT_CODES = await getAccountCodes();
  const amount = Number(opts.amount || 0);
  if (!(amount > 0)) return null;
  const purchase = await prisma.purchase.findUnique({
    where: { id: opts.purchaseId },
    include: { product: { select: { name: true, sku: true } } },
  });
  const purchaseLabel = purchase?.product
    ? formatItemSummary([
        {
          name: purchase.product.name,
          sku: purchase.product.sku,
          quantity: purchase.quantity,
        },
      ])
    : "";
  const purchaseMemo = purchaseLabel ? `Inventory purchase - ${purchaseLabel}` : "Inventory purchase";
  const purchaseLine = purchaseLabel ? `Inventory purchase - ${purchaseLabel}` : "Inventory purchase";
  return ensureEntry({
    sourceType: "PURCHASE",
    sourceId: opts.purchaseId,
    entryDate: opts.createdAt,
    memo: clampLine(opts.memo || purchaseMemo),
    lines: [
      {
        accountCode: ACCOUNT_CODES.INVENTORY,
        debit: amount,
        credit: 0,
        description: clampLine(purchaseLine),
      },
      {
        accountCode: ACCOUNT_CODES.AP,
        debit: 0,
        credit: amount,
        description: clampLine(purchaseLine),
      },
    ],
  });
}

export async function postPurchaseReceiptEntry(opts: {
  purchaseId: string;
  receiptKey: string;
  amount: number;
  createdAt: Date;
  memo?: string | null;
}) {
  const ACCOUNT_CODES = await getAccountCodes();
  const amount = Number(opts.amount || 0);
  if (!(amount > 0)) return null;
  const purchase = await prisma.purchase.findUnique({
    where: { id: opts.purchaseId },
    include: { product: { select: { name: true, sku: true } } },
  });
  const purchaseLabel = purchase?.product
    ? formatItemSummary([
        {
          name: purchase.product.name,
          sku: purchase.product.sku,
          quantity: purchase.quantity,
        },
      ])
    : "";
  const purchaseMemo = purchaseLabel ? `Inventory purchase - ${purchaseLabel}` : "Inventory purchase";
  const purchaseLine = purchaseLabel ? `Inventory purchase - ${purchaseLabel}` : "Inventory purchase";
  return ensureEntry({
    sourceType: "PURCHASE",
    sourceId: `${opts.purchaseId}:receive:${opts.receiptKey}`,
    entryDate: opts.createdAt,
    memo: clampLine(opts.memo || purchaseMemo),
    lines: [
      {
        accountCode: ACCOUNT_CODES.INVENTORY,
        debit: amount,
        credit: 0,
        description: clampLine(purchaseLine),
      },
      {
        accountCode: ACCOUNT_CODES.AP,
        debit: 0,
        credit: amount,
        description: clampLine(purchaseLine),
      },
    ],
    allowDuplicateSource: false,
  });
}

export async function postSupplierReturnEntry(opts: {
  purchaseId: string;
  amount: number;
  createdAt: Date;
  memo?: string | null;
}) {
  const ACCOUNT_CODES = await getAccountCodes();
  const amount = Number(opts.amount || 0);
  if (!(amount > 0)) return null;
  const purchase = await prisma.purchase.findUnique({
    where: { id: opts.purchaseId },
    include: { product: { select: { name: true, sku: true } } },
  });
  const purchaseLabel = purchase?.product
    ? formatItemSummary([
        {
          name: purchase.product.name,
          sku: purchase.product.sku,
          quantity: purchase.receivedQuantity ?? purchase.quantity,
        },
      ])
    : "";
  const returnMemo = purchaseLabel ? `Supplier return - ${purchaseLabel}` : "Supplier return";
  const returnLine = purchaseLabel ? `Supplier return - ${purchaseLabel}` : "Supplier return";
  return ensureEntry({
    sourceType: "PURCHASE",
    sourceId: opts.purchaseId,
    allowDuplicateSource: true,
    entryDate: opts.createdAt,
    memo: clampLine(opts.memo || returnMemo),
    lines: [
      {
        accountCode: ACCOUNT_CODES.AP,
        debit: amount,
        credit: 0,
        description: clampLine(returnLine),
      },
      {
        accountCode: ACCOUNT_CODES.INVENTORY,
        debit: 0,
        credit: amount,
        description: clampLine(returnLine),
      },
    ],
  });
}

export async function postSupplierRefundEntry(opts: {
  supplierPaymentId: string;
}) {
  const ACCOUNT_CODES = await getAccountCodes();
  const payment = await prisma.supplierPayment.findUnique({
    where: { id: opts.supplierPaymentId },
    include: {
      purchase: {
        select: {
          id: true,
          product: { select: { name: true, sku: true } },
        },
      },
      supplier: { select: { name: true } },
    },
  });
  if (!payment) return null;
  if (Number(payment.amount || 0) <= 0) return null;
  if (payment.status !== "NORMAL") return null;
  const method = (payment.method || "").toLowerCase();
  if (method !== "refund") return null;

  const cashAccount = ACCOUNT_CODES.CASH;
  const paymentLabel = payment.purchase?.product
    ? formatItemSummary([
        {
          name: payment.purchase.product.name,
          sku: payment.purchase.product.sku,
          quantity: 1,
        },
      ])
    : payment.supplier?.name || "Supplier refund";
  const memo = paymentLabel
    ? `Supplier refund - ${paymentLabel}`
    : "Supplier refund";

  return ensureEntry({
    sourceType: "PURCHASE",
    sourceId: payment.id,
    allowDuplicateSource: true,
    entryDate: payment.paidAt || payment.createdAt,
    memo: clampLine(memo, 500),
    lines: [
      {
        accountCode: cashAccount,
        debit: Number(payment.amount),
        credit: 0,
        description: clampLine("Supplier refund"),
      },
      {
        accountCode: ACCOUNT_CODES.AP,
        debit: 0,
        credit: Number(payment.amount),
        description: clampLine("AP credit reversal"),
      },
    ],
  });
}

export async function postSupplierPaymentEntry(opts: {
  supplierPaymentId: string;
}) {
  const ACCOUNT_CODES = await getAccountCodes();
  const payment = await prisma.supplierPayment.findUnique({
    where: { id: opts.supplierPaymentId },
    include: {
      purchase: {
        select: {
          id: true,
          product: { select: { name: true, sku: true } },
        },
      },
      supplier: { select: { name: true } },
    },
  });
  if (!payment) return null;
  if (Number(payment.amount || 0) <= 0) return null;
  if (payment.status !== "NORMAL") return null;
  const method = (payment.method || "").toLowerCase();
  if (method === "credit_memo" || payment.reference === "SUPPLIER_RETURN") {
    return null;
  }

  const cashAccount =
    method === "transfer" || method === "bank" ? ACCOUNT_CODES.BANK : ACCOUNT_CODES.CASH;
  const paymentLabel = payment.purchase?.product
    ? formatItemSummary([
        {
          name: payment.purchase.product.name,
          sku: payment.purchase.product.sku,
          quantity: 1,
        },
      ])
    : payment.supplier?.name || "Supplier payment";
  const memo = paymentLabel
    ? `Supplier payment - ${paymentLabel}`
    : "Supplier payment";

  return ensureEntry({
    sourceType: "PURCHASE",
    sourceId: payment.id,
    entryDate: payment.paidAt || payment.createdAt,
    memo: clampLine(memo, 500),
    lines: [
      {
        accountCode: ACCOUNT_CODES.AP,
        debit: Number(payment.amount),
        credit: 0,
        description: clampLine("Accounts payable settlement"),
      },
      {
        accountCode: cashAccount,
        debit: 0,
        credit: Number(payment.amount),
        description: clampLine("Supplier payment"),
      },
    ],
  });
}

export async function postOrderEntry(opts: {
  orderId: string;
}) {
  const ACCOUNT_CODES = await getAccountCodes();
  const order = await prisma.order.findUnique({
    where: { id: opts.orderId },
    include: {
      items: {
        include: {
          product: { select: { name: true, sku: true, cost: true } },
        },
      },
    },
  });
  if (!order) return null;

  const subtotal = Number(order.subtotal ?? order.total ?? 0);
  const taxAmount = Number(order.taxAmount ?? 0);
  const taxRate = Number(order.taxRate ?? 0);
  const total = Number(order.total ?? subtotal + taxAmount);
  const netRevenue = Math.max(0, total - taxAmount);
  const discountAmount = Math.max(0, subtotal - netRevenue);
  // Prefer historical cost-at-sale for COGS to align with industry-standard accrual reporting.
  const cogsTotal = (order.items || []).reduce((sum, item) => {
    const unitCost =
      item.costAtSale != null
        ? Number(item.costAtSale)
        : Number(item.product?.cost ?? 0);
    return sum + unitCost * Number(item.quantity || 0);
  }, 0);
  const itemSummary = formatItemSummary(
    (order.items || []).map((item) => ({
      name: item.product?.name,
      sku: item.product?.sku,
      quantity: item.quantity,
    })),
  );
  const orderMemo = itemSummary ? `Sales order - ${itemSummary}` : "Sales order";
  const invoiceLabel = itemSummary ? `Sales invoice - ${itemSummary}` : "Sales invoice";
  const revenueLabel = itemSummary
    ? `Sales revenue - ${itemSummary}`
    : "Sales revenue";
  const discountLabel = itemSummary
    ? `Sales discount - ${itemSummary}`
    : "Sales discount";
  const cogsLabel = itemSummary ? `Cost of goods sold - ${itemSummary}` : "Cost of goods sold";
  const inventoryLabel = itemSummary ? `Inventory reduction - ${itemSummary}` : "Inventory reduction";

  let outputTaxCodeId: string | null = null;
  if (taxAmount > 0 && taxRate > 0) {
    const outputCode = await prisma.taxCode.findFirst({
      where: {
        type: "OUTPUT",
        rate: taxRate,
        isActive: true,
      },
    });
    outputTaxCodeId = outputCode?.id ?? null;
  }

  const lines: LineInput[] = [
    {
      accountCode: ACCOUNT_CODES.AR,
      debit: total,
      credit: 0,
      description: clampLine(invoiceLabel),
    },
    {
      accountCode: ACCOUNT_CODES.SALES,
      debit: 0,
      credit: subtotal,
      description: clampLine(revenueLabel),
      taxCodeId: outputTaxCodeId,
    },
  ];
  if (discountAmount > 0) {
    lines.push({
      accountCode: ACCOUNT_CODES.SALES_DISCOUNTS || "4010",
      debit: discountAmount,
      credit: 0,
      description: clampLine(discountLabel),
    });
  }
  if (taxAmount > 0) {
    lines.push({
      accountCode: ACCOUNT_CODES.VAT_PAYABLE,
      debit: 0,
      credit: taxAmount,
      description: "VAT output",
    });
  }
  if (cogsTotal > 0) {
    lines.push(
      {
        accountCode: ACCOUNT_CODES.COGS,
        debit: cogsTotal,
        credit: 0,
        description: clampLine(cogsLabel),
      },
      {
        accountCode: ACCOUNT_CODES.INVENTORY,
        debit: 0,
        credit: cogsTotal,
        description: clampLine(inventoryLabel),
      },
    );
  }

  return ensureEntry({
    sourceType: "ORDER",
    sourceId: order.id,
    entryDate: order.createdAt,
    memo: clampLine(orderMemo, 500),
    lines,
  });
}

export async function postPaymentEntry(opts: {
  paymentId: string;
}) {
  const ACCOUNT_CODES = await getAccountCodes();
  const payment = await prisma.payment.findUnique({
    where: { id: opts.paymentId },
    include: {
      order: {
        select: {
          invoiceNumber: true,
          receiptHash: true,
        },
      },
    },
  });
  if (!payment) return null;
  if (Number(payment.amount || 0) <= 0) return null;
  if (payment.status === "REFUND" || payment.status === "VOID") return null;
  let meta: { reference?: string; method?: string; status?: string; applied?: unknown[] } | null = null;
  if (payment.note) {
    try {
      meta = JSON.parse(payment.note) as { reference?: string; method?: string };
    } catch {
      meta = null;
    }
  }
  if (meta?.reference === "LATE_MOMO_SUCCESS_AFTER_CANCEL") {
    const amount = Number(payment.amount || 0);
    if (!(amount > 0)) return null;
    return ensureEntry({
      sourceType: "PAYMENT",
      sourceId: payment.id,
      entryDate: payment.createdAt,
      memo: "Late MoMo success converted to store credit",
      lines: [
        {
          accountCode: ACCOUNT_CODES.BANK,
          debit: amount,
          credit: 0,
          description: "Late MoMo receipt",
        },
        {
          accountCode: ACCOUNT_CODES.STORE_CREDIT,
          debit: 0,
          credit: amount,
          description: "Store credit liability created",
        },
      ],
    });
  }
  if (payment.refundDisposition === "CREDIT") return null;
  if (meta?.reference === "AUTO_APPLY") {
    return ensureEntry({
      sourceType: "PAYMENT",
      sourceId: payment.id,
      entryDate: payment.createdAt,
      memo: "Store credit applied",
      lines: [
        {
          accountCode: ACCOUNT_CODES.STORE_CREDIT,
          debit: Number(payment.amount),
          credit: 0,
          description: "Store credit applied",
        },
        {
          accountCode: ACCOUNT_CODES.AR,
          debit: 0,
          credit: Number(payment.amount),
          description: "Accounts receivable settlement",
        },
      ],
    });
  }
  const method = String(meta?.method || "").toLowerCase();
  const momoLike = method === "momo";
  const gatewayLike = method === "gateway" || method === "card" || method === "pos";
  const paymentInvoiceLabel = payment.order?.invoiceNumber?.trim();
  const referenceLabel = paymentInvoiceLabel || payment.orderId || payment.id;
  const localStatus = String(meta?.status || "").toLowerCase();
  const isPending = localStatus.startsWith("pending");
  const isCanceledOrFailed =
    localStatus === "cancelled_by_staff" || localStatus === "failed";
  const isSuccess = localStatus === "success";
  const hasAppliedArray = Array.isArray(meta?.applied) && (meta?.applied?.length || 0) > 0;

  if (momoLike || gatewayLike) {
    const clearingAccount = momoLike
      ? ACCOUNT_CODES.MOMO_CLEARING || ACCOUNT_CODES.BANK
      : ACCOUNT_CODES.GATEWAY_CLEARING || ACCOUNT_CODES.BANK;
    const pendingSourceId = `${payment.id}:PENDING_CLEARING`;
    const reversalSourceId = `${payment.id}:PENDING_CLEARING_REVERSAL`;
    const settledSourceId = `${payment.id}:PENDING_CLEARING_SETTLED`;
    const creditAccount = payment.orderId || hasAppliedArray ? ACCOUNT_CODES.AR : ACCOUNT_CODES.CUSTOMER_DEPOSITS;
    const pendingExists = await prisma.journalEntry.findFirst({
      where: { sourceType: "PAYMENT", sourceId: pendingSourceId, status: "POSTED" },
      select: { id: true },
    });

    if (isPending && !pendingExists) {
      return ensureEntry({
        sourceType: "PAYMENT",
        sourceId: pendingSourceId,
        entryDate: payment.createdAt,
        memo: momoLike
          ? `MoMo request pending (clearing) - ${referenceLabel}`
          : `Gateway payment pending (clearing) - ${referenceLabel}`,
        lines: [
          {
            accountCode: clearingAccount,
            debit: Number(payment.amount),
            credit: 0,
            description: paymentInvoiceLabel
              ? `Pending payment in clearing - ${paymentInvoiceLabel}`
              : "Pending payment in clearing",
          },
          {
            accountCode: creditAccount,
            debit: 0,
            credit: Number(payment.amount),
            description:
              creditAccount === ACCOUNT_CODES.AR
                ? "Accounts receivable recognized"
                : "Customer deposit liability recognized",
          },
        ],
      });
    }

    if (isCanceledOrFailed && pendingExists) {
      return ensureEntry({
        sourceType: "PAYMENT",
        sourceId: reversalSourceId,
        entryDate: payment.createdAt,
        memo: momoLike
          ? `MoMo pending request reversed - ${referenceLabel}`
          : `Gateway pending request reversed - ${referenceLabel}`,
        lines: [
          {
            accountCode: creditAccount,
            debit: Number(payment.amount),
            credit: 0,
            description:
              creditAccount === ACCOUNT_CODES.AR
                ? "Accounts receivable reinstated"
                : "Customer deposit liability reversed",
          },
          {
            accountCode: clearingAccount,
            debit: 0,
            credit: Number(payment.amount),
            description: "Pending clearing reversed",
          },
        ],
      });
    }

    if (isSuccess && pendingExists) {
      return ensureEntry({
        sourceType: "PAYMENT",
        sourceId: settledSourceId,
        entryDate: payment.createdAt,
        memo: momoLike
          ? `MoMo clearing settled to bank - ${referenceLabel}`
          : `Gateway clearing settled to bank - ${referenceLabel}`,
        lines: [
          {
            accountCode: ACCOUNT_CODES.BANK,
            debit: Number(payment.amount),
            credit: 0,
            description: paymentInvoiceLabel
              ? `Provider settlement received in bank - ${paymentInvoiceLabel}`
              : "Provider settlement received in bank",
          },
          {
            accountCode: clearingAccount,
            debit: 0,
            credit: Number(payment.amount),
            description: "Clearing settled",
          },
        ],
      });
    }
    if (
      isPending ||
      isCanceledOrFailed ||
      localStatus === "late_success_after_cancel" ||
      localStatus === "pending_forced_test"
    ) {
      return null;
    }
  }

  const creditAccount = payment.orderId || hasAppliedArray ? ACCOUNT_CODES.AR : ACCOUNT_CODES.CUSTOMER_DEPOSITS;
  const settlementAccount =
    method === "transfer" || method === "bank" || method === "momo"
      ? ACCOUNT_CODES.BANK
      : ACCOUNT_CODES.CASH;

  const invoiceLabel = payment.order?.invoiceNumber?.trim();
  const paymentMemo = invoiceLabel
    ? `Customer payment - ${invoiceLabel}`
    : "Customer payment";

  return ensureEntry({
    sourceType: "PAYMENT",
    sourceId: payment.id,
    entryDate: payment.createdAt,
    memo: paymentMemo,
    lines: [
      {
        accountCode: settlementAccount,
        debit: Number(payment.amount),
        credit: 0,
        description: invoiceLabel ? `Payment received - ${invoiceLabel}` : "Payment received",
      },
      {
        accountCode: creditAccount,
        debit: 0,
        credit: Number(payment.amount),
        description:
          creditAccount === ACCOUNT_CODES.AR
            ? invoiceLabel
              ? `Accounts receivable - ${invoiceLabel}`
              : "Accounts receivable"
            : "Customer deposit liability",
      },
    ],
  });
}

export async function postPayrollAccrualEntry(opts: {
  payrollRunId: string;
}) {
  const ACCOUNT_CODES = await getAccountCodes();
  const run = await prisma.payrollRun.findUnique({ where: { id: opts.payrollRunId } });
  if (!run) return null;
  const gross = Number(run.totalGross || 0);
  if (!(gross > 0)) return null;
  const runLabel =
    run.runType === "ADJUSTMENT"
      ? `Payroll adjustment ${run.periodStart.toISOString()} - ${run.periodEnd.toISOString()}`
      : `Payroll accrual ${run.periodStart.toISOString()} - ${run.periodEnd.toISOString()}`;
  return ensureEntry({
    sourceType: "PAYROLL",
    sourceId: run.id,
    entryDate: run.finalizedAt || run.updatedAt || run.createdAt,
    memo: clampLine(runLabel, 500),
    lines: [
      {
        accountCode: ACCOUNT_CODES.PAYROLL_EXPENSE,
        debit: gross,
        credit: 0,
        description: "Payroll expense recognized",
      },
      {
        accountCode: ACCOUNT_CODES.PAYROLL_PAYABLE,
        debit: 0,
        credit: gross,
        description: "Payroll liability recognized",
      },
    ],
  });
}

export async function postPayrollSettlementEntry(opts: {
  payrollRunId: string;
}) {
  const ACCOUNT_CODES = await getAccountCodes();
  const run = await prisma.payrollRun.findUnique({ where: { id: opts.payrollRunId } });
  if (!run) return null;
  const gross = Number(run.totalGross || 0);
  const net = Number(run.totalNet || 0);
  if (!(gross > 0) || !(net > 0)) return null;
  const accruedPortion = Math.max(0, Number((gross - net).toFixed(2)));
  const lines: LineInput[] = [
    {
      accountCode: ACCOUNT_CODES.PAYROLL_PAYABLE,
      debit: gross,
      credit: 0,
      description: "Payroll liability cleared",
    },
    {
      accountCode: ACCOUNT_CODES.BANK,
      debit: 0,
      credit: net,
      description: "Payroll paid from bank",
    },
  ];
  if (accruedPortion > 0) {
    lines.push({
      accountCode: ACCOUNT_CODES.ACCRUED_EXPENSES,
      debit: 0,
      credit: accruedPortion,
      description: "Payroll deductions accrued",
    });
  }

  return ensureEntry({
    sourceType: "PAYROLL",
    sourceId: `${run.id}:PAID`,
    entryDate: run.updatedAt || run.createdAt,
    memo: clampLine(
      `Payroll settlement ${run.periodStart.toISOString()} - ${run.periodEnd.toISOString()}`,
      500,
    ),
    lines,
  });
}

export async function postStoreCreditPayoutEntry(opts: {
  paymentId: string;
}) {
  const ACCOUNT_CODES = await getAccountCodes();
  const payment = await prisma.payment.findUnique({
    where: { id: opts.paymentId },
    select: { id: true, amount: true, status: true, refundDisposition: true, note: true, createdAt: true },
  });
  if (!payment) return null;
  if (String(payment.status || "").toUpperCase() !== "REFUND") return null;
  if (String(payment.refundDisposition || "").toUpperCase() !== "CASH") return null;

  let meta: { location?: string; method?: string } | null = null;
  if (payment.note) {
    try {
      meta = JSON.parse(payment.note) as { location?: string; method?: string };
    } catch {
      meta = null;
    }
  }
  if (meta?.location !== "admin/customers:credit-payout") return null;

  const amount = Math.abs(Number(payment.amount || 0));
  if (!(amount > 0)) return null;
  const cashAccount =
    meta?.method === "transfer" ? ACCOUNT_CODES.BANK : ACCOUNT_CODES.CASH;

  return ensureEntry({
    sourceType: "PAYMENT",
    sourceId: payment.id,
    entryDate: payment.createdAt,
    memo: "Store credit payout",
    lines: [
      {
        accountCode: ACCOUNT_CODES.STORE_CREDIT,
        debit: amount,
        credit: 0,
        description: "Store credit payout",
      },
      {
        accountCode: cashAccount,
        debit: 0,
        credit: amount,
        description: "Cash payout",
      },
    ],
  });
}

export async function postReturnEntry(opts: {
  sourceType: SourceType;
  sourceId: string;
  entryDate: Date;
  orderId: string;
  itemLabel: string;
  refundAmount: number;
  appliedToBalance: number;
  refundMode: "cash" | "credit";
  restock: boolean;
  cogsAmount: number;
}) {
  const ACCOUNT_CODES = await getAccountCodes();
  const refundAmount = Math.abs(Number(opts.refundAmount || 0));
  if (!(refundAmount > 0)) return null;

  const appliedToBalance = Math.max(0, Number(opts.appliedToBalance || 0));
  const remainder = Math.max(0, refundAmount - appliedToBalance);
  const arCredit = appliedToBalance;
  const cashCredit = opts.refundMode === "cash" ? remainder : 0;
  const storeCredit = opts.refundMode === "credit" ? remainder : 0;

  const label = opts.itemLabel.trim() || "Return";
  const memo = clampLine(`Return/refund - ${label} (${opts.orderId})`, 500);
  const lines: LineInput[] = [
    {
      accountCode: ACCOUNT_CODES.SALES,
      debit: refundAmount,
      credit: 0,
      description: clampLine(`Sales return - ${label}`),
    },
  ];

  if (arCredit > 0) {
    lines.push({
      accountCode: ACCOUNT_CODES.AR,
      debit: 0,
      credit: arCredit,
      description: clampLine(`Accounts receivable - ${label}`),
    });
  }
  if (cashCredit > 0) {
    lines.push({
      accountCode: ACCOUNT_CODES.CASH,
      debit: 0,
      credit: cashCredit,
      description: clampLine(`Cash refund - ${label}`),
    });
  }
  if (storeCredit > 0) {
    lines.push({
      accountCode: ACCOUNT_CODES.STORE_CREDIT,
      debit: 0,
      credit: storeCredit,
      description: clampLine(`Store credit issued - ${label}`),
    });
  }

  const cogsAmount = Math.max(0, Number(opts.cogsAmount || 0));
  if (opts.restock && cogsAmount > 0) {
    lines.push(
      {
        accountCode: ACCOUNT_CODES.INVENTORY,
        debit: cogsAmount,
        credit: 0,
        description: clampLine(`Inventory return - ${label}`),
      },
      {
        accountCode: ACCOUNT_CODES.COGS,
        debit: 0,
        credit: cogsAmount,
        description: clampLine(`COGS reversal - ${label}`),
      },
    );
  }

  return ensureEntry({
    sourceType: opts.sourceType,
    sourceId: opts.sourceId,
    entryDate: opts.entryDate,
    memo,
    lines,
    allowDuplicateSource: opts.sourceType === "ORDER",
  });
}

export async function postDeliverySettlementEntry(opts: {
  settlementId: string;
  amount: number;
  settledAt: Date;
  receivedBy?: string | null;
  reference?: string | null;
  note?: string | null;
  destination?: "CASH" | "BANK";
}) {
  const ACCOUNT_CODES = await getAccountCodes();
  const amount = Number(opts.amount || 0);
  if (!(amount > 0)) return null;

  const destinationCode =
    opts.destination === "BANK" ? ACCOUNT_CODES.BANK : ACCOUNT_CODES.CASH;
  const memoBase = `Delivery settlement ${opts.settlementId}`;
  const memoMeta = [
    opts.receivedBy ? `received by ${opts.receivedBy}` : "",
    opts.reference ? `ref ${opts.reference}` : "",
  ]
    .filter(Boolean)
    .join(" • ");
  const memo = clampLine(memoMeta ? `${memoBase} (${memoMeta})` : memoBase, 500);
  const lineLabel = clampLine(`Delivery settlement ${opts.settlementId}`, 200);

  return ensureEntry({
    sourceType: "MANUAL",
    sourceId: opts.settlementId,
    entryDate: opts.settledAt,
    memo,
    lines: [
      {
        accountCode: destinationCode,
        debit: amount,
        credit: 0,
        description: lineLabel,
      },
      {
        accountCode: ACCOUNT_CODES.CASH_IN_TRANSIT,
        debit: 0,
        credit: amount,
        description: lineLabel,
      },
    ],
  });
}
