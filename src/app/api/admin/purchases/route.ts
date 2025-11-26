import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { rateLimit } from "@/lib/rate-limit";

type TxClient = Parameters<typeof prisma.$transaction>[0] extends (arg: infer A) => any ? A : never;

type PurchasesWhere = {
  productId?: string;
  supplier?: { contains: string; mode: "insensitive" };
  note?: { contains: string; mode: "insensitive" };
  createdAt?: { gte?: Date; lte?: Date };
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
    const supplier = searchParams.get("supplier");
    const q = searchParams.get("q");
    const format = searchParams.get("format");

    const where: PurchasesWhere = {};
    if (product) where.productId = product;
    if (supplier) where.supplier = { contains: supplier, mode: "insensitive" };
    if (q) where.note = { contains: q, mode: "insensitive" };
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
      include: { product: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
    });

    const items = rows.map((r: {
      id: string;
      productId: string;
      quantity: number;
      unitCost: unknown;
      supplier?: string | null;
      note?: string | null;
      createdAt: Date;
      product?: { name?: string | null } | null;
    }) => ({
      id: r.id,
      productId: r.productId,
      productName: r.product?.name ?? "",
      quantity: r.quantity,
      unitCost: Number(r.unitCost),
      total: Number(r.unitCost) * r.quantity,
      supplier: r.supplier || "",
      note: r.note || "",
      createdAt: r.createdAt,
    }));

    if (format === "csv") {
      const header = ["Date", "Product", "Qty", "Unit Cost", "Total", "Supplier", "Note"];
      const lines = [header.join(",")];
      for (const r of items) {
        lines.push([
          new Date(r.createdAt).toISOString(),
          JSON.stringify(r.productName),
          String(r.quantity),
          r.unitCost.toFixed(2),
          r.total.toFixed(2),
          JSON.stringify(r.supplier || ""),
          JSON.stringify(r.note || ""),
        ].join(","));
      }
      const totalQty = items.reduce((s: number, r: { quantity: number }) => s + r.quantity, 0);
      const totalVal = items.reduce((s: number, r: { total: number }) => s + r.total, 0);
      lines.push(["Totals", "", String(totalQty), "", totalVal.toFixed(2), "", ""].join(","));
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
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
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
    const note = (body.note || "").trim() || null;
    if (!productId || !Number.isInteger(quantity) || quantity <= 0 || !Number.isFinite(unitCost) || unitCost < 0) {
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }

    const result = await prisma.$transaction(async (tx: TxClient) => {
      const product = await tx.product.findUnique({ where: { id: productId }, select: { stock: true, cost: true } });
      if (!product) throw new Error("Product not found");
      const oldStock = Number(product.stock || 0);
      const oldCost = Number(product.cost || 0);
      // Ignore negative on-hand when computing weighted average cost
      const effectiveOldStock = Math.max(0, oldStock);
      const newStock = oldStock + quantity;
      const denom = effectiveOldStock + quantity;
      const newCost = denom > 0 ? ((oldCost * effectiveOldStock + unitCost * quantity) / denom) : unitCost;

      const purchase = await tx.purchase.create({
        data: { productId, quantity, unitCost, supplier, note },
      });

      await tx.product.update({
        where: { id: productId },
        data: { stock: newStock, cost: Number(newCost) },
      });

      await tx.inventoryMovement.create({
        data: { productId, delta: quantity, reason: "PURCHASE", purchaseId: purchase.id },
      });

      return { purchaseId: purchase.id, newStock, newCost: Number(newCost) };
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("Error creating purchase:", err);
    return NextResponse.json({ error: "Failed to create purchase" }, { status: 500 });
  }
}
