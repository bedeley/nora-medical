import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import type { Prisma } from "@prisma/client";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const EXPORT_BATCH_SIZE = 1000;

type SortField = "createdAt" | "productName" | "delta" | "reason" | "expiryDate";
type SortDir = "asc" | "desc";

function parsePositiveInt(value: string | null, fallback: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), 1), max);
}

function parseSortField(value: string | null): SortField {
  switch (value) {
    case "productName":
    case "delta":
    case "reason":
    case "expiryDate":
      return value;
    default:
      return "createdAt";
  }
}

function parseSortDir(value: string | null): SortDir {
  return value === "asc" ? "asc" : "desc";
}

function buildOrderBy(sortBy: SortField, sortDir: SortDir): Prisma.InventoryMovementOrderByWithRelationInput[] {
  switch (sortBy) {
    case "productName":
      return [{ product: { name: sortDir } }, { createdAt: "desc" }, { id: "desc" }];
    case "delta":
      return [{ delta: sortDir }, { createdAt: "desc" }, { id: "desc" }];
    case "reason":
      return [{ reason: sortDir }, { createdAt: "desc" }, { id: "desc" }];
    case "expiryDate":
      return [{ lot: { expiryDate: sortDir } }, { createdAt: "desc" }, { id: "desc" }];
    case "createdAt":
    default:
      return [{ createdAt: sortDir }, { id: sortDir }];
  }
}

function toCsvCell(value: unknown) {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function mapMovementRow(
  row: {
    id: string;
    productId: string;
    purchaseId?: string | null;
    delta: number;
    reason: string;
    note?: string | null;
    createdAt: Date;
    product?: { name?: string | null; sku?: string | null } | null;
    purchase?: { supplier?: string | null; unitCost?: unknown } | null;
    lot?: { lotCode?: string | null; expiryDate?: Date | null } | null;
  },
) {
  return {
    id: row.id,
    productId: row.productId,
    purchaseId: row.purchaseId ?? null,
    productName: row.product?.name ?? "",
    productSku: row.product?.sku ?? null,
    delta: row.delta,
    reason: row.reason,
    note: row.note ?? null,
    supplier: row.purchase?.supplier ?? "",
    unitCost: row.purchase?.unitCost != null ? Number(row.purchase.unitCost) : null,
    lotCode: row.lot?.lotCode ?? null,
    expiryDate: row.lot?.expiryDate ?? null,
    createdAt: row.createdAt,
  };
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  const isAccountant = role === "ACCOUNTANT";

  if (!session || (!isAdmin && !isStaff && !isAccountant)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const start = searchParams.get("start");
    const end = searchParams.get("end");
    const product = searchParams.get("product");
    const lotId = searchParams.get("lotId");
    const reason = searchParams.get("reason");
    const format = searchParams.get("format");
    const page = parsePositiveInt(searchParams.get("page"), 1, Number.MAX_SAFE_INTEGER);
    const pageSize = parsePositiveInt(searchParams.get("pageSize"), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const sortBy = parseSortField(searchParams.get("sortBy"));
    const sortDir = parseSortDir(searchParams.get("sortDir"));

    const where: Prisma.InventoryMovementWhereInput = {};
    if (product) where.productId = product;
    if (lotId) where.lotId = lotId;
    if (reason) where.reason = { contains: reason, mode: "insensitive" };
    if (start || end) {
      where.createdAt = {};
      if (start) where.createdAt.gte = new Date(start);
      if (end) {
        const endDate = new Date(end);
        endDate.setUTCHours(23, 59, 59, 999);
        where.createdAt.lte = endDate;
      }
    }

    const include = {
      product: { select: { name: true, sku: true } },
      purchase: { select: { supplier: true, unitCost: true } },
      lot: { select: { lotCode: true, expiryDate: true } },
    } satisfies Prisma.InventoryMovementInclude;
    const orderBy = buildOrderBy(sortBy, sortDir);

    if (format === "csv") {
      const encoder = new TextEncoder();
      const netAgg = await prisma.inventoryMovement.aggregate({
        where,
        _sum: { delta: true },
      });
      const header = ["Date", "Product", "SKU", "Delta", "Reason", "Note", "Supplier", "Unit Cost", "Lot", "Expiry"];
      const net = Number(netAgg._sum.delta ?? 0);

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode(`${header.map(toCsvCell).join(",")}\n`));
          let skip = 0;

          while (true) {
            const batch = await prisma.inventoryMovement.findMany({
              where,
              include,
              orderBy,
              skip,
              take: EXPORT_BATCH_SIZE,
            });
            if (batch.length === 0) break;

            for (const row of batch) {
              const item = mapMovementRow(row);
              const line = [
                toCsvCell(new Date(item.createdAt).toISOString()),
                toCsvCell(item.productName),
                toCsvCell(item.productSku || ""),
                toCsvCell(item.delta),
                toCsvCell(item.reason),
                toCsvCell(item.note || ""),
                toCsvCell(item.supplier || ""),
                toCsvCell(item.unitCost == null ? "" : item.unitCost.toFixed(2)),
                toCsvCell(item.lotCode || ""),
                toCsvCell(item.expiryDate ? new Date(item.expiryDate).toISOString().slice(0, 10) : ""),
              ].join(",");
              controller.enqueue(encoder.encode(`${line}\n`));
            }

            skip += batch.length;
            if (batch.length < EXPORT_BATCH_SIZE) break;
          }

          const netLine = [
            toCsvCell("Net"),
            toCsvCell(""),
            toCsvCell(""),
            toCsvCell(net),
            toCsvCell(""),
            toCsvCell(""),
            toCsvCell(""),
            toCsvCell(""),
            toCsvCell(""),
            toCsvCell(""),
          ].join(",");
          controller.enqueue(encoder.encode(`${netLine}\n`));
          controller.close();
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename=movements_${Date.now()}.csv`,
        },
      });
    }

    const [rows, total, totalInAgg, totalOutAgg, netAgg] = await Promise.all([
      prisma.inventoryMovement.findMany({
        where,
        include,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.inventoryMovement.count({ where }),
      prisma.inventoryMovement.aggregate({
        where: { AND: [where, { delta: { gt: 0 } }] },
        _sum: { delta: true },
      }),
      prisma.inventoryMovement.aggregate({
        where: { AND: [where, { delta: { lt: 0 } }] },
        _sum: { delta: true },
      }),
      prisma.inventoryMovement.aggregate({
        where,
        _sum: { delta: true },
      }),
    ]);

    const items = rows.map(mapMovementRow);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    return NextResponse.json({
      items,
      total,
      page,
      pageSize,
      totalPages,
      sortBy,
      sortDir,
      stats: {
        totalIn: Number(totalInAgg._sum.delta ?? 0),
        totalOut: Math.abs(Number(totalOutAgg._sum.delta ?? 0)),
        net: Number(netAgg._sum.delta ?? 0),
      },
    });
  } catch (err) {
    console.error("Error listing movements:", err);
    return NextResponse.json({ error: "Failed to list movements" }, { status: 500 });
  }
}
