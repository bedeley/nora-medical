import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions, type AuthenticatedUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { recomputeOrderTotalsFromPayments } from "@/lib/payments";

type TxClient = Parameters<typeof prisma.$transaction>[0] extends (arg: infer A) => unknown ? A : never;

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as AuthenticatedUser | undefined;
  if (!session || user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const orderIds = Array.isArray(body?.orderIds)
    ? body.orderIds.map((id: unknown) => String(id)).filter(Boolean)
    : [];

  if (!orderIds.length) {
    return NextResponse.json({ error: "No orderIds provided" }, { status: 400 });
  }

  const result = await prisma.$transaction(async (tx: TxClient) => {
    const updates = [];
    for (const orderId of orderIds) {
      try {
        const updated = await recomputeOrderTotalsFromPayments(tx, orderId);
        updates.push({ orderId, ok: true, status: updated.status });
      } catch (e: unknown) {
        updates.push({ orderId, ok: false, error: e instanceof Error ? e.message : "Failed" });
      }
    }
    return updates;
  });

  return NextResponse.json({ ok: true, updates: result });
}
