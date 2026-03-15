import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit-log";
import { randomUUID, randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import { PaymentStatus } from "@/lib/prisma-enums";
import { PurchaseStatus, SupplierPaymentStatus } from "@prisma/client";
import { hasPermission } from "@/lib/permissions";
import { assertSameOrigin } from "@/lib/origin";

type CsvRow = Record<string, string>;
type ImportOutcomePreviewRow = {
  row: number;
  bankName?: string;
  date?: string;
  amount?: string;
  reference?: string;
  reason?: string;
};

const parseCsv = (input: string): CsvRow[] => {
  const rows: string[][] = [];
  let current: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1];
    if (char === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === "," && !inQuotes) {
      current.push(field);
      field = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i += 1;
      current.push(field);
      field = "";
      if (current.some((value) => value.trim().length > 0)) {
        rows.push(current);
      }
      current = [];
      continue;
    }
    field += char;
  }
  if (field.length > 0 || current.length > 0) {
    current.push(field);
    if (current.some((value) => value.trim().length > 0)) {
      rows.push(current);
    }
  }

  if (!rows.length) return [];
  const headers = rows[0].map((value) => value.trim());
  return rows.slice(1).map((row) =>
    headers.reduce((acc, header, idx) => {
      acc[header] = row[idx]?.trim() ?? "";
      return acc;
    }, {} as CsvRow),
  );
};

const toNumber = (value: string) => {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const toInt = (value: string) => {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
};

const toBool = (value: string) => {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "1", "y"].includes(normalized)) return true;
  if (["false", "no", "0", "n"].includes(normalized)) return false;
  return null;
};

export async function POST(
  req: Request,
  context: { params: Promise<{ resource: string }> | { resource: string } },
) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !hasPermission(user?.role, "import.data")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = await context.params;
  const resource = params.resource;

  const formData = await req.formData();
  const file = formData.get("file");
  const dryRun =
    String(formData.get("dryRun") || "")
      .trim()
      .toLowerCase() === "1";
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing CSV file." }, { status: 400 });
  }
  const contents = await file.text();
  const rows = parseCsv(contents);
  if (!rows.length) {
    return NextResponse.json({ error: "CSV is empty." }, { status: 400 });
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const issues: Array<{ row: number; reason: string }> = [];
  const createdPreview: ImportOutcomePreviewRow[] = [];
  const updatedPreview: ImportOutcomePreviewRow[] = [];
  const skippedPreview: ImportOutcomePreviewRow[] = [];
  const importedBankIds = new Set<string>();
  const noteSkip = (rowIndex: number, reason: string) => {
    skipped += 1;
    issues.push({ row: rowIndex, reason });
    if (skippedPreview.length < 2000) {
      skippedPreview.push({ row: rowIndex, reason });
    }
  };

  if (resource === "products") {
    for (const [index, row] of rows.entries()) {
      const rowIndex = index + 2;
      const name = row.name?.trim();
      if (!name) {
        noteSkip(rowIndex, "Missing product name.");
        continue;
      }
      const sku = row.sku?.trim() || null;
      const price = toNumber(row.price);
      const cost = toNumber(row.cost);
      const minMarginPct = toNumber(row.minMarginPct);
      const stock = toInt(row.stock);
      const category = row.category?.trim() || null;
      const supplierName = row.supplier?.trim() || null;
      const leadTimeDays = toInt(row.leadTimeDays);
      const minOrderQty = toInt(row.minOrderQty);
      const packSize = toInt(row.packSize);
      const requiresLotTracking = toBool(row.requiresLotTracking);
      const requiresExpiryDate = toBool(row.requiresExpiryDate);
      const normalizedRequiresLotTracking = Boolean(requiresLotTracking) || Boolean(requiresExpiryDate);

      let supplierId: string | null = null;
      if (supplierName) {
        const existingSupplier = await prisma.supplier.findFirst({
          where: { name: supplierName },
        });
        if (existingSupplier) {
          supplierId = existingSupplier.id;
          if (!dryRun) {
            await prisma.supplier.update({
              where: { id: existingSupplier.id },
              data: {
                ...(leadTimeDays !== null ? { leadTimeDays } : {}),
                ...(minOrderQty !== null ? { defaultMinOrderQty: minOrderQty } : {}),
                ...(packSize !== null ? { defaultPackSize: packSize } : {}),
              },
            });
          }
        } else if (!dryRun) {
          const supplier = await prisma.supplier.create({
            data: {
              name: supplierName,
              ...(leadTimeDays !== null ? { leadTimeDays } : {}),
              ...(minOrderQty !== null ? { defaultMinOrderQty: minOrderQty } : {}),
              ...(packSize !== null ? { defaultPackSize: packSize } : {}),
            },
          });
          supplierId = supplier.id;
        }
      }

      let product: { id: string } | null = null;
      if (sku) {
        const existing = await prisma.product.findFirst({ where: { sku } });
        if (existing) {
          updated += 1;
          if (!dryRun) {
            product = await prisma.product.update({
              where: { id: existing.id },
              data: {
                name,
                ...(category ? { category } : {}),
                ...(price !== null ? { price } : {}),
                ...(cost !== null ? { cost } : {}),
                ...(minMarginPct !== null ? { minMarginPct } : {}),
                ...(stock !== null ? { stock } : {}),
                ...(supplierName ? { supplier: supplierName } : {}),
                ...(supplierId ? { supplierId } : {}),
                ...(requiresLotTracking !== null ? { requiresLotTracking: normalizedRequiresLotTracking } : {}),
                ...(requiresExpiryDate !== null ? { requiresExpiryDate: Boolean(requiresExpiryDate) } : {}),
              },
            });
          } else {
            product = existing;
          }
        } else {
          created += 1;
          if (!dryRun) {
            product = await prisma.product.create({
              data: {
                name,
                sku,
                description: "",
                imageUrl: "",
                category,
                price: price ?? 0,
                cost: cost ?? 0,
                ...(minMarginPct !== null ? { minMarginPct } : {}),
                stock: stock ?? 0,
                supplier: supplierName,
                supplierId,
                requiresLotTracking: normalizedRequiresLotTracking,
                requiresExpiryDate: Boolean(requiresExpiryDate),
              },
            });
          } else {
            product = { id: randomUUID() };
          }
        }
      } else {
        const existingProduct = await prisma.product.findFirst({ where: { name } });
        if (existingProduct) {
          updated += 1;
          if (!dryRun) {
            product = await prisma.product.update({
              where: { id: existingProduct.id },
              data: {
                ...(category ? { category } : {}),
                ...(price !== null ? { price } : {}),
                ...(cost !== null ? { cost } : {}),
                ...(stock !== null ? { stock } : {}),
                ...(supplierName ? { supplier: supplierName } : {}),
                ...(supplierId ? { supplierId } : {}),
                ...(requiresLotTracking !== null ? { requiresLotTracking: normalizedRequiresLotTracking } : {}),
                ...(requiresExpiryDate !== null ? { requiresExpiryDate: Boolean(requiresExpiryDate) } : {}),
              },
            });
          } else {
            product = existingProduct;
          }
        } else {
          created += 1;
          if (!dryRun) {
            product = await prisma.product.create({
              data: {
                name,
                sku: null,
                description: "",
                imageUrl: "",
                category,
                price: price ?? 0,
                cost: cost ?? 0,
                stock: stock ?? 0,
                supplier: supplierName,
                supplierId,
                requiresLotTracking: normalizedRequiresLotTracking,
                requiresExpiryDate: Boolean(requiresExpiryDate),
              },
            });
          } else {
            product = { id: randomUUID() };
          }
        }
      }

      if (product && supplierId && (leadTimeDays !== null || minOrderQty !== null || packSize !== null) && !dryRun) {
        await prisma.productSupplier.upsert({
          where: { productId_supplierId: { productId: product.id, supplierId } },
          update: {
            ...(leadTimeDays !== null ? { leadTimeDays } : {}),
            ...(minOrderQty !== null ? { minOrderQty } : {}),
            ...(packSize !== null ? { packSize } : {}),
            isPrimary: true,
          },
          create: {
            productId: product.id,
            supplierId,
            isPrimary: true,
            ...(leadTimeDays !== null ? { leadTimeDays } : {}),
            ...(minOrderQty !== null ? { minOrderQty } : {}),
            ...(packSize !== null ? { packSize } : {}),
          },
        });
      }
    }
  } else if (resource === "suppliers") {
    for (const [index, row] of rows.entries()) {
      const rowIndex = index + 2;
      const name = row.name?.trim();
      if (!name) {
        noteSkip(rowIndex, "Missing supplier name.");
        continue;
      }
      const email = row.email?.trim() || null;
      const phone = row.phone?.trim() || null;
      const leadTimeDays = toInt(row.leadTimeDays);
      const minOrderQty = toInt(row.minOrderQty);
      const packSize = toInt(row.packSize);
      const status = row.status?.trim()?.toUpperCase() || null;
      const notes = row.notes?.trim() || null;

      const existingSupplier = await prisma.supplier.findFirst({ where: { name } });
      if (existingSupplier) {
        updated += 1;
        if (!dryRun) {
          await prisma.supplier.update({
            where: { id: existingSupplier.id },
            data: {
              ...(email ? { email } : {}),
              ...(phone ? { phone } : {}),
              ...(leadTimeDays !== null ? { leadTimeDays } : {}),
              ...(minOrderQty !== null ? { defaultMinOrderQty: minOrderQty } : {}),
              ...(packSize !== null ? { defaultPackSize: packSize } : {}),
              ...(status ? { status: status as "ACTIVE" | "INACTIVE" | "ON_HOLD" } : {}),
              ...(notes ? { notes } : {}),
            },
          });
        }
      } else {
        created += 1;
        if (!dryRun) {
          await prisma.supplier.create({
            data: {
              name,
              email,
              phone,
              ...(leadTimeDays !== null ? { leadTimeDays } : {}),
              ...(minOrderQty !== null ? { defaultMinOrderQty: minOrderQty } : {}),
              ...(packSize !== null ? { defaultPackSize: packSize } : {}),
              ...(status ? { status: status as "ACTIVE" | "INACTIVE" | "ON_HOLD" } : {}),
              notes,
            },
          });
        }
      }
    }
  } else if (resource === "customers") {
    for (const [index, row] of rows.entries()) {
      const rowIndex = index + 2;
      const email = row.email?.trim();
      if (!email) {
        noteSkip(rowIndex, "Missing customer email.");
        continue;
      }
      const name = row.name?.trim() || null;
      const phone = row.phone?.trim() || null;
      const creditLimit = toNumber(row.creditLimit || "");
      if (creditLimit !== null && creditLimit < 0) {
        noteSkip(rowIndex, "Credit limit must be zero or positive.");
        continue;
      }
      const password = randomBytes(12).toString("hex");
      const passwordHash = await bcrypt.hash(password, 10);

      const existingUser = await prisma.user.findFirst({ where: { email } });
      if (existingUser) {
        updated += 1;
        if (!dryRun) {
          await prisma.user.update({
            where: { id: existingUser.id },
            data: {
              ...(name ? { name } : {}),
              ...(phone ? { phone } : {}),
              role: "CUSTOMER",
            },
          });
          if (creditLimit !== null) {
            await prisma.balance.upsert({
              where: { userId: existingUser.id },
              update: { creditLimit },
              create: {
                userId: existingUser.id,
                creditLimit,
                totalDue: 0,
                totalPaid: 0,
                balance: 0,
              },
            });
          }
        }
      } else {
        created += 1;
        if (!dryRun) {
          const user = await prisma.user.create({
            data: {
              name,
              email,
              phone,
              password: passwordHash,
              role: "CUSTOMER",
            },
          });
          if (creditLimit !== null) {
            await prisma.balance.create({
              data: {
                userId: user.id,
                creditLimit,
                totalDue: 0,
                totalPaid: 0,
                balance: 0,
              },
            });
          }
        }
      }
    }
  } else if (resource === "inventoryLots") {
    for (const [index, row] of rows.entries()) {
      const rowIndex = index + 2;
      const productSku = row.productSku?.trim();
      const lotCode = row.batchCode?.trim();
      const quantity = toInt(row.quantity);
      if (!productSku || !lotCode || quantity === null) {
        noteSkip(rowIndex, "Missing productSku, batchCode, or quantity.");
        continue;
      }
      const product = await prisma.product.findFirst({ where: { sku: productSku } });
      if (!product) {
        noteSkip(rowIndex, `Unknown product SKU "${productSku}".`);
        continue;
      }
      const supplierName = row.supplier?.trim();
      let supplierId: string | null = null;
      if (supplierName) {
        const existingSupplier = await prisma.supplier.findFirst({ where: { name: supplierName } });
        if (existingSupplier) {
          supplierId = existingSupplier.id;
        } else if (!dryRun) {
          const supplier = await prisma.supplier.create({ data: { name: supplierName } });
          supplierId = supplier.id;
        }
      }

      const expiryDate = row.expiryDate ? new Date(row.expiryDate) : null;
      const receivedAt = row.receivedAt ? new Date(row.receivedAt) : null;

      if (!dryRun) {
        const lot = await prisma.inventoryLot.upsert({
          where: { productId_lotCode: { productId: product.id, lotCode } },
          update: {
            ...(expiryDate ? { expiryDate } : {}),
            ...(receivedAt ? { receivedAt } : {}),
            quantityReceived: quantity,
            quantityRemaining: quantity,
            ...(supplierId ? { supplierId } : {}),
          },
          create: {
            productId: product.id,
            supplierId,
            lotCode,
            expiryDate,
            receivedAt: receivedAt ?? new Date(),
            quantityReceived: quantity,
            quantityRemaining: quantity,
            notes: row.notes?.trim() || null,
          },
        });
        if (lot.createdAt.getTime() === lot.updatedAt.getTime()) {
          created += 1;
        } else {
          updated += 1;
        }
      } else {
        const existing = await prisma.inventoryLot.findFirst({
          where: { productId: product.id, lotCode },
        });
        if (existing) {
          updated += 1;
        } else {
          created += 1;
        }
      }
    }
  } else if (resource === "purchases") {
    for (const [index, row] of rows.entries()) {
      const rowIndex = index + 2;
      const productSku = row.productSku?.trim();
      const supplierName = row.supplier?.trim();
      const quantity = toInt(row.quantity);
      const unitCost = toNumber(row.unitCost);
      const statusRaw = row.status?.trim().toUpperCase();
      const status =
        statusRaw && Object.values(PurchaseStatus).includes(statusRaw as PurchaseStatus)
          ? (statusRaw as PurchaseStatus)
          : PurchaseStatus.ORDERED;

      if (!productSku || quantity === null || unitCost === null) {
        noteSkip(rowIndex, "Missing productSku, quantity, or unitCost.");
        continue;
      }

      const product = await prisma.product.findFirst({ where: { sku: productSku } });
      if (!product) {
        noteSkip(rowIndex, `Unknown product SKU "${productSku}".`);
        continue;
      }

      let supplierId: string | null = null;
      if (supplierName) {
        const existingSupplier = await prisma.supplier.findFirst({ where: { name: supplierName } });
        if (existingSupplier) {
          supplierId = existingSupplier.id;
        } else if (!dryRun) {
          const supplier = await prisma.supplier.create({ data: { name: supplierName } });
          supplierId = supplier.id;
        }
      }

      const expectedAt = row.expectedAt ? new Date(row.expectedAt) : null;
      const notes = row.notes?.trim() || null;

      const existing = await prisma.purchase.findFirst({
        where: {
          productId: product.id,
          supplierId: supplierId ?? null,
          quantity,
          unitCost,
          status,
          expectedAt: expectedAt ?? null,
        },
      });
      if (existing) {
        noteSkip(rowIndex, "Duplicate purchase entry.");
        continue;
      }

      created += 1;
      if (!dryRun) {
        await prisma.purchase.create({
          data: {
            productId: product.id,
            supplierId,
            supplier: supplierName || null,
            quantity,
            unitCost,
            status,
            expectedAt,
            note: notes,
          },
        });
      }
    }
  } else if (resource === "payments") {
    for (const [index, row] of rows.entries()) {
      const rowIndex = index + 2;
      const invoice = row.orderInvoice?.trim();
      const amount = toNumber(row.amount);
      const method = row.method?.trim() || null;
      const provider = row.provider?.trim() || null;
      const statusRaw = row.status?.trim().toUpperCase();
      const status =
        statusRaw && Object.values(PaymentStatus).includes(statusRaw as PaymentStatus)
          ? (statusRaw as PaymentStatus)
          : PaymentStatus.NORMAL;
      const createdAt = row.createdAt ? new Date(row.createdAt) : null;

      if (!invoice || amount === null) {
        noteSkip(rowIndex, "Missing orderInvoice or amount.");
        continue;
      }

      const order = await prisma.order.findFirst({ where: { invoiceNumber: invoice } });
      if (!order) {
        noteSkip(rowIndex, `Unknown order invoice "${invoice}".`);
        continue;
      }

      const existing = await prisma.payment.findFirst({
        where: {
          orderId: order.id,
          amount,
          status,
          ...(createdAt ? { createdAt } : {}),
          ...(method ? { note: { contains: `"method":"${method}"` } } : {}),
          ...(provider ? { note: { contains: `"provider":"${provider}"` } } : {}),
        },
      });
      if (existing) {
        noteSkip(rowIndex, "Duplicate payment entry.");
        continue;
      }

      created += 1;
      if (!dryRun) {
        await prisma.payment.create({
          data: {
            orderId: order.id,
            userId: order.userId ?? null,
            amount,
            note: JSON.stringify({
              method,
              provider,
              source: "IMPORT",
            }),
            status,
            ...(createdAt ? { createdAt } : {}),
          },
        });
      }
    }
  } else if (resource === "orders") {
    for (const [index, row] of rows.entries()) {
      const rowIndex = index + 2;
      const invoiceNumber = row.invoiceNumber?.trim() || null;
      const customerEmail = row.customerEmail?.trim() || null;
      const status = row.status?.trim() || "UNPAID";
      const deliveryStatus = row.deliveryStatus?.trim() || "NOT_DELIVERED";
      const total = toNumber(row.total) ?? 0;
      const amountPaid = toNumber(row.amountPaid) ?? 0;
      const createdAt = row.date ? new Date(row.date) : null;

      let userId: string | null = null;
      if (customerEmail) {
        const user = await prisma.user.findFirst({ where: { email: customerEmail } });
        if (user) userId = user.id;
      }

      if (invoiceNumber) {
        const existing = await prisma.order.findFirst({ where: { invoiceNumber } });
        if (existing) {
          noteSkip(rowIndex, `Duplicate order invoice "${invoiceNumber}".`);
          continue;
        }
      }

      created += 1;
      if (!dryRun) {
        await prisma.order.create({
          data: {
            invoiceNumber,
            userId,
            total,
            amountPaid,
            balance: Math.max(0, total - amountPaid),
            status,
            deliveryStatus,
            ...(createdAt ? { createdAt } : {}),
          },
        });
      }
    }
  } else if (resource === "supplierPayments") {
    for (const [index, row] of rows.entries()) {
      const rowIndex = index + 2;
      const supplierName = row.supplier?.trim();
      const purchaseId = row.purchaseId?.trim() || null;
      const amount = toNumber(row.amount);
      const method = row.method?.trim() || null;
      const reference = row.reference?.trim() || null;
      const statusRaw = row.status?.trim().toUpperCase();
      const status =
        statusRaw && Object.values(SupplierPaymentStatus).includes(statusRaw as SupplierPaymentStatus)
          ? (statusRaw as SupplierPaymentStatus)
          : SupplierPaymentStatus.NORMAL;
      const paidAt = row.paidAt ? new Date(row.paidAt) : null;
      const approvedAt = row.approvedAt ? new Date(row.approvedAt) : null;
      const createdAt = row.createdAt ? new Date(row.createdAt) : null;

      if (!amount && amount !== 0) {
        noteSkip(rowIndex, "Missing amount.");
        continue;
      }

      let supplierId: string | null = null;
      if (supplierName) {
        const existingSupplier = await prisma.supplier.findFirst({ where: { name: supplierName } });
        if (existingSupplier) {
          supplierId = existingSupplier.id;
        } else if (!dryRun) {
          const supplier = await prisma.supplier.create({ data: { name: supplierName } });
          supplierId = supplier.id;
        }
      }

      const existing = await prisma.supplierPayment.findFirst({
        where: {
          supplierId: supplierId ?? null,
          purchaseId: purchaseId ?? null,
          amount,
          method: method ?? null,
          reference: reference ?? null,
          paidAt: paidAt ?? null,
        },
      });
      if (existing) {
        noteSkip(rowIndex, "Duplicate supplier payment entry.");
        continue;
      }

      created += 1;
      if (!dryRun) {
        await prisma.supplierPayment.create({
          data: {
            supplierId,
            purchaseId,
            amount,
            method,
            reference,
            status,
            ...(paidAt ? { paidAt } : {}),
            ...(approvedAt ? { approvedAt } : {}),
            ...(createdAt ? { createdAt } : {}),
          },
        });
      }
    }
  } else if (resource === "bankTransactions") {
    const bankIdFromForm = formData.get("bankId");
    const bankId = typeof bankIdFromForm === "string" ? bankIdFromForm.trim() : "";
    let bank: { id: string; name: string } | null = null;
    if (bankId) {
      bank = await prisma.bankAccount.findFirst({
        where: { id: bankId },
        select: { id: true, name: true },
      });
      if (!bank) {
        return NextResponse.json({ error: "Selected bank not found." }, { status: 400 });
      }
    }
    for (const [index, row] of rows.entries()) {
      const rowIndex = index + 2;
      const bankName = row.bankName?.trim();
      const postedAt = row.postedAt ? new Date(row.postedAt) : null;
      const amount = toNumber(row.amount);
      const typeRaw = row.type?.trim().toUpperCase();
      const type = typeRaw === "DEBIT" || typeRaw === "CREDIT" ? typeRaw : null;
      const description = row.description?.trim() || null;
      const reference = row.reference?.trim() || null;

      if (!postedAt || amount === null || !type) {
        noteSkip(rowIndex, "Missing postedAt, amount, or type.");
        continue;
      }

      if (!bank && bankName) {
        bank = await prisma.bankAccount.findFirst({
          where: { name: bankName },
          select: { id: true, name: true },
        });
      }
      if (!bank) {
        noteSkip(rowIndex, bankName ? `Unknown bank "${bankName}".` : "Missing bank selection.");
        continue;
      }
      importedBankIds.add(bank.id);

      const existing = await prisma.bankTransaction.findFirst({
        where: {
          bankAccountId: bank.id,
          postedAt,
          amount,
          reference: reference ?? null,
        },
      });
      if (existing) {
        noteSkip(rowIndex, "Duplicate bank transaction.");
        continue;
      }

      created += 1;
      if (createdPreview.length < 2000) {
        createdPreview.push({
          row: rowIndex,
          bankName: bank.name,
          date: postedAt.toISOString().slice(0, 10),
          amount: String(amount),
          reference: reference ?? "",
        });
      }
      if (!dryRun) {
        await prisma.bankTransaction.create({
          data: {
            bankAccountId: bank.id,
            postedAt,
            amount,
            type,
            description,
            reference,
          },
        });
      }
    }
  } else {
    return NextResponse.json({ error: "Import not supported for this dataset yet." }, { status: 400 });
  }

  await recordAuditLog({
    actorId: user?.id,
    action: "IMPORT_EXPORT",
    entityType: "IMPORT_EXPORT",
    entityId: randomUUID(),
    meta: {
      action: "IMPORT",
      resource,
      format: "csv",
      created,
      updated,
      skipped,
      bankIds:
        resource === "bankTransactions" ? Array.from(importedBankIds) : undefined,
      issuesCount: issues.length,
      issuesPreview: issues.slice(0, 50),
      issuesList: issues.slice(0, 2000),
      outcomePreview: {
        created: createdPreview.slice(0, 2000),
        updated: updatedPreview.slice(0, 2000),
        skipped: skippedPreview.slice(0, 2000),
      },
    },
  });

  return NextResponse.json({
    message: `Import complete. Added ${created}, updated ${updated}, skipped ${skipped}.`,
    created,
    updated,
    skipped,
    issues,
  });
}
