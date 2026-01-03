import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";

export async function GET() {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !user?.id) {
    return NextResponse.json({ items: [] });
  }

  const items = await prisma.savedCartItem.findMany({
    where: { userId: user.id },
    include: {
      product: { select: { id: true, name: true, imageUrl: true, price: true } },
    },
    orderBy: { updatedAt: "desc" },
  });

  return NextResponse.json({
    items: items.map((it) => ({
      id: it.id,
      quantity: it.quantity,
      updatedAt: it.updatedAt,
      product: {
        id: it.product.id,
        name: it.product.name,
        imageUrl: it.product.imageUrl,
        price: Number(it.product.price),
      },
    })),
  });
}

export async function POST(request: Request) {
  if (!assertSameOrigin(request)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const productId = String(body?.productId || "");
  const quantity = Math.max(1, Math.min(100, Number(body?.quantity || 1)));

  if (!productId) {
    return NextResponse.json({ error: "Product ID is required" }, { status: 400 });
  }

  await prisma.savedCartItem.upsert({
    where: { userId_productId: { userId: user.id, productId } },
    update: { quantity },
    create: { userId: user.id, productId, quantity },
  });

  return NextResponse.json({ success: true });
}

export async function DELETE(request: Request) {
  if (!assertSameOrigin(request)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || !user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const productId = String(body?.productId || "");
  if (!productId) {
    return NextResponse.json({ error: "Product ID is required" }, { status: 400 });
  }

  await prisma.savedCartItem.deleteMany({
    where: { userId: user.id, productId },
  });

  return NextResponse.json({ success: true });
}
