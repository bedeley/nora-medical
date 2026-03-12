import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rate-limit";
import { assertSameOrigin } from "@/lib/origin";

export async function POST(req: Request) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ error: "Bad origin" }, { status: 403 });
  }
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limited = await rateLimit(req, "admin-health-link-payment", 60_000, 30);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const body = await req.json().catch(() => null);
  if (!body?.paymentId || !body?.orderId) {
    return NextResponse.json({ error: "Missing paymentId or orderId" }, { status: 400 });
  }

  const paymentId = String(body.paymentId);
  const orderId = String(body.orderId);

  const payment = await prisma.payment.update({
    where: { id: paymentId },
    data: { orderId },
    select: { id: true, orderId: true },
  });

  return NextResponse.json({ ok: true, payment });
}
