import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";

type InventoryPurchase = {
  quantity: number | null;
  unitCost: number | null;
  createdAt: Date;
  supplier: string | null;
  note: string | null;
};

export async function GET() {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return new Response("Forbidden", { status: 403 });
  }
  const products = await prisma.product.findMany({
    orderBy: { updatedAt: "desc" },
    include: {
      purchases: {
        orderBy: { createdAt: "desc" },
        select: { quantity: true, unitCost: true, createdAt: true, supplier: true, note: true },
      },
    },
  });
  const rows = products.map((p: (typeof products)[number]) => {
    const purchases = (p.purchases || []) as unknown as InventoryPurchase[];
    // Ignore zero/negative or invalid unit costs when computing averages
    const validPurchases = purchases.filter((pu) => {
      const q = Number(pu.quantity ?? 0);
      const c = Number(pu.unitCost ?? 0);
      return Number.isFinite(q) && q > 0 && Number.isFinite(c) && c > 0;
    });
    const last = validPurchases[0] || null;
    // Weighted average unit cost across all valid purchases
    let avgPurchaseCost: number | null = null;
    if (validPurchases.length > 0) {
      let totalQty = 0;
      let totalCost = 0;
      for (const pu of validPurchases) {
        const q = Number(pu.quantity || 0);
        const c = Number(pu.unitCost || 0);
        if (q > 0 && !Number.isNaN(c)) {
          totalQty += q;
          totalCost += q * c;
        }
      }
      if (totalQty > 0) avgPurchaseCost = totalCost / totalQty;
    }
    const baseCost = Number(p.cost ?? 0);

    let lastPurchaseCost: number | null = null;
    let lastPurchaseDate: string | null = null;
    let lastPurchaseSupplier: string | null = null;
    let lastPurchaseNote: string | null = null;

    if (last) {
      lastPurchaseCost = Number(last.unitCost);
      lastPurchaseDate = (last.createdAt as Date).toISOString();
      lastPurchaseSupplier = last.supplier ?? null;
      lastPurchaseNote = last.note ?? null;
    } else if (baseCost > 0) {
      // Fallback: if there are no valid purchases yet but the product
      // has a positive cost set, surface that as the last unit cost
      lastPurchaseCost = baseCost;
    }

    return {
      id: p.id,
      name: p.name,
      price: Number(p.price),
      cost: baseCost,
      stock: p.stock,
      totalValue: Number(p.price) * p.stock,
      lastPurchaseCost,
      lastPurchaseDate,
      lastPurchaseSupplier,
      lastPurchaseNote,
      avgPurchaseCost,
    };
  });
  return Response.json({ rows });
}
