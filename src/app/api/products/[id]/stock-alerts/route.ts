import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/origin";
import { z } from "zod";

const schema = z.object({
  email: z.string().email().optional(),
  phone: z.string().min(7).optional(),
});

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> | { id: string } },
) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;

  try {
    const params = await context.params;
    const productId = params.id;
    const body = await req.json().catch(() => ({}));
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }

    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, stock: true },
    });
    if (!product) return NextResponse.json({ error: "Product not found" }, { status: 404 });
    if (Number(product.stock || 0) > 0) {
      return NextResponse.json({ error: "Product is in stock" }, { status: 400 });
    }

    let email = (parsed.data.email || "").trim();
    let phone = (parsed.data.phone || "").trim();
    const userId = user?.id || undefined;
    if (userId && (!email || !phone)) {
      const dbUser = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, phone: true },
      });
      if (!email) email = (dbUser?.email || "").trim();
      if (!phone) phone = (dbUser?.phone || "").trim();
    }

    if (!email && !phone) {
      return NextResponse.json(
        { error: "Provide an email or phone number for notifications" },
        { status: 400 },
      );
    }

    const emailValue = email || null;
    const phoneValue = phone || null;

    const orFilters: Array<{ userId?: string; email?: string; phone?: string }> = [];
    if (userId) orFilters.push({ userId });
    if (emailValue) orFilters.push({ email: emailValue });
    if (phoneValue) orFilters.push({ phone: phoneValue });

    const existing = await prisma.stockAlert.findFirst({
      where: {
        productId,
        OR: orFilters,
      },
    });

    if (existing) {
      await prisma.stockAlert.update({
        where: { id: existing.id },
        data: {
          userId: userId ?? existing.userId,
          email: emailValue ?? existing.email,
          phone: phoneValue ?? existing.phone,
          notifiedAt: null,
        },
      });
      return NextResponse.json({ ok: true, status: "updated" });
    }

    const softDeleted = await prisma.stockAlert.findFirst({
      where: {
        productId,
        OR: orFilters,
        deletedAt: { not: null },
      },
    });

    if (softDeleted) {
      await prisma.stockAlert.update({
        where: { id: softDeleted.id },
        data: {
          userId,
          email: emailValue,
          phone: phoneValue,
          notifiedAt: null,
          deletedAt: null,
        },
      });
      return NextResponse.json({ ok: true, status: "restored" });
    }

    await prisma.stockAlert.create({
      data: {
        productId,
        userId,
        email: emailValue,
        phone: phoneValue,
      },
    });

    return NextResponse.json({ ok: true, status: "created" });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed to subscribe";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
