import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type MovementsWhere = {
  productId?: string;
  reason?: { contains: string; mode: "insensitive" };
  createdAt?: {
    gte?: Date;
    lte?: Date;
  };
};

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
    const reason = searchParams.get("reason");
    const format = searchParams.get("format");

    const where: MovementsWhere = {};
    if (product) where.productId = product;
    if (reason) where.reason = { contains: reason, mode: "insensitive" };
    if (start || end) {
      where.createdAt = {};
      if (start) where.createdAt.gte = new Date(start);
      if (end) {
        const dt = new Date(end);
        dt.setHours(23, 59, 59, 999);
        where.createdAt.lte = dt;
      }
    }

    const rows = await prisma.inventoryMovement.findMany({
      where,
      include: {
        product: { select: { name: true } },
        purchase: { select: { supplier: true, unitCost: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    const items = rows.map((r: {
      id: string;
      productId: string;
      delta: number;
      reason: string;
      createdAt: Date;
      product?: { name?: string | null } | null;
      purchase?: { supplier?: string | null; unitCost?: unknown } | null;
    }) => ({
      id: r.id,
      productId: r.productId,
      productName: r.product?.name ?? "",
      delta: r.delta,
      reason: r.reason,
      supplier: r.purchase?.supplier ?? "",
      unitCost:
        r.purchase?.unitCost != null ? Number(r.purchase.unitCost) : null,
      createdAt: r.createdAt,
    }));

    if (format === "csv") {
      const header = ["Date", "Product", "Delta", "Reason", "Supplier", "Unit Cost"];
      const lines = [header.join(",")];
      for (const r of items) {
        lines.push([
          new Date(r.createdAt).toISOString(),
          JSON.stringify(r.productName),
          String(r.delta),
          JSON.stringify(r.reason),
          JSON.stringify(r.supplier || ""),
          r.unitCost == null ? "" : r.unitCost.toFixed(2),
        ].join(","));
      }
      const net = items.reduce(
        (s: number, r: { delta: unknown }) => s + Number(r.delta || 0),
        0
      );
      lines.push(["Net", "", String(net), "", "", ""].join(","));
      const csv = lines.join("\n");
      return new Response(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename=movements_${Date.now()}.csv`,
        },
      });
    }

    return NextResponse.json({ items });
  } catch (err) {
    console.error("Error listing movements:", err);
    return NextResponse.json({ error: "Failed to list movements" }, { status: 500 });
  }
}
