import { prisma } from "@/lib/prisma";

const accounts = [
  { code: "1000", name: "Cash", type: "ASSET" },
  { code: "1010", name: "Bank", type: "ASSET" },
  { code: "1020", name: "Cash in Transit", type: "ASSET" },
  { code: "1030", name: "MoMo Clearing", type: "ASSET" },
  { code: "1040", name: "Payment Gateway Clearing", type: "ASSET" },
  { code: "1100", name: "Accounts Receivable", type: "ASSET" },
  { code: "1200", name: "Inventory", type: "ASSET" },
  { code: "2000", name: "Accounts Payable", type: "LIABILITY" },
  { code: "2100", name: "VAT Payable", type: "LIABILITY" },
  { code: "2200", name: "Store Credit", type: "LIABILITY" },
  { code: "2300", name: "Accrued Expenses", type: "LIABILITY" },
  { code: "2400", name: "Payroll Payable", type: "LIABILITY" },
  { code: "2500", name: "Unearned Revenue / Customer Deposits", type: "LIABILITY" },
  { code: "3000", name: "Owner's Equity", type: "EQUITY" },
  { code: "4000", name: "Sales Revenue", type: "INCOME" },
  { code: "5000", name: "Cost of Goods Sold", type: "EXPENSE" },
  { code: "6000", name: "Operating Expenses", type: "EXPENSE" },
  { code: "6100", name: "Payroll Expense", type: "EXPENSE" },
  { code: "6200", name: "Delivery & Logistics Expense", type: "EXPENSE" },
  { code: "6300", name: "Bank Charges & Fees", type: "EXPENSE" },
  { code: "6400", name: "Utilities Expense", type: "EXPENSE" },
  { code: "6500", name: "Rent Expense", type: "EXPENSE" },
  { code: "6600", name: "Repairs & Maintenance", type: "EXPENSE" },
  { code: "6700", name: "Marketing Expense", type: "EXPENSE" },
  { code: "6990", name: "Cash Over/Short", type: "EXPENSE" },
] as const;

const taxCodes = [
  { name: "VAT 15% Output", rate: 15, type: "OUTPUT" },
  { name: "VAT 15% Input", rate: 15, type: "INPUT" },
  { name: "VAT 0% Zero", rate: 0, type: "ZERO" },
] as const;

const startOfMonth = (date: Date) => new Date(date.getFullYear(), date.getMonth(), 1);
const endOfMonth = (date: Date) => new Date(date.getFullYear(), date.getMonth() + 1, 0);

async function main() {
  for (const account of accounts) {
    await prisma.ledgerAccount.upsert({
      where: { code: account.code },
      update: {
        name: account.name,
        type: account.type,
        isActive: true,
      },
      create: {
        code: account.code,
        name: account.name,
        type: account.type,
      },
    });
  }

  const ledgerAccounts = await prisma.ledgerAccount.findMany({
    where: { code: { in: accounts.map((account) => account.code) } },
  });
  const accountByCode = new Map(ledgerAccounts.map((acc) => [acc.code, acc]));

  for (const code of taxCodes) {
    await prisma.taxCode.upsert({
      where: { name: code.name },
      update: {
        rate: code.rate,
        type: code.type,
        isActive: true,
      },
      create: {
        name: code.name,
        rate: code.rate,
        type: code.type,
      },
    });
  }

  const taxCodeByName = new Map(
    (await prisma.taxCode.findMany({ where: { name: { in: taxCodes.map((t) => t.name) } } }))
      .map((code) => [code.name, code]),
  );

  const existingPeriods = await prisma.fiscalPeriod.count();
  if (existingPeriods === 0) {
    const now = new Date();
    const currentStart = startOfMonth(now);
    const currentEnd = endOfMonth(now);
    const previous = new Date(currentStart);
    previous.setMonth(previous.getMonth() - 1);
    const previousStart = startOfMonth(previous);
    const previousEnd = endOfMonth(previous);

    await prisma.fiscalPeriod.createMany({
      data: [
        {
          name: `${previousStart.toLocaleString("default", { month: "long" })} ${previousStart.getFullYear()}`,
          startDate: previousStart,
          endDate: previousEnd,
          status: "CLOSED",
        },
        {
          name: `${currentStart.toLocaleString("default", { month: "long" })} ${currentStart.getFullYear()}`,
          startDate: currentStart,
          endDate: currentEnd,
          status: "OPEN",
        },
      ],
    });
  }

  let bank = await prisma.bankAccount.findFirst({
    where: { name: "Primary Operating Account" },
  });
  if (!bank) {
    bank = await prisma.bankAccount.create({
      data: {
        name: "Primary Operating Account",
        bankName: "GCB Bank",
        accountNumberMasked: "****4312",
        currency: "GHS",
        isActive: true,
      },
    });
  } else if (!bank.isActive) {
    bank = await prisma.bankAccount.update({
      where: { id: bank.id },
      data: { isActive: true },
    });
  }

  const matchRules = await prisma.bankMatchRule.count({ where: { bankAccountId: bank.id } });
  if (matchRules === 0) {
    await prisma.bankMatchRule.createMany({
      data: [
        {
          bankAccountId: bank.id,
          name: "MoMo receipts",
          matchText: "MOMO",
          matchMode: "CONTAINS",
          accountId: accountByCode.get("1010")?.id || null,
          minAmount: 50,
          amountTolerance: 0,
          priority: 10,
          isActive: true,
        },
        {
          bankAccountId: bank.id,
          name: "Office supplies",
          matchText: "SUPPLIES",
          matchMode: "CONTAINS",
          accountId: accountByCode.get("6000")?.id || null,
          maxAmount: 500,
          amountTolerance: 0,
          priority: 5,
          isActive: true,
        },
      ],
    });
  }

  const existingEntries = await prisma.journalEntry.count();
  if (existingEntries === 0) {
    const now = new Date();
    const ar = accountByCode.get("1100")?.id;
    const bankAccount = accountByCode.get("1010")?.id;
    const revenue = accountByCode.get("4000")?.id;
    const vatPayable = accountByCode.get("2100")?.id;
    const inventory = accountByCode.get("1200")?.id;
    const cogs = accountByCode.get("5000")?.id;
    const operating = accountByCode.get("6000")?.id;
    const cash = accountByCode.get("1000")?.id;
    const ap = accountByCode.get("2000")?.id;
    const vatOutput = taxCodeByName.get("VAT 15% Output")?.id || null;
    const vatInput = taxCodeByName.get("VAT 15% Input")?.id || null;

    if (ar && bankAccount && revenue && vatPayable && inventory && cogs && operating && cash && ap) {
      await prisma.journalEntry.create({
        data: {
          entryDate: new Date(now.getFullYear(), now.getMonth(), 3),
          memo: "Invoice #INV-1001",
          sourceType: "MANUAL",
          status: "POSTED",
          lines: {
            create: [
              { accountId: ar, debit: 1380, credit: 0, description: "Customer invoice" },
              {
                accountId: revenue,
                debit: 0,
                credit: 1200,
                description: "Sales revenue",
                taxCodeId: vatOutput,
              },
              {
                accountId: vatPayable,
                debit: 0,
                credit: 180,
                description: "VAT output",
              },
            ],
          },
        },
      });

      await prisma.journalEntry.create({
        data: {
          entryDate: new Date(now.getFullYear(), now.getMonth(), 3),
          memo: "COGS for INV-1001",
          sourceType: "MANUAL",
          status: "POSTED",
          lines: {
            create: [
              { accountId: cogs, debit: 700, credit: 0, description: "Cost of goods sold" },
              { accountId: inventory, debit: 0, credit: 700, description: "Inventory reduction" },
            ],
          },
        },
      });

      await prisma.journalEntry.create({
        data: {
          entryDate: new Date(now.getFullYear(), now.getMonth(), 5),
          memo: "MoMo payment for INV-1001",
          sourceType: "PAYMENT",
          status: "POSTED",
          lines: {
            create: [
              { accountId: bankAccount, debit: 1380, credit: 0, description: "Bank deposit" },
              { accountId: ar, debit: 0, credit: 1380, description: "A/R settlement" },
            ],
          },
        },
      });

      await prisma.journalEntry.create({
        data: {
          entryDate: new Date(now.getFullYear(), now.getMonth(), 8),
          memo: "Inventory restock",
          sourceType: "PURCHASE",
          status: "POSTED",
          lines: {
            create: [
              {
                accountId: inventory,
                debit: 800,
                credit: 0,
                description: "Stock purchase",
                taxCodeId: vatInput,
              },
              { accountId: vatPayable, debit: 120, credit: 0, description: "VAT input" },
              { accountId: ap, debit: 0, credit: 920, description: "Supplier payable" },
            ],
          },
        },
      });

      await prisma.journalEntry.create({
        data: {
          entryDate: new Date(now.getFullYear(), now.getMonth(), 12),
          memo: "Office supplies",
          sourceType: "EXPENSE",
          status: "POSTED",
          lines: {
            create: [
              { accountId: operating, debit: 250, credit: 0, description: "Supplies" },
              { accountId: cash, debit: 0, credit: 250, description: "Cash payment" },
            ],
          },
        },
      });

      await prisma.journalEntry.create({
        data: {
          entryDate: new Date(now.getFullYear(), now.getMonth(), 15),
          memo: "Accrual adjustment draft",
          sourceType: "MANUAL",
          status: "DRAFT",
          lines: {
            create: [
              { accountId: operating, debit: 95, credit: 0, description: "Accrued expense" },
              { accountId: ap, debit: 0, credit: 95, description: "Accrual liability" },
            ],
          },
        },
      });
    }
  }

  const existingProducts = await prisma.product.count({ where: { deletedAt: null } });
  const existingMovements = await prisma.inventoryMovement.count({ where: { deletedAt: null } });
  if (existingProducts === 0 && existingMovements === 0) {
    const now = new Date();
    const seedProducts = [
      {
        sku: "ACA-001",
        name: "Acapella",
        description: "Respiratory therapy device",
        category: "Respiratory",
        brand: "Acme",
        supplier: "MedSupply Wholesale",
        price: 75,
        cost: 50,
        purchaseQty: 5,
        saleQty: 4,
        returnQty: 1,
        adjustmentDelta: -1,
      },
      {
        sku: "HOS-001",
        name: "Hospital Gown",
        description: "Reusable patient gown",
        category: "Apparel",
        brand: "CareWear",
        supplier: "MedSupply Wholesale",
        price: 35,
        cost: 25,
        purchaseQty: 8,
        saleQty: 7,
        returnQty: 0,
        adjustmentDelta: 0,
      },
      {
        sku: "N95-001",
        name: "N95 Mask",
        description: "Protective respirator mask",
        category: "PPE",
        brand: "SafeAir",
        supplier: "MedSupply Wholesale",
        price: 40,
        cost: 25,
        purchaseQty: 10,
        saleQty: 9,
        returnQty: 1,
        adjustmentDelta: -1,
      },
      {
        sku: "WHE-001",
        name: "Wheelchair",
        description: "Lightweight transport wheelchair",
        category: "Mobility",
        brand: "MoveWell",
        supplier: "MedEquip Co.",
        price: 750,
        cost: 200,
        purchaseQty: 2,
        saleQty: 2,
        returnQty: 0,
        adjustmentDelta: 0,
      },
      {
        sku: "DAR-001",
        name: "Darkin's Solution",
        description: "Disinfectant solution",
        category: "Sanitation",
        brand: "CleanPro",
        supplier: "MedSupply Wholesale",
        price: 65,
        cost: 40,
        purchaseQty: 3,
        saleQty: 3,
        returnQty: 0,
        adjustmentDelta: 0,
      },
    ];

    for (const [index, item] of seedProducts.entries()) {
      const product = await prisma.product.create({
        data: {
          sku: item.sku,
          name: item.name,
          description: item.description,
          imageUrl: "https://placehold.co/600x600/png",
          category: item.category,
          brand: item.brand,
          supplier: item.supplier,
          price: item.price,
          cost: item.cost,
          stock: item.purchaseQty - item.saleQty + item.returnQty + item.adjustmentDelta,
        },
      });

      const purchaseDate = new Date(now.getFullYear(), now.getMonth(), 8 + index);
      const saleDate = new Date(now.getFullYear(), now.getMonth(), 9 + index);
      const returnDate = new Date(now.getFullYear(), now.getMonth(), 10 + index);
      const adjustmentDate = new Date(now.getFullYear(), now.getMonth(), 11 + index);

      const purchase = await prisma.purchase.create({
        data: {
          productId: product.id,
          quantity: item.purchaseQty,
          unitCost: item.cost,
          supplier: item.supplier,
          reason: "Initial Stock",
          note: "Seeded opening stock",
          createdAt: purchaseDate,
        },
      });

      await prisma.inventoryMovement.create({
        data: {
          productId: product.id,
          delta: item.purchaseQty,
          reason: "PURCHASE",
          purchaseId: purchase.id,
          createdAt: purchaseDate,
        },
      });

      await prisma.inventoryMovement.create({
        data: {
          productId: product.id,
          delta: -item.saleQty,
          reason: "SALE",
          createdAt: saleDate,
        },
      });

      if (item.returnQty > 0) {
        await prisma.inventoryMovement.create({
          data: {
            productId: product.id,
            delta: item.returnQty,
            reason: "RETURN",
            createdAt: returnDate,
          },
        });
      }

      if (item.adjustmentDelta !== 0) {
        await prisma.inventoryMovement.create({
          data: {
            productId: product.id,
            delta: item.adjustmentDelta,
            reason: "ADJUSTMENT",
            createdAt: adjustmentDate,
          },
        });
      }
    }
  }

  const existingTxns = await prisma.bankTransaction.count({ where: { bankAccountId: bank.id } });
  if (existingTxns === 0) {
    const now = new Date();
    await prisma.bankTransaction.createMany({
      data: [
        {
          bankAccountId: bank.id,
          postedAt: new Date(now.getFullYear(), now.getMonth(), 5),
          amount: 1380,
          description: "MOMO PAYMENT INV-1001",
          reference: "MOMO-INV-1001",
          type: "CREDIT",
        },
        {
          bankAccountId: bank.id,
          postedAt: new Date(now.getFullYear(), now.getMonth(), 9),
          amount: 250,
          description: "OFFICE SUPPLIES",
          reference: "CHK-1023",
          type: "DEBIT",
        },
        {
          bankAccountId: bank.id,
          postedAt: new Date(now.getFullYear(), now.getMonth(), 15),
          amount: 920,
          description: "SUPPLIER TRANSFER",
          reference: "TRX-8892",
          type: "DEBIT",
        },
      ],
    });
  }

  const existingReconciliation = await prisma.reconciliation.count({
    where: { bankAccountId: bank.id },
  });
  if (existingReconciliation === 0) {
    const now = new Date();
    const periodStart = startOfMonth(now);
    const periodEnd = endOfMonth(now);
    const reconciliation = await prisma.reconciliation.create({
      data: {
        bankAccountId: bank.id,
        periodStart,
        periodEnd,
        statementBalance: 4200,
        status: "IN_PROGRESS",
      },
    });

    const bankTxn = await prisma.bankTransaction.findFirst({
      where: { bankAccountId: bank.id, description: { contains: "MOMO" } },
      orderBy: { postedAt: "asc" },
    });

    const journalLine = await prisma.journalLine.findFirst({
      where: {
        accountId: accountByCode.get("1010")?.id,
        debit: { gt: 0 },
      },
      orderBy: { createdAt: "asc" },
    });

    if (bankTxn) {
      await prisma.reconciliationLine.create({
        data: {
          reconciliationId: reconciliation.id,
          bankTransactionId: bankTxn.id,
          journalLineId: journalLine?.id || null,
          matchStatus: journalLine ? "MATCHED" : "UNMATCHED",
        },
      });
    }
  }

  const existingVatRuns = await prisma.vatFilingRun.count();
  if (existingVatRuns === 0) {
    const now = new Date();
    const startDate = startOfMonth(now);
    const endDate = endOfMonth(now);
    const summary = {
      outputVat: 180,
      inputVat: 120,
      netVat: 60,
      outputBase: 1200,
      inputBase: 800,
      exemptBase: 0,
      zeroBase: 0,
    };
    const details = [
      {
        name: "VAT 15% Output",
        rate: 15,
        type: "OUTPUT",
        baseTotal: 1200,
        vatTotal: 180,
      },
      {
        name: "VAT 15% Input",
        rate: 15,
        type: "INPUT",
        baseTotal: 800,
        vatTotal: 120,
      },
    ];
    await prisma.vatFilingRun.create({
      data: {
        startDate,
        endDate,
        summary,
        details,
      },
    });
  }
}

main()
  .catch((e) => {
    console.error("Seed accounting error:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
