import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit-log";

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
  const supplierId = String(searchParams.get("supplierId") || "").trim();
  const supplierName = String(searchParams.get("supplier") || "").trim();
  if (!supplierId && !supplierName) {
    return NextResponse.json({ error: "Supplier is required." }, { status: 400 });
  }

  const where = {
    deletedAt: null,
    status: { not: "CANCELLED" },
    ...(supplierId
      ? { supplierId }
      : { supplier: { equals: supplierName, mode: "insensitive" } }),
  } satisfies NonNullable<Parameters<typeof prisma.purchase.findMany>[0]>["where"];

  const purchases = await prisma.purchase.findMany({
    where,
    include: {
      product: { select: { name: true, sku: true } },
      supplierRef: { select: { name: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const purchaseIds = purchases.map((p) => p.id);
  const paidSums = purchaseIds.length
    ? await prisma.supplierPayment.groupBy({
        by: ["purchaseId"],
        where: { deletedAt: null, status: "NORMAL", purchaseId: { in: purchaseIds } },
        _sum: { amount: true },
      })
    : [];
  const pendingSums = purchaseIds.length
    ? await prisma.supplierPayment.groupBy({
        by: ["purchaseId"],
        where: { deletedAt: null, status: "PENDING_APPROVAL", purchaseId: { in: purchaseIds } },
        _sum: { amount: true },
      })
    : [];

  const paidByPurchase = new Map(
    paidSums
      .filter((row) => row.purchaseId)
      .map((row) => [row.purchaseId as string, Number(row._sum.amount || 0)]),
  );
  const pendingByPurchase = new Map(
    pendingSums
      .filter((row) => row.purchaseId)
      .map((row) => [row.purchaseId as string, Number(row._sum.amount || 0)]),
  );

  const header = [
    "PurchaseId",
    "CreatedAt",
    "Supplier",
    "Product",
    "SKU",
    "Qty",
    "UnitCost",
    "Total",
    "Paid",
    "PendingApproval",
    "Outstanding",
    "Status",
  ];
  const lines = [header.join(",")];

  for (const p of purchases) {
    const total = Number(p.unitCost || 0) * Number(p.quantity || 0);
    const paid = paidByPurchase.get(p.id) || 0;
    const pending = pendingByPurchase.get(p.id) || 0;
    const outstanding = Math.max(0, total - paid);
    lines.push([
      JSON.stringify(p.id),
      JSON.stringify(p.createdAt.toISOString()),
      JSON.stringify(p.supplierRef?.name || p.supplier || ""),
      JSON.stringify(p.product?.name || ""),
      JSON.stringify(p.product?.sku || ""),
      String(p.quantity || 0),
      String(Number(p.unitCost || 0)),
      String(total),
      String(paid),
      String(pending),
      String(outstanding),
      JSON.stringify(p.status || ""),
    ].join(","));
  }

  const csv = lines.join("\n");
  try {
    await recordAuditLog({
      actorId: user?.id || null,
      action: "SUPPLIER_PAYABLES_STATEMENT_EXPORT_CSV",
      entityType: "SUPPLIER_PAYMENT",
      entityId: supplierId || supplierName || "SUMMARY",
      meta: {
        supplierId: supplierId || null,
        supplierName: supplierName || null,
        purchaseCount: purchases.length,
        rowCount: Math.max(0, lines.length - 1),
        columnCount: header.length,
        byteSize: Buffer.byteLength(csv, "utf8"),
        fileName: "supplier_statement.csv",
        format: "CSV",
        resultSummary: `Downloaded statement CSV with ${Math.max(0, lines.length - 1)} row(s).`,
        actorName: user?.name || null,
        actorEmail: user?.email || null,
        actorRole: user?.role || null,
      },
    });
  } catch {
    // best-effort audit log
  }
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": "attachment; filename=supplier_statement.csv",
    },
  });
}
