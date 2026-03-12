import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { recordAuditLog } from "@/lib/audit-log";
import { randomUUID } from "crypto";
import { hasPermission } from "@/lib/permissions";

const templates: Record<string, string[]> = {
  products: [
    "name",
    "sku",
    "category",
    "price",
    "cost",
    "minMarginPct",
    "stock",
    "supplier",
    "leadTimeDays",
    "minOrderQty",
    "packSize",
    "requiresLotTracking",
    "requiresExpiryDate",
  ],
  suppliers: ["name", "email", "phone", "leadTimeDays", "minOrderQty", "packSize", "status", "notes"],
  customers: ["name", "email", "phone", "company", "address", "creditLimit"],
  orders: ["invoiceNumber", "customerEmail", "date", "status", "total", "amountPaid", "deliveryStatus"],
  purchases: ["productSku", "supplier", "quantity", "unitCost", "status", "expectedAt", "notes"],
  inventoryLots: ["productSku", "batchCode", "expiryDate", "quantity", "receivedAt", "supplier"],
  payments: ["orderInvoice", "amount", "method", "provider", "status", "createdAt"],
  supplierPayments: [
    "supplier",
    "purchaseId",
    "amount",
    "method",
    "reference",
    "status",
    "paidAt",
    "approvedAt",
    "createdAt",
  ],
  bankTransactions: [
    "bankName",
    "postedAt",
    "amount",
    "type",
    "description",
    "reference",
  ],
};

export async function GET(
  _req: Request,
  context: { params: Promise<{ type: string }> | { type: string } },
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !hasPermission(user?.role, "import.data")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = await context.params;
  const key = params.type;
  const headers = templates[key];
  if (!headers) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }

  await recordAuditLog({
    actorId: user?.id,
    action: "IMPORT_EXPORT",
    entityType: "IMPORT_EXPORT",
    entityId: randomUUID(),
    meta: {
      action: "TEMPLATE",
      resource: key,
      format: "csv",
    },
  });

  const body = `${headers.join(",")}\n`;
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename=${key}-template.csv`,
    },
  });
}
