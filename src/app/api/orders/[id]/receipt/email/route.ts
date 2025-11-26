import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { z } from "zod";

const schema = z.object({ to: z.string().email().optional() });

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = await req.json().catch(() => ({}));
    const parsed = schema.safeParse(body);

    const order = await prisma.order.findUnique({
      where: { id: params.id },
      include: { items: { include: { product: true } }, user: { select: { email: true, name: true } } },
    });
    if (!order) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const user = session.user as AuthenticatedUser;
    const isAdmin = user.role === "ADMIN";
    const isOwner = order.userId ? order.userId === user.id : false;
    if (!isAdmin && !isOwner) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const to =
      (parsed.success && parsed.data.to) ||
      order.user?.email ||
      user.email ||
      "";
    if (!to) return NextResponse.json({ error: "No email available" }, { status: 400 });

    const total = Number(order.total || 0);
    const paid = Number(order.amountPaid || 0);
    const balance = Math.max(0, total - paid);

    const rows = (order.items || [])
      .map((i) => `<tr><td>${i.product?.name || "Item"}</td><td align="right">${i.quantity}</td><td align="right">${Number(i.price).toFixed(2)}</td><td align="right">${(Number(i.price) * i.quantity).toFixed(2)}</td></tr>`) 
      .join("");
    const html = `
      <div style="font-family: system-ui, sans-serif; line-height: 1.4;">
        <h2>Nora Hospital Supplies — Receipt</h2>
        <p>Order <strong>#${order.id}</strong></p>
        <p>Date: ${order.createdAt.toISOString()}</p>
        <table width="100%" cellspacing="0" cellpadding="6" style="border-top:1px solid #ddd;border-bottom:1px solid #ddd;">
          <thead>
            <tr><th align="left">Item</th><th align="right">Qty</th><th align="right">Price</th><th align="right">Total</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="text-align:right;">
          Subtotal: <strong>${total.toFixed(2)}</strong><br/>
          Paid: <strong>${paid.toFixed(2)}</strong><br/>
          Balance: <strong>${balance.toFixed(2)}</strong>
        </p>
      </div>`;

    const res = await sendEmail(
      to,
      `Receipt for Order ${order.id}`,
      `Order ${order.id} total ${total.toFixed(2)}`,
      html,
    );
    if (!res.ok)
      return NextResponse.json(
        { error: res.error || "Email failed" },
        { status: 502 },
      );
    return NextResponse.json({
      ok: true,
      simulated: (res as { simulated?: boolean }).simulated === true,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
