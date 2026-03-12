import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rate-limit";
import { assertSameOrigin } from "@/lib/origin";

function num(v: unknown) {
  return Number(v || 0);
}

export async function POST(req: Request) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limited = await rateLimit(req, "admin-health-backfill-stock", 60_000, 10);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const products = await prisma.product.findMany({
    select: { id: true, stock: true, deletedAt: true },
  });
  const movements = await prisma.inventoryMovement.groupBy({
    by: ["productId"],
    _sum: { delta: true },
  });
  const movementMap = new Map(movements.map((m) => [m.productId, num(m._sum.delta)]));

  const toCreate = products
    .filter((p) => !p.deletedAt)
    .map((p) => {
      const delta = num(p.stock) - (movementMap.get(p.id) ?? 0);
      return { productId: p.id, delta };
    })
    .filter((row) => row.delta !== 0)
    .map((row) => ({
      productId: row.productId,
      delta: row.delta,
      reason: "STOCK_BACKFILL",
      createdAt: new Date(),
    }));

  if (toCreate.length === 0) {
    return NextResponse.json({ created: 0 });
  }

  await prisma.inventoryMovement.createMany({ data: toCreate });
  return NextResponse.json({ created: toCreate.length });
}
