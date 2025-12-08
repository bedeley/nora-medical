import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/origin";
import { recordAuditLog } from "@/lib/audit-log";
import { notifyOrderEvent, notifyPaymentEvent } from "@/lib/notifications";

type TxClient = Parameters<typeof prisma.$transaction>[0] extends (arg: infer A) => unknown ? A : never;

const createSchema = z.object({
  userId: z.string().min(1),
  items: z
    .array(
      z.object({
        productId: z.string().min(1),
        quantity: z.number().int().positive(),
      })
    )
    .min(1, "At least one item required"),
  initialPayment: z.number().min(0).optional(),
  note: z.string().max(200).optional(),
  deliveryStatus: z
    .enum(["NOT_DELIVERED", "PARTIALLY_DELIVERED", "DELIVERED", "RETURNED"])
    .optional(),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  const role = user?.role;
  const isAdmin = role === "ADMIN";
  const isStaff = role === "STAFF";
  if (!session || (!isAdmin && !isStaff)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }

  try {
    const body = await req.json();
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid payload", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { userId, items, initialPayment = 0, note, deliveryStatus } = parsed.data;

    // Validate user exists and has optional phone
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Fetch products and validate quantities/availability
    const productIds = [...new Set(items.map((i) => i.productId))];
    const products = await prisma.product.findMany({
      where: { id: { in: productIds } },
    });
    type ProductLookup = {
      id: string;
      price: unknown;
      cost: unknown;
      stock: number;
      name: string;
      archived: boolean;
    };
    const productMap = new Map<string, ProductLookup>(
      products.map((p: ProductLookup) => [p.id, p as unknown as ProductLookup])
    );

    for (const it of items) {
      const p = productMap.get(it.productId);
      if (!p) {
        return NextResponse.json({ error: `Product not found: ${it.productId}` }, { status: 400 });
      }
      if (p.archived) {
        return NextResponse.json({ error: `Product archived: ${p.name}` }, { status: 400 });
      }
      if (p.stock < it.quantity) {
        return NextResponse.json(
          { error: `Insufficient stock for ${p.name}. In stock: ${p.stock}` },
          { status: 400 }
        );
      }
    }

    const total = items.reduce(
      (sum: number, it: { productId: string; quantity: number }) => {
        const p = productMap.get(it.productId)!;
        return sum + Number(p.price) * it.quantity;
      },
      0
    );

    const amountPaid = Math.min(initialPayment, total);
    const balance = Math.max(0, total - amountPaid);
    const status = amountPaid <= 0 ? "UNPAID" : balance <= 0 ? "PAID" : "PARTIALLY_PAID";

    const order = await prisma.$transaction(async (tx: TxClient) => {
      const created = await tx.order.create({
        data: {
          userId,
          total,
          amountPaid,
          balance,
          status,
          ...(deliveryStatus
            ? {
                deliveryStatus,
                deliveredAt: deliveryStatus === "DELIVERED" ? new Date() : null,
              }
            : {}),
        },
      });

      // Create items snapshot and decrement stock + inventory movement
      for (const it of items) {
        const p = productMap.get(it.productId)!;
        await tx.orderItem.create({
          data: {
            orderId: created.id,
            productId: p.id,
            price: Number(p.price),
            costAtSale: Number(p.cost ?? 0),
            quantity: it.quantity,
          },
        });
        await tx.product.update({
          where: { id: p.id },
          data: { stock: { decrement: it.quantity } },
        });
        await tx.inventoryMovement.create({
          data: { productId: p.id, delta: -it.quantity, reason: "SALE" },
        });
      }

      if (amountPaid > 0) {
        const meta = {
          method: "cash" as const,
          reference: "ADMIN_ORDER_INITIAL" as const,
          location: "admin/orders/new",
          note: note || "Admin initial payment",
        };
        await tx.payment.create({
          data: {
            userId,
            orderId: created.id,
            amount: amountPaid,
            note: JSON.stringify(meta),
          },
        });
      }

      return created;
    });

    // Customer-facing notifications
    try {
      await notifyOrderEvent({
        kind: "order_created",
        userId,
        orderId: order.id,
        total,
        amountPaid,
      });
      if (amountPaid > 0) {
        await notifyPaymentEvent({
          kind: "payment_recorded",
          userId,
          amount: amountPaid,
        });
      }
    } catch (e) {
      console.warn("admin orders notifications error:", e);
    }

    // Audit log: admin-created order (and optional initial payment)
    try {
      await recordAuditLog({
        actorId: user.id,
        action: "ORDER_CREATE_ADMIN",
        entityType: "ORDER",
        entityId: order.id,
        meta: {
          customerId: userId,
          total,
          amountPaid,
          balance,
          status,
        },
      });
    } catch {
      // best-effort
    }

    return NextResponse.json({
      success: true,
      orderId: order.id,
      total,
      amountPaid,
      balance,
      status,
    });
  } catch (err) {
    console.error("Admin create order error:", err);
    return NextResponse.json({ error: "Failed to create order" }, { status: 500 });
  }
}
